import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { loadSiltProject } from "./silt-project.ts"
import { loadSqlModule } from "./sql-module.ts"

const projectFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "silt-project-" })
  const configPath = path.join(directory, "silt.config.json")
  const schemaPath = path.join(directory, "schema.sql")
  const schema = "CREATE TABLE users (id INTEGER PRIMARY KEY);"
  yield* fs.writeFileString(configPath, '{"dialect":"sqlite","schema":"schema.sql"}')
  yield* fs.writeFileString(schemaPath, schema)
  return { fs, path, directory, configPath, schemaPath, schema }
})

it.effect("loads the nearest project from nested directories and resolves its schema", () =>
  Effect.gen(function* () {
    const { fs, path, directory, configPath, schemaPath, schema } = yield* projectFixture
    const nested = path.join(directory, "queries", "nested")
    yield* fs.makeDirectory(nested, { recursive: true })
    expect(yield* loadSiltProject(nested)).toEqual({ configPath, schemaPath, schema })

    const nestedConfig = path.join(nested, "silt.config.json")
    yield* fs.writeFileString(nestedConfig, '{"dialect":"sqlite","schema":"../../schema.sql"}')
    expect(yield* loadSiltProject(nested)).toEqual({ configPath: nestedConfig, schemaPath, schema })
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.effect("keeps invalid configuration and missing schema failures in the typed channel", () =>
  Effect.gen(function* () {
    const { fs, directory, configPath, schemaPath } = yield* projectFixture
    for (const config of ["{", '{"dialect":"postgres","schema":"schema.sql"}']) {
      yield* fs.writeFileString(configPath, config)
      expect(yield* loadSiltProject(directory).pipe(Effect.flip)).toMatchObject({
        _tag: "SiltConfigError",
        source: configPath,
        detail: 'Expected { "dialect": "sqlite", "schema": "path/to/schema.sql" }',
      })
    }
    yield* fs.writeFileString(configPath, '{"dialect":"sqlite","schema":"schema.sql"}')
    yield* fs.remove(schemaPath)
    expect(yield* loadSiltProject(directory).pipe(Effect.flip)).toMatchObject({
      _tag: "SiltConfigError",
      source: schemaPath,
      detail: "Cannot read schema file",
    })
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.effect("reports an unreadable configuration and a missing SQL file with their paths", () =>
  Effect.gen(function* () {
    const { fs, path, directory, configPath } = yield* projectFixture
    const sqlPath = path.join(directory, "missing.sql")
    expect(yield* loadSqlModule(sqlPath).pipe(Effect.flip)).toMatchObject({
      _tag: "SiltConfigError",
      source: sqlPath,
      detail: "Cannot read SQL file",
    })
    yield* fs.remove(configPath)
    yield* fs.makeDirectory(configPath)
    expect(yield* loadSiltProject(directory).pipe(Effect.flip)).toMatchObject({
      _tag: "SiltConfigError",
      source: configPath,
      detail: "Cannot read configuration",
    })
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.effect("stops configuration discovery at the filesystem root", () =>
  Effect.gen(function* () {
    expect(yield* loadSiltProject("/missing/project").pipe(Effect.flip)).toMatchObject({
      _tag: "SiltConfigError",
      source: "/missing/project",
      detail: "Create silt.config.json with dialect and schema fields",
    })
  }).pipe(
    Effect.provide([FileSystem.layerNoop({ exists: () => Effect.succeed(false) }), Path.layer]),
  ),
)
