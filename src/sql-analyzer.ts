import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
// Raw statement metadata is required for inference; Effect's SQL client does not expose columns().
import { DatabaseSync } from "node:sqlite"
import parserPackage from "node-sql-parser"
import type { SqlCardinality, SqlField, SqlQueryDefinition } from "./query-contract.ts"
import { compileSqlBindings } from "./sql-bindings.ts"

type SqlNode = Record<string, unknown>
type FieldType = Omit<SqlField, "name">
type SourceTable = {
  readonly table: string
  readonly alias: string
  readonly nullable: boolean
  readonly fields: ReadonlyArray<SqlField>
  readonly keys: ReadonlyArray<ReadonlyArray<string>>
}

/** SQL analysis errors become diagnostics inside the imported .sql file. */
export class SqlAnalysisError extends Schema.TaggedError<SqlAnalysisError>()("SqlAnalysisError", {
  source: Schema.String,
  detail: Schema.String,
}) {
  /** A stable error prefix identifies failures from the SQL compiler. */
  override get message(): string {
    return `Silt SQL analysis failed: ${this.detail} (${this.source})`
  }
}

function nodeOf(value: unknown): SqlNode {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Unsupported SQL structure")
  // SAFETY: The object check above permits string-keyed reads; each field is still unknown.
  return value as SqlNode
}

function arrayOf(value: unknown): ReadonlyArray<unknown> {
  return Array.isArray(value) ? value : []
}
function textOf(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a SQL identifier")
  return value
}
function optionalNode(value: unknown): SqlNode | undefined {
  return value === null || value === undefined ? undefined : nodeOf(value)
}

function declaredKind(type: string): SqlField["kind"] {
  const upper = type.toUpperCase().trim()
  if (/^(BIGINT|INT8|UNSIGNED BIG INT)$/.test(upper)) return "bigint"
  if (/INT/.test(upper)) return "integer"
  if (/CHAR|CLOB|TEXT/.test(upper)) return "text"
  if (/REAL|FLOA|DOUB/.test(upper)) return "real"
  if (upper === "BLOB") return "bytes"
  if (/^BOOL(EAN)?$/.test(upper)) return "boolean"
  if (upper === "JSON") return "json"
  throw new Error(
    `Cannot infer SQLite type ${JSON.stringify(type)}; use INTEGER, BIGINT, REAL, TEXT, BLOB, BOOLEAN, or JSON`,
  )
}

