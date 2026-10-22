import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { analyzeSqlQuery, type SqlAnalysisError } from "./sql-analyzer.ts"
import { SiltConfigError, loadSiltProject } from "./silt-project.ts"
import type { SqlField, SqlQueryDefinition } from "./query-contract.ts"

function typeOfField(field: SqlField): string {
  const type = {
    integer: "number",
    real: "number",
    text: "string",
    bigint: "bigint",
    boolean: "boolean",
    bytes: "Uint8Array",
    json: 'import("effect/Schema").Json',
    null: "null",
  }[field.kind]
  return field.nullable && type !== "null" ? `${type} | null` : type
}

function objectType(fields: ReadonlyArray<SqlField>): string {
  return fields.length
    ? `{ ${fields.map((field) => `readonly ${JSON.stringify(field.name)}: ${typeOfField(field)}`).join("; ")} }`
    : "Record<string, never>"
}

/** Emit a virtual TypeScript module whose callable query returns an Effect. */
export function emitSqlDeclaration(definition: SqlQueryDefinition): string {
  const params = objectType(definition.parameters)
  const row = objectType(definition.columns)
  return [
    'import type { SqlQuery } from "effect-silt";',
    `export type Params = ${params};`,
    `export type Row = ${row};`,
    `export declare const sql: ${JSON.stringify(definition.sql)};`,
    // Inline shapes let editor hovers show inferred fields while preserving the named type exports.
    `declare const query: SqlQuery<${params}, ${row}, ${JSON.stringify(definition.cardinality)}>;`,
    "export default query;",
    "",
  ].join("\n")
}

/** Compile a saved SQL file for Node or a bundler using the same analyzer as TypeScript. */
export const loadSqlModule = Effect.fn("Silt.loadSqlModule")(function* (
  filePath: string,
): Effect.fn.Return<
  { readonly code: string; readonly watchedFiles: ReadonlyArray<string> },
  SiltConfigError | SqlAnalysisError,
  FileSystem.FileSystem | Path.Path
> {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const project = yield* loadSiltProject(path.dirname(filePath))
  const sql = yield* fs
    .readFileString(filePath)
    .pipe(
      Effect.mapError(
        () => new SiltConfigError({ source: filePath, detail: "Cannot read SQL file" }),
      ),
    )
  const definition = yield* analyzeSqlQuery({ sql, schema: project.schema, source: filePath })
  return {
    code: `import { defineSqlQuery } from "effect-silt";\nexport const sql = ${JSON.stringify(definition.sql)};\nexport default defineSqlQuery(${JSON.stringify(definition)});\n`,
    watchedFiles: [project.configPath, project.schemaPath],
  }
})
