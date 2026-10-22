import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { SqlClient, SafeIntegers } from "effect/sql/SqlClient"
import { SqlCardinalityError, SqlInputError, SqlResultError } from "./query-errors.ts"
import type {
  SqlCardinality,
  SqlField,
  SqlQuery,
  SqlQueryArguments,
  SqlQueryDefinition,
} from "./query-contract.ts"

const integerSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
)

function fieldSchema(field: SqlField): Schema.ConstraintDecoder<unknown> {
  const scalar = (() => {
    switch (field.kind) {
      case "integer":
        return integerSchema
      case "real":
        return Schema.Number
      case "text":
        return Schema.String
      case "bigint":
        return Schema.BigInt
      case "boolean":
        return Schema.Boolean
      case "bytes":
        return Schema.Uint8Array
      case "json":
        return Schema.Json
      case "null":
        return Schema.Null
    }
  })()
  return field.nullable ? Schema.NullOr(scalar) : scalar
}

function encodeSqlValue(field: SqlField, value: unknown): unknown {
  return field.kind === "boolean" && value !== null
    ? Number(value)
    : field.kind === "json" && value !== null
      ? JSON.stringify(value)
      : value
}

/** Build a query from compiler metadata; applications normally import a .sql file instead. */
export function defineSqlQuery<Params, Row, C extends SqlCardinality>(
  definition: SqlQueryDefinition & { readonly cardinality: C },
): SqlQuery<Params, Row, C> {
  const inputParsers = definition.parameters.map((field) =>
    field.kind === "rows"
      ? {
          kind: "rows" as const,
          field,
          parse: Schema.decodeUnknownEffect(
            Schema.Array(
              Schema.Struct(
                Object.fromEntries(
                  field.fields.map((column) => [column.name, fieldSchema(column)]),
                ),
              ),
            ),
          ),
        }
      : {
          kind: "scalar" as const,
          field,
          parse: Schema.decodeUnknownEffect(fieldSchema(field)),
        },
  )
  const outputParsers = definition.columns.map((field) => ({
    field,
    parse: Schema.decodeUnknownEffect(fieldSchema(field)),
  }))

  const executeQuery = Effect.fn("Silt.executeQuery")(function* (
    ...args: SqlQueryArguments<Params>
  ) {
    const input: unknown = args[0] === undefined ? {} : args[0]
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return yield* Effect.fail(
        new SqlInputError({ source: definition.source, field: "parameters" }),
      )
    }
    const values = new Map<string, ReadonlyArray<unknown>>()
    let statementSql = definition.sql
    let emptyBatch = false
    for (const parser of inputParsers) {
      const raw = Reflect.get(input, parser.field.name)
      const inputError = () =>
        new SqlInputError({ source: definition.source, field: parser.field.name })
      if (parser.kind === "rows") {
        const rows = yield* parser.parse(raw).pipe(Effect.mapError(inputError))
        const field = parser.field
        values.set(
          field.name,
          rows.flatMap((row) =>
            field.fields.map((column) => encodeSqlValue(column, row[column.name])),
          ),
        )
        emptyBatch = rows.length === 0
        const tuple = definition.sql.slice(field.start, field.end)
        statementSql =
          definition.sql.slice(0, field.start) +
          rows.map(() => tuple).join(", ") +
          definition.sql.slice(field.end)
      } else {
        const value = yield* parser.parse(raw).pipe(Effect.mapError(inputError))
        values.set(parser.field.name, [encodeSqlValue(parser.field, value)])
      }
    }
    if (emptyBatch) return definition.cardinality === "none" ? undefined : []
    const sqlClient = yield* SqlClient
    const rows = yield* sqlClient
      .unsafe<Record<string, unknown>>(
        statementSql,
        definition.bindings.flatMap((name) => values.get(name) ?? []),
      )
      .withoutTransform.pipe(Effect.provideService(SafeIntegers, true))
    if (
      (definition.cardinality === "one" && rows.length !== 1) ||
      (definition.cardinality === "maybeOne" && rows.length > 1)
    ) {
      return yield* Effect.fail(
        new SqlCardinalityError({
          source: definition.source,
          expected: definition.cardinality,
          actual: rows.length,
        }),
      )
    }
    if (definition.cardinality === "none") return undefined

    const decoded: Array<Record<string, unknown>> = []
    for (const row of rows) {
      const fields: Array<readonly [string, unknown]> = []
      for (const { field, parse } of outputParsers) {
        let raw = row[field.name]
        if (raw !== null) {
          if (
            field.kind === "integer" &&
            typeof raw === "bigint" &&
            raw >= BigInt(Number.MIN_SAFE_INTEGER) &&
            raw <= BigInt(Number.MAX_SAFE_INTEGER)
          )
            raw = Number(raw)
          if (field.kind === "boolean" && (raw === 0 || raw === 0n)) raw = false
          if (field.kind === "boolean" && (raw === 1 || raw === 1n)) raw = true
          if (field.kind === "json" && typeof raw === "string") {
            const jsonText = raw
            raw = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(jsonText).pipe(
              Effect.mapError(
                () => new SqlResultError({ source: definition.source, field: field.name }),
              ),
            )
          }
        }
        const value = yield* parse(raw).pipe(
          Effect.mapError(
            () => new SqlResultError({ source: definition.source, field: field.name }),
          ),
        )
        fields.push([field.name, value])
      }
      // Object.fromEntries defines an own property even for a column named __proto__.
      decoded.push(Object.fromEntries(fields))
    }
    if (definition.cardinality === "maybeOne") return Option.fromNullishOr(decoded[0])
    if (definition.cardinality === "one") return decoded[0]
    return decoded
  })

  // SAFETY: The compiler emits Params, Row, and C from this same field metadata. Each input
  // and output is parsed above; the cardinality guard covers the conditional result type.
  return Object.assign(executeQuery, {
    sql: definition.sql,
    cardinality: definition.cardinality,
  }) as SqlQuery<Params, Row, C>
}
