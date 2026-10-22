import { expect, it, prop } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { analyzeSqlQuery } from "./sql-analyzer.ts"
import { emitSqlDeclaration } from "./sql-module.ts"

const schema = `
CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE);
CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT NOT NULL);
CREATE TABLE composite (a INTEGER NOT NULL, b INTEGER NOT NULL, value TEXT, PRIMARY KEY(a,b));
CREATE TABLE nullable_pk (id TEXT PRIMARY KEY);
CREATE TABLE descending_pk (id INTEGER PRIMARY KEY DESC);
`
const analyze = (sql: string, overrideSchema = schema) =>
  analyzeSqlQuery({ sql, schema: overrideSchema, source: "test.sql" })

it.effect("infers row arrays from explicit INSERT columns and keeps hover fields inline", () =>
  Effect.gen(function* () {
    const definition = yield* analyze(
      'insert into users ("email", "name") values /* ? :ignored[] */ :users[] returning id, name, email;',
    )
    expect(definition.bindings).toEqual(["users"])
    expect(definition.parameters).toEqual([
      {
        name: "users",
        kind: "rows",
        start: definition.sql.indexOf("(?, ?)"),
        end: definition.sql.indexOf("(?, ?)") + 6,
        fields: [
          { name: "email", kind: "text", nullable: true },
          { name: "name", kind: "text", nullable: false },
        ],
      },
    ])
    expect(definition.cardinality).toBe("many")
    expect(definition.columns).toEqual([
      { name: "id", kind: "integer", nullable: false },
      { name: "name", kind: "text", nullable: false },
      { name: "email", kind: "text", nullable: true },
    ])
    expect(emitSqlDeclaration(definition)).toContain(
      'readonly "users": ReadonlyArray<{ readonly "email": string | null; readonly "name": string }>',
    )
  }),
)

it.effect.each([
  "SELECT id FROM users WHERE id IN (:ids[])",
  "UPDATE users SET name=:users[]",
  "INSERT INTO users VALUES :users[]",
  "INSERT INTO users (name) VALUES (:users[])",
  "INSERT INTO users (name) VALUES :users[], (:name)",
  "INSERT INTO users (name) VALUES (:name), :users[]",
  "INSERT INTO users (name) VALUES :users[], :other[]",
  "INSERT INTO users (name) VALUES :users[] RETURNING CAST(:users AS TEXT) AS value",
  "INSERT INTO users (name, name) VALUES :users[]",
  "INSERT INTO users (missing) VALUES :users[]",
])("reports unsupported row array positions as SQL diagnostics: %s", (sql) =>
  Effect.gen(function* () {
    const error = yield* analyze(sql).pipe(Effect.flip)
    expect(error._tag).toBe("SqlAnalysisError")
  }),
)

it.effect("proves a composite unique lookup only when every key has an equality constraint", () =>
  Effect.gen(function* () {
    expect((yield* analyze("SELECT value FROM composite WHERE a=:a AND b=:b")).cardinality).toBe(
      "maybeOne",
    )
    expect((yield* analyze("SELECT value FROM composite WHERE a=:a")).cardinality).toBe("many")
    expect((yield* analyze("SELECT id FROM users WHERE id=:id OR name=:name")).cardinality).toBe(
      "many",
    )
    expect((yield* analyze("SELECT id FROM users WHERE id=id")).cardinality).toBe("many")
  }),
)

it.effect("does not mistake an OFFSET of one for a LIMIT of one", () =>
  Effect.gen(function* () {
    expect((yield* analyze("SELECT id FROM users LIMIT 1,10")).cardinality).toBe("many")
    expect((yield* analyze("SELECT id FROM users LIMIT 10 OFFSET 1")).cardinality).toBe("many")
    expect((yield* analyze("SELECT id FROM users LIMIT 1 OFFSET 10")).cardinality).toBe("maybeOne")
  }),
)

it.effect("includes nullability of SQLite primary keys that are not rowid aliases", () =>
  Effect.gen(function* () {
    expect((yield* analyze("SELECT id FROM nullable_pk")).columns[0]?.nullable).toBe(true)
    expect((yield* analyze("SELECT id FROM descending_pk")).columns[0]?.nullable).toBe(true)
    expect((yield* analyze("SELECT id FROM users")).columns[0]?.nullable).toBe(false)
  }),
)

