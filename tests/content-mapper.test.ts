import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import * as NodeServices from "@effect/platform-node/NodeServices"

const compilerProject = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner
  const root = yield* path.fromFileUrl(new URL("..", import.meta.url))
  const directory = yield* fs.makeTempDirectoryScoped({ directory: root, prefix: ".silt-test-" })
  yield* fs.writeFileString(
    path.join(directory, "silt.config.json"),
    JSON.stringify({ dialect: "sqlite", schema: "schema.sql" }),
  )
  yield* fs.writeFileString(
    path.join(directory, "schema.sql"),
    "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
  )
  yield* fs.writeFileString(
    path.join(directory, "find.sql"),
    "SELECT id, name FROM users WHERE id=:id;",
  )
  yield* fs.writeFileString(
    path.join(directory, "main.ts"),
    'import find from "./find.sql"; find({ id: 1 });\n',
  )
  yield* fs.writeFileString(
    path.join(directory, "tsconfig.json"),
    JSON.stringify({ extends: "../tsconfig.json", include: ["main.ts"] }),
  )
  const typecheck = Effect.fn("Silt.Test.typecheck")(
    function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(
          process.execPath,
          [
            path.resolve(root, "node_modules/typescript/bin/tsc"),
            "--noEmit",
            "--runExternalCode",
            "-p",
            path.join(directory, "tsconfig.json"),
          ],
          { cwd: root },
        ),
      )
      const [status, output] = yield* Effect.all(
        [
          child.exitCode,
          child.all.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (text, chunk) => text + chunk,
            ),
          ),
        ],
        { concurrency: "unbounded" },
      )
      return { status, output }
    },
    Effect.scoped,
    Effect.timeout("15 seconds"),
  )
  return { directory, fs, path, typecheck }
})

it.live("runs the real TypeScript 7.1 content mapper and checks inferred caller types", () =>
  Effect.gen(function* () {
    const { directory, fs, path, typecheck } = yield* compilerProject
    const good = yield* typecheck()
    expect(good.output).toBe("")
    expect(good.status).toBe(0)
    yield* fs.writeFileString(
      path.join(directory, "main.ts"),
      'import find from "./find.sql"; find({ id: "wrong" });\n',
    )
    const bad = yield* typecheck()
    expect(bad.status).not.toBe(0)
    expect(bad.output).toContain("TS2322")
    expect(bad.output).toContain("number")
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.live("invalidates inference after a saved schema change and places diagnostics in SQL", () =>
  Effect.gen(function* () {
    const { directory, fs, path, typecheck } = yield* compilerProject
    expect((yield* typecheck()).status).toBe(0)
    yield* fs.writeFileString(
      path.join(directory, "schema.sql"),
      "CREATE TABLE users (id INTEGER PRIMARY KEY);",
    )
    const result = yield* typecheck()
    expect(result.status).not.toBe(0)
    expect(result.output).toContain("find.sql")
    expect(result.output).toContain("name")
    expect(result.output).toContain("silt")
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.live("reports missing project configuration through SQL diagnostics", () =>
  Effect.gen(function* () {
    const { directory, fs, path, typecheck } = yield* compilerProject
    yield* fs.writeFileString(
      path.join(directory, "silt.config.json"),
      '{"dialect":"sqlite","schema":"missing.sql"}',
    )
    const result = yield* typecheck()
    expect(result.status).not.toBe(0)
    expect(result.output).toContain("Cannot read schema file")
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)
