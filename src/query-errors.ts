import * as Schema from "effect/Schema"

/** SQL input failure omits parameter values so errors are safe to log. */
export class SqlInputError extends Schema.TaggedError<SqlInputError>()("SqlInputError", {
  source: Schema.String,
  field: Schema.String,
}) {
  /** A stable message names the parameter without exposing its value. */
  override get message(): string {
    return `Silt SQL input is invalid: ${this.field} (${this.source})`
  }
}

/** A database result did not match the type inferred from the schema. */
export class SqlResultError extends Schema.TaggedError<SqlResultError>()("SqlResultError", {
  source: Schema.String,
  field: Schema.String,
}) {
  /** A stable message identifies the result column without including row data. */
  override get message(): string {
    return `Silt SQL result is invalid: ${this.field} (${this.source})`
  }
}

/** Runtime row count checks defend the compiler's cardinality proof against schema drift. */
export class SqlCardinalityError extends Schema.TaggedError<SqlCardinalityError>()(
  "SqlCardinalityError",
  {
    source: Schema.String,
    expected: Schema.String,
    actual: Schema.Number,
  },
) {
  /** A stable message reports the row count without exposing query arguments. */
  override get message(): string {
    return `Silt SQL row count mismatch: expected ${this.expected}, received ${this.actual} (${this.source})`
  }
}