function readTable(db: DatabaseSync, table: string, alias: string, nullable: boolean): SourceTable {
  const info = db
    .prepare('select name, type, "notnull" as required, pk, hidden from pragma_table_xinfo(?)')
    .all(table)
  if (info.length === 0) throw new Error(`Unknown table ${JSON.stringify(table)}`)
  const tableInfo = db
    .prepare("select wr, strict from pragma_table_list where name = ? and schema = ?")
    .get(table, "main")
  const primary = info
    .filter((column) => Number(column.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
  const indexes = db
    .prepare('select name, "unique" as is_unique, partial, origin from pragma_index_list(?)')
    .all(table)
  const hasPrimaryIndex = indexes.some((index) => index.origin === "pk")
  const fields = info
    .filter((column) => Number(column.hidden) !== 1)
    .map((column): SqlField => ({
      name: String(column.name),
      kind: declaredKind(String(column.type)),
      nullable: !(
        column.required === 1 ||
        (Number(column.pk) > 0 &&
          (tableInfo?.wr === 1 ||
            tableInfo?.strict === 1 ||
            (!hasPrimaryIndex &&
              primary.length === 1 &&
              String(column.type).toUpperCase() === "INTEGER")))
      ),
    }))
  const keys: Array<ReadonlyArray<string>> = primary.length
    ? [primary.map((column) => String(column.name))]
    : []
  for (const index of indexes) {
    if (index.is_unique !== 1 || index.partial !== 0) continue
    const columns = db
      .prepare("select name, cid from pragma_index_info(?) order by seqno")
      .all(String(index.name))
    if (columns.length && columns.every((column) => Number(column.cid) >= 0))
      keys.push(columns.map((column) => String(column.name)))
  }
  return { table, alias, nullable, fields, keys }
}

function analyzeStatement(db: DatabaseSync, sql: string, source: string): SqlQueryDefinition {
  const parser = new parserPackage.Parser()
  const compiled = compileSqlBindings(sql)
  const parsed: unknown = parser.astify(compiled.parserSql, { database: "Sqlite" })
  const statements = Array.isArray(parsed) ? parsed : [parsed]
  if (statements.length !== 1) throw new Error("Each SQL file must contain exactly one statement")
  const statement = nodeOf(statements[0])
  const type = textOf(statement.type)
  if (!["select", "insert", "update", "delete"].includes(type))
    throw new Error("Only SELECT, INSERT, UPDATE, and DELETE statements are supported")
  if (statement.with || statement._next || statement.set_op)
    throw new Error("CTEs and compound queries are not supported yet")
  const from = arrayOf(type === "select" ? statement.from : statement.table)
  const sources: SourceTable[] = []
  for (const item of from) {
    const relation = nodeOf(item)
    if (typeof relation.table !== "string" || relation.db)
      throw new Error("Subqueries and attached databases are not supported yet")
    const join = typeof relation.join === "string" ? relation.join.toUpperCase() : ""
    if (relation.using || join.includes("NATURAL"))
      throw new Error("Use an explicit JOIN ON condition instead of USING or NATURAL JOIN")
    if (join.includes("RIGHT") || join.includes("FULL")) {
      for (let i = 0; i < sources.length; i++) {
        const previous = sources[i]
        if (previous) sources[i] = { ...previous, nullable: true }
      }
    }
    sources.push(
      readTable(
        db,
        relation.table,
        typeof relation.as === "string" ? relation.as : relation.table,
        join.includes("LEFT") || join.includes("FULL"),
      ),
    )
  }

  const parameters = new Map<string, SqlField>()
  function resolveColumn(expr: SqlNode): SqlField {
    const name = textOf(expr.column)
    const matches = sources.flatMap((table) => {
      if (typeof expr.table === "string" && table.alias.toLowerCase() !== expr.table.toLowerCase())
        return []
      return table.fields
        .filter((field) => field.name.toLowerCase() === name.toLowerCase())
        .map((field) => ({ ...field, nullable: table.nullable || field.nullable }))
    })
    const field = matches[0]
    if (!field || matches.length !== 1)
      throw new Error(`Unknown or ambiguous column ${JSON.stringify(name)}`)
    return field
  }
  function bindParameter(name: string, expected: FieldType): FieldType {
    const previous = parameters.get(name)
    if (previous && previous.kind !== expected.kind)
      throw new Error(`Parameter :${name} has incompatible SQL types`)
    const field = {
      name,
      kind: expected.kind,
      nullable: previous ? previous.nullable && expected.nullable : expected.nullable,
    }
    parameters.set(name, field)
    return field
  }
  function inferExpression(value: unknown, expected?: FieldType): FieldType {
    const expr = nodeOf(value)
    switch (expr.type) {
      case "column_ref":
        return resolveColumn(expr)
      case "param": {
        const name = textOf(expr.value)
        if (expected) return bindParameter(name, expected)
        const field = parameters.get(name)
        if (field) return field
        throw new Error(
          `Cannot infer :${name}; compare it with a column or use CAST(:${name} AS TEXT)`,
        )
      }
      case "number":
        return { kind: Number.isInteger(expr.value) ? "integer" : "real", nullable: false }
      case "single_quote_string":
      case "string":
        return { kind: "text", nullable: false }
      case "bool":
      case "boolean":
        return { kind: "boolean", nullable: false }
      case "null":
        return { kind: "null", nullable: true }
      case "cast": {
        const target = nodeOf(arrayOf(expr.target)[0])
        const kind = declaredKind(textOf(target.dataType))
        const inner = inferExpression(expr.expr, { kind, nullable: true })
        return { kind, nullable: inner.nullable }
      }
      case "binary_expr": {
        const left = nodeOf(expr.left)
        const right = nodeOf(expr.right)
        const operator = textOf(expr.operator).toUpperCase()
        if (operator === "IN" || operator === "NOT IN") {
          const leftType = inferExpression(left)
          if (right.type !== "expr_list") throw new Error("IN subqueries are not supported yet")
          const rightTypes = arrayOf(right.value).map((item) => inferExpression(item, leftType))
          return {
            kind: "boolean",
            nullable: leftType.nullable || rightTypes.some((item) => item.nullable),
          }
        }
        const rightFirst = left.type === "param" && right.type !== "param"
        const first = inferExpression(rightFirst ? right : left, expected)
        const second = inferExpression(rightFirst ? left : right, first)
        if (
          [
            "=",
            "!=",
            "<>",
            "<",
            ">",
            "<=",
            ">=",
            "AND",
            "OR",
            "LIKE",
            "NOT LIKE",
            "IS",
            "IS NOT",
          ].includes(operator)
        ) {
          return {
            kind: "boolean",
            nullable:
              operator === "IS" || operator === "IS NOT"
                ? false
                : first.nullable || second.nullable,
          }
        }
        if (operator === "||") return { kind: "text", nullable: first.nullable || second.nullable }
        if (["+", "-", "*", "/", "%"].includes(operator)) {
          if (
            !["integer", "real"].includes(first.kind) ||
            !["integer", "real"].includes(second.kind)
          )
            throw new Error("Arithmetic requires INTEGER or REAL operands")
          return {
            kind: first.kind === "real" || second.kind === "real" ? "real" : "integer",
            nullable: first.nullable || second.nullable || operator === "/" || operator === "%",
          }
        }
        throw new Error(`Unsupported SQL operator ${operator}`)
      }
      case "unary_expr": {
        const inner = inferExpression(expr.expr, expected)
        return { ...inner, kind: expr.operator === "NOT" ? "boolean" : inner.kind }
      }
      case "aggr_func": {
        if (expr.over) throw new Error("Window functions are not supported yet")
        const name = textOf(expr.name).toUpperCase()
        const arg = nodeOf(expr.args)
        if (name === "COUNT") {
          if (nodeOf(arg.expr).type !== "star") inferExpression(arg.expr)
          return { kind: "integer", nullable: false }
        }
        const inner = inferExpression(arg.expr)
        if (name === "AVG" || name === "TOTAL") return { kind: "real", nullable: name !== "TOTAL" }
        if (name === "SUM" && !["integer", "real"].includes(inner.kind))
          throw new Error("SUM requires an INTEGER or REAL expression")
        if (["MIN", "MAX", "SUM"].includes(name)) return { ...inner, nullable: true }
        throw new Error(`Unsupported aggregate ${name}`)
      }
      case "function": {
        const nameNode = nodeOf(expr.name)
        const name = arrayOf(nameNode.name)
          .map((part) => textOf(nodeOf(part).value))
          .join(".")
          .toUpperCase()
        const arg = optionalNode(expr.args)
        const args = arrayOf(arg?.value)
        const inferred = args.map((item) => inferExpression(item, expected))
        if (name === "COALESCE" || name === "IFNULL") {
          const kinds = inferred.filter((item) => item.kind !== "null")
          const first = kinds[0]
          if (!first || kinds.some((item) => item.kind !== first.kind))
            throw new Error("COALESCE arguments must have one inferable SQL type")
          return { kind: first.kind, nullable: inferred.every((item) => item.nullable) }
        }
        const nullable = inferred.some((item) => item.nullable)
        if (["LOWER", "UPPER", "TRIM", "LTRIM", "RTRIM"].includes(name))
          return { kind: "text", nullable }
        if (name === "LENGTH") return { kind: "integer", nullable }
        if (name === "ABS" && inferred[0]) return inferred[0]
        throw new Error(`Unsupported SQL function ${name}`)
      }
      default:
        throw new Error(`Unsupported SQL expression ${String(expr.type)}`)
    }
  }

  if (type === "insert") {
    if (statement.on_duplicate_update || statement.prefix || statement.replace || statement.or)
      throw new Error("Conflict clauses and REPLACE are not supported yet")
    const target = sources[0]
    const values = optionalNode(statement.values)
    if (!target || values?.type !== "values" || !Array.isArray(statement.columns))
      throw new Error("INSERT requires explicit columns and VALUES")
    const columns = statement.columns.map((name: unknown) => {
      const field = target.fields.find(
        (field) => field.name.toLowerCase() === textOf(name).toLowerCase(),
      )
      if (!field) throw new Error(`Unknown INSERT column ${String(name)}`)
      return field
    })
    for (const row of arrayOf(values.values)) {
      const entries = arrayOf(nodeOf(row).value)
      if (entries.length !== columns.length)
        throw new Error("INSERT values do not match its columns")
      entries.forEach((entry, index) => inferExpression(entry, columns[index]))
    }
  }
  if (type === "update") {
    for (const item of arrayOf(statement.set)) {
      const assignment = nodeOf(item)
      const field = resolveColumn({ column: assignment.column, table: assignment.table })
      inferExpression(assignment.value, field)
    }
  }
  for (const item of from) {
    const on = nodeOf(item).on
    if (on) inferExpression(on)
  }
  if (statement.where) inferExpression(statement.where)
  if (statement.having) inferExpression(statement.having)
  const limit = optionalNode(statement.limit)
  for (const value of arrayOf(limit?.value))
    inferExpression(value, { kind: "integer", nullable: false })

  const returning = optionalNode(statement.returning)
  const output = type === "select" ? statement.columns : returning?.columns
  const outputExpressions: FieldType[] = []
  for (const column of arrayOf(output)) {
    const item = nodeOf(column)
    const expr = nodeOf(item.expr)
    if (expr.type === "column_ref" && expr.column === "*") {
      const matches = sources.filter(
        (table) =>
          typeof expr.table !== "string" || table.alias.toLowerCase() === expr.table.toLowerCase(),
      )
      if (!matches.length) throw new Error("Cannot resolve SELECT wildcard")
      for (const table of matches)
        for (const field of table.fields)
          outputExpressions.push({ ...field, nullable: table.nullable || field.nullable })
    } else outputExpressions.push(inferExpression(expr))
  }

  // Preparing catches real SQLite errors and reads result metadata; it never executes the query.
  const prepared = db.prepare(sql)
  const metadata = prepared.columns()
  if (metadata.length !== outputExpressions.length)
    throw new Error("Cannot match the statement's result columns to its inferred types")
  const columnNames = new Set<string>()
  const aggregate = arrayOf(output).some(
    (column) => nodeOf(nodeOf(column).expr).type === "aggr_func",
  )
  const columns = metadata.map((column, index): SqlField => {
    const field = outputExpressions[index]
    if (!field) throw new Error("Missing result column type")
    if (columnNames.has(column.name))
      throw new Error(
        `Duplicate result name ${JSON.stringify(column.name)}; give each column a distinct alias`,
      )
    columnNames.add(column.name)
    const expression = arrayOf(output)[index]
    const bareAggregateColumn =
      aggregate &&
      !statement.groupby &&
      expression &&
      nodeOf(nodeOf(expression).expr).type === "column_ref"
    return { ...field, nullable: field.nullable || Boolean(bareAggregateColumn), name: column.name }
  })
  for (const name of compiled.bindings)
    if (!parameters.has(name)) throw new Error(`Cannot infer parameter :${name}`)

  function equalityColumns(value: unknown): ReadonlySet<string> {
    const expr = optionalNode(value)
    if (!expr || expr.type !== "binary_expr") return new Set()
    if (expr.operator === "AND")
      return new Set([...equalityColumns(expr.left), ...equalityColumns(expr.right)])
    if (expr.operator !== "=") return new Set()
    const left = nodeOf(expr.left)
    const right = nodeOf(expr.right)
    const literalTypes = ["param", "number", "single_quote_string", "string", "bool", "boolean"]
    const column =
      left.type === "column_ref" && literalTypes.includes(String(right.type))
        ? left
        : right.type === "column_ref" && literalTypes.includes(String(left.type))
          ? right
          : undefined
    return new Set(column ? [textOf(column.column).toLowerCase()] : [])
  }
  let cardinality: SqlCardinality = columns.length ? "many" : "none"
  if (type === "select") {
    const limitValues = arrayOf(limit?.value)
    const count = optionalNode(limitValues[limit?.seperator === "," ? 1 : 0])
    const limitedToOne = count?.type === "number" && count.value === 1
    const first = sources[0]
    const equality = equalityColumns(statement.where)
    if (
      (sources.length === 0 || (aggregate && !statement.groupby)) &&
      !statement.where &&
      !statement.having &&
      !limit
    )
      cardinality = "one"
    else if (aggregate && !statement.groupby && !statement.having && !limit) cardinality = "one"
    else if (
      limitedToOne ||
      (sources.length === 1 &&
        first?.keys.some((key) => key.every((name) => equality.has(name.toLowerCase()))))
    )
      cardinality = "maybeOne"
  }
  return {
    sql: compiled.sql,
    source,
    bindings: compiled.bindings,
    parameters: [...parameters.values()],
    columns,
    cardinality,
  }
}

/** Analyze SQLite against a fresh schema snapshot; unsupported inference is a typed failure. */
export const analyzeSqlQuery = Effect.fn("Silt.analyzeSqlQuery")(function* (options: {
  readonly sql: string
  readonly schema: string
  readonly source: string
}) {
  return yield* Effect.try({
    try: () => {
      const db = new DatabaseSync(":memory:")
      try {
        db.exec(options.schema)
        return analyzeStatement(db, options.sql, options.source)
      } finally {
        db.close()
      }
    },
    catch: (cause) =>
      new SqlAnalysisError({
        source: options.source,
        detail: cause instanceof Error ? cause.message : "Unknown analysis failure",
      }),
  })
})
