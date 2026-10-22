import * as Effect from "effect/Effect"
import * as Path from "effect/Path"
import * as NodeServices from "@effect/platform-node/NodeServices"
import type { LoadHook } from "node:module"
import { loadSqlModule } from "./sql-module.ts"

/** Compile SQL imports in Node's asynchronous loader worker. */
export const load: LoadHook = async (url, context, nextLoad) => {
  if (!url.startsWith("file:") || !url.endsWith(".sql")) return nextLoad(url, context)
  const module = await Effect.runPromise(
    Effect.gen(function* () {
      const path = yield* Path.Path
      const filePath = yield* path.fromFileUrl(new URL(url))
      return yield* loadSqlModule(filePath)
    }).pipe(Effect.provide(NodeServices.layer)),
  )
  return { format: "module", source: module.code, shortCircuit: true }
}