it.effect(
  "infers casts, repeated named bindings, scalar functions, and parameterless results",
  () =>
    Effect.gen(function* () {
      const cast = yield* analyze("SELECT CAST(:name AS TEXT) AS value")
      expect(cast.parameters).toEqual([{ name: "name", kind: "text", nullable: true }])
      expect(cast.cardinality).toBe("one")
      const repeated = yield* analyze("SELECT id FROM users WHERE name=:name OR email=:name")
      expect(repeated.bindings).toEqual(["name", "name"])
      expect(repeated.parameters).toEqual([{ name: "name", kind: "text", nullable: false }])
      expect((yield* analyze("SELECT UPPER(name) AS name FROM users")).columns).toEqual([
        { name: "name", kind: "text", nullable: false },
      ])
    }),
)

it.effect("does not execute analyzed INSERT or DELETE statements", () =>
  Effect.gen(function* () {
    // If analysis executed this INSERT, SQLite's CHECK constraint would fail.
    const ddl = "CREATE TABLE guarded (id INTEGER NOT NULL CHECK(id > 0));"
    expect((yield* analyze("INSERT INTO guarded (id) VALUES (-1)", ddl)).cardinality).toBe("none")
    expect((yield* analyze("DELETE FROM guarded WHERE id=:id", ddl)).parameters).toEqual([
      { name: "id", kind: "integer", nullable: false },
    ])
  }),
)

it.effect("keeps bare aggregate columns nullable when the source can be empty", () =>
  Effect.gen(function* () {
    const definition = yield* analyze("SELECT name, COUNT(*) AS total FROM users")
    expect(definition.cardinality).toBe("one")
    expect(definition.columns).toEqual([
      { name: "name", kind: "text", nullable: true },
      { name: "total", kind: "integer", nullable: false },
    ])
  }),
)

it.effect.each([
  "SELECT missing FROM users",
  "SELECT id AS same, name AS same FROM users",
  "SELECT :untyped AS value",
  "SELECT id FROM users WHERE id=:value AND name=:value",
  "WITH found AS (SELECT id FROM users) SELECT id FROM found",
  "SELECT id FROM users UNION ALL SELECT id FROM users",
  "SELECT ROW_NUMBER() OVER () AS position FROM users",
  "SELECT * FROM (SELECT id FROM users) AS nested",
  "SELECT random() AS value",
  "SELECT id FROM users WHERE id=?",
  "SELECT id FROM users; DELETE FROM users;",
  "INSERT OR IGNORE INTO users(name) VALUES (:name)",
])("reports unsupported or invalid SQL instead of widening its types: %s", (sql) =>
  Effect.gen(function* () {
    const error = yield* analyze(sql).pipe(Effect.flip)
    expect(error._tag).toBe("SqlAnalysisError")
  }),
)

prop(
  "parameter-like text inside string literals never becomes a binding",
  [Schema.String],
  ([input]) => {
    const quoted = input.replaceAll("'", "''").replaceAll("\u0000", "")
    const definition = Effect.runSync(
      analyze(`SELECT '${quoted}:ignored[] ? @also_ignored' AS value`),
    )
    expect(definition.bindings).toEqual([])
    expect(definition.parameters).toEqual([])
  },
)

prop(
  "row array expansion ignores arbitrary quoted text and preserves tuple offsets",
  [Schema.String],
  ([input]) => {
    const quoted = input.replaceAll("'", "''").replaceAll("\u0000", "")
    const definition = Effect.runSync(
      analyze(
        `INSERT INTO users (name) VALUES :users[] RETURNING '${quoted}:ignored[] ?' AS literal`,
      ),
    )
    const rows = definition.parameters[0]
    expect(rows?.kind).toBe("rows")
    if (rows?.kind !== "rows") throw new Error("Expected row array metadata")
    expect(definition.sql.slice(rows.start, rows.end)).toBe("(?)")
    expect(definition.bindings).toEqual(["users"])
    expect(definition.sql).toContain(`'${quoted}:ignored[] ?'`)
  },
)
