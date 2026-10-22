import * as Effect from "effect/Effect"
import * as Crypto from "effect/Crypto"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { analyzeSqlQuery } from "./sql-analyzer.ts"
import { loadSiltProject } from "./silt-project.ts"
import { emitSqlDeclaration } from "./sql-module.ts"

const openParams = Schema.Struct({ projectHandle: Schema.String, configFileName: Schema.String })
const transformParams = Schema.Struct({
  projectHandle: Schema.String,
  fileName: Schema.String,
  content: Schema.String,
})
const closeParams = Schema.Struct({ projectHandle: Schema.String })
const rpcMessage = Schema.Struct({
  id: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String, Schema.Null])),
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
})
const projects = new Map<string, string>()

class SiltMapperError extends Schema.TaggedError<
  SiltMapperError,
  { readonly brand: unique symbol }
>()("SiltMapperError", { detail: Schema.String }) {
  override get message(): string {
    return `Silt content mapper ${this.detail}`
  }
}

const transformSqlFile = Effect.fn("Silt.transformSqlFile")(function* (input: unknown) {
  const params = yield* Schema.decodeUnknownEffect(transformParams)(input)
  const path = yield* Path.Path
  const directory = projects.get(params.projectHandle) ?? path.dirname(params.fileName)
  return yield* Effect.gen(function* () {
    const project = yield* loadSiltProject(directory)
    if (params.fileName === project.schemaPath)
      return { extension: ".ts", text: "export {};", diagnostics: [], mappings: [] }
    const definition = yield* analyzeSqlQuery({
      sql: params.content,
      schema: project.schema,
      source: params.fileName,
    })
    const text = emitSqlDeclaration(definition)
    return {
      extension: ".ts",
      text,
      diagnostics: [],
      mappings: [
        [0, Buffer.byteLength(text), 0, Buffer.byteLength(params.content), 1, 8 | 16 | 32],
      ],
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        extension: ".ts",
        text: "declare const query: never; export default query;",
        diagnostics: [
          {
            messageText: error.message,
            start: 0,
            length: Math.max(1, Buffer.byteLength(params.content)),
            code: 1,
          },
        ],
        mappings: [],
      }),
    ),
  )
})

const handleRequest = Effect.fn("Silt.handleRequest")(function* (method: string, input: unknown) {
  switch (method) {
    case "initialize":
      return { protocolVersion: 1, positionEncoding: "utf-8", diagnosticSource: "silt" }
    case "openProject": {
      const params = yield* Schema.decodeUnknownEffect(openParams)(input)
      const path = yield* Path.Path
      const crypto = yield* Crypto.Crypto
      const directory = path.dirname(params.configFileName)
      projects.set(params.projectHandle, directory)
      return yield* loadSiltProject(directory).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.succeed({
              configIdentity: error.message,
              watchedFiles: [],
              optionDiagnostics: [],
            }),
          onSuccess: (project) =>
            Effect.map(
              crypto.digest(
                "SHA-256",
                new TextEncoder().encode(project.schemaPath + project.schema),
              ),
              (digest) => ({
                configIdentity: Buffer.from(digest).toString("hex"),
                watchedFiles: [project.configPath, project.schemaPath],
                optionDiagnostics: [],
              }),
            ),
        }),
      )
    }
    case "transform":
      return yield* transformSqlFile(input)
    case "closeProject": {
      const params = yield* Schema.decodeUnknownEffect(closeParams)(input)
      projects.delete(params.projectHandle)
      return {}
    }
    case "shutdown":
      return {}
    case "exit":
      process.exit(0)
    default:
      return yield* new SiltMapperError({ detail: `received an unknown method: ${method}` })
  }
})

const dispatchMessage = Effect.fn("Silt.dispatchMessage")(function* (body: string) {
  let id: string | number | null | undefined
  yield* Effect.gen(function* () {
    const message = yield* Schema.decodeEffect(Schema.fromJsonString(rpcMessage))(body)
    id = message.id
    const result = yield* handleRequest(message.method, message.params)
    if (id !== undefined) yield* sendMessage({ jsonrpc: "2.0", id, result })
  }).pipe(
    Effect.catch((cause) => {
      if (id !== undefined)
        return sendMessage({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32603,
            message: cause instanceof Error ? cause.message : "Silt content mapper failed",
          },
        })
      return Effect.void
    }),
  )
})

const sendMessage = Effect.fn("Silt.sendMessage")(function* (message: unknown) {
  const stdio = yield* Stdio.Stdio
  const body = Buffer.from(JSON.stringify(message))
  yield* Stream.make(`Content-Length: ${body.byteLength}\r\n\r\n`, body).pipe(
    Stream.run(stdio.stdout({ endOnDone: false })),
  )
})

// This entrypoint speaks TypeScript's JSON-RPC protocol. Diagnostics go to the response,
// never stdout, which is reserved for byte-framed messages.
const mapper = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  let pending = Buffer.alloc(0)
  yield* stdio.stdin.pipe(
    Stream.runForEach((chunk) =>
      Effect.gen(function* () {
        pending = Buffer.concat([pending, chunk])
        while (true) {
          const headerEnd = pending.indexOf("\r\n\r\n")
          if (headerEnd < 0) break
          const match = /Content-Length:\s*(\d+)/i.exec(
            pending.subarray(0, headerEnd).toString("ascii"),
          )
          const size = Number(match?.[1])
          if (!Number.isSafeInteger(size) || size < 0 || size > 16 * 1024 * 1024)
            return yield* new SiltMapperError({ detail: "received an invalid frame" })
          const start = headerEnd + 4
          if (pending.length < start + size) break
          const body = pending.subarray(start, start + size).toString("utf8")
          pending = pending.subarray(start + size)
          yield* dispatchMessage(body)
        }
      }),
    ),
  )
})

await Effect.runPromise(mapper.pipe(Effect.provide(NodeServices.layer)))
