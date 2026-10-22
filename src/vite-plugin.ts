import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as NodeServices from "@effect/platform-node/NodeServices"
import type { Plugin } from "vite"
import { loadSqlModule } from "./sql-module.ts"

/** Compile .sql imports for Vite and Vitest, watching the schema for invalidation. */
export default function siltPlugin(): Plugin {
  return {
    name: "effect-silt",
    enforce: "pre",
    async resolveId(source, importer) {
      if (!source.endsWith(".sql") || !source.startsWith(".") || !importer) return null
      const from = importer.replace(/[?#].*$/, "")
      return Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          if (!path.isAbsolute(from)) return null
          const filePath = path.resolve(path.dirname(from), source)
          return (yield* fs.exists(filePath)) ? filePath : null
        }).pipe(Effect.provide(NodeServices.layer)),
      )
    },
    async load(id) {
      if (!id.endsWith(".sql")) return null
      const compiled = await Effect.runPromise(
        loadSqlModule(id).pipe(Effect.provide(NodeServices.layer)),
      )
      for (const path of compiled.watchedFiles) this.addWatchFile(path)
      return { code: compiled.code, map: null }
    },
  }
}
