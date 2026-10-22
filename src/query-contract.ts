import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import type { SqlCardinalityError, SqlInputError, SqlResultError } from "./query-errors.ts"

/** SQLite values that Silt can infer and decode without losing integer precision. */
export const SqlScalarKind = Schema.Literals([
  "integer",
  "real",
  "text",
  "bigint",
  "boolean",
  "bytes",
  "json",
  "null",
])

/** A SQL field describes its database representation, before domain decoding. */
export const SqlField = Schema.Struct({
  name: Schema.String,
  kind: SqlScalarKind,
  nullable: Schema.Boolean,
})

/** Database field metadata shared by the compiler and the runtime decoder. */
export interface SqlField extends Schema.Schema.Type<typeof SqlField> {}

/** Cardinality is conservative: only a proof permits a single result. */
export const SqlCardinality = Schema.Literals(["many", "maybeOne", "one", "none"])

/** The result shape inferred from SQL, independent of runtime driver choice. */
export type SqlCardinality = Schema.Schema.Type<typeof SqlCardinality>

/** A compiled statement includes codecs and positional bindings, but no database connection. */
export const SqlQueryDefinition = Schema.Struct({
  sql: Schema.String,
  source: Schema.String,
  parameters: Schema.Array(SqlField),
  bindings: Schema.Array(Schema.String),
  columns: Schema.Array(SqlField),
  cardinality: SqlCardinality,
})

/** Serializable SQL analysis emitted by the content mapper and runtime loader. */
export interface SqlQueryDefinition extends Schema.Schema.Type<typeof SqlQueryDefinition> {}

/** Optional rows use Effect Option; an absent database row is an ordinary result. */
export type SqlQueryResult<Row, C extends SqlCardinality> = C extends "many"
  ? ReadonlyArray<Row>
  : C extends "maybeOne"
    ? Option.Option<Row>
    : C extends "one"
      ? Row
      : void

/** Parameters may be omitted only when the inferred query has no required parameters. */
export type SqlQueryArguments<Params> = {} extends Params ? [params?: Params] : [params: Params]

/** Every query keeps database, input, result decoding, and row count failures explicit. */
export type SqlQueryError = SqlError | SqlInputError | SqlResultError | SqlCardinalityError

/** An imported SQL query executes lazily in the caller's Effect SQL transaction. */
export interface SqlQuery<Params, Row, C extends SqlCardinality> {
  (
    ...params: SqlQueryArguments<Params>
  ): Effect.Effect<SqlQueryResult<Row, C>, SqlQueryError, SqlClient>
  readonly sql: string
  readonly cardinality: C
}
