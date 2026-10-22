import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"

const projectSchema = Schema.fromJsonString(
  Schema.Struct({ dialect: Schema.Literal("sqlite"), schema: Schema.String }),
)

/** Silt configuration failures identify a file without hiding startup errors as defects. */
export class SiltConfigError extends Schema.TaggedError<SiltConfigError>()("SiltConfigError", {
  source: Schema.String,
  detail: Schema.String,
}) {
  /** A stable message tells the developer which project file needs attention. */
  override get message(): string {
    return `Silt project configuration failed: ${this.detail} (${this.source})`
  }
}

/** A schema snapshot is shared by type checking and the runtime build hook. */
export interface SiltProject {
  readonly configPath: string
  readonly schemaPath: string
  readonly schema: string
}

/** Resolve the nearest silt.config.json and read its saved schema from disk. */
export const loadSiltProject = Effect.fn("Silt.loadSiltProject")(function* (
  startDirectory: string,
): Effect.fn.Return<SiltProject, SiltConfigError, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  let directory = path.resolve(startDirectory)
  while (
    !(yield* fs
      .exists(path.join(directory, "silt.config.json"))
      .pipe(
        Effect.mapError(
          () => new SiltConfigError({ source: directory, detail: "Cannot find configuration" }),
        ),
      ))
  ) {
    const parent = path.dirname(directory)
    if (parent === directory)
      return yield* new SiltConfigError({
        source: startDirectory,
        detail: "Create silt.config.json with dialect and schema fields",
      })
    directory = parent
  }
  const configPath = path.join(directory, "silt.config.json")
  const json = yield* fs
    .readFileString(configPath)
    .pipe(
      Effect.mapError(
        () => new SiltConfigError({ source: configPath, detail: "Cannot read configuration" }),
      ),
    )
  const config = yield* Schema.decodeEffect(projectSchema)(json).pipe(
    Effect.mapError(
      () =>
        new SiltConfigError({
          source: configPath,
          detail: 'Expected { "dialect": "sqlite", "schema": "path/to/schema.sql" }',
        }),
    ),
  )
  const schemaPath = path.resolve(path.dirname(configPath), config.schema)
  const schema = yield* fs
    .readFileString(schemaPath)
    .pipe(
      Effect.mapError(
        () => new SiltConfigError({ source: schemaPath, detail: "Cannot read schema file" }),
      ),
    )
  return { configPath, schemaPath, schema }
})
