import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Deferred from "effect/Deferred"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as PlatformError from "effect/PlatformError"
import * as Schema from "effect/Schema"
import * as Migrator from "effect/sql/Migrator"
import { SqlClient } from "effect/sql/SqlClient"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import { runMigrationsWithSnapshot } from "./schema-snapshot.ts"
import { analyzeSqlQuery } from "./sql-analyzer.ts"
import { loadSqlModule } from "./sql-module.ts"
import { migrations as exampleMigrations } from "../examples/migrations.ts"

const database = Layer.mergeAll(
  NodeServices.layer,
  SqliteClient.layer({
    filename: ":memory:",
    transformResultNames: (name) => name.toUpperCase(),
  }),
)
const snapshotFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const sql = yield* SqlClient
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "silt-snapshot-test-" })
  const snapshotPath = path.join(directory, "schema.sql")
  return { fs, path, sql, directory, snapshotPath }
})
const migrations = Migrator.fromRecord({
  "0001_create_accounts": Effect.gen(function* () {
    const sql = yield* SqlClient
    yield* sql.unsafe(
      "CREATE TABLE accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT)",
    )
    yield* sql.unsafe("CREATE UNIQUE INDEX accounts_email ON accounts(email)")
    yield* sql.unsafe("CREATE TABLE audit (message TEXT NOT NULL DEFAULT 'a;b')")
    yield* sql.unsafe(
      "CREATE TRIGGER log_account AFTER INSERT ON accounts BEGIN INSERT INTO audit VALUES (NEW.name || ';audit'); END",
    )
    yield* sql.unsafe("CREATE VIEW account_names AS SELECT name FROM accounts")
    yield* sql.unsafe(
      "INSERT INTO accounts (name, email) VALUES ('private-seed-row', 'seed@example.test')",
    )
  }),
  "0002_add_nickname": Effect.gen(function* () {
    const sql = yield* SqlClient
    yield* sql.unsafe("ALTER TABLE accounts ADD COLUMN nickname TEXT")
  }),
})

it.effect(
  "derives final SQLite DDL from migrations and compiles SQL imports with unique keys intact",
  () =>
    Effect.gen(function* () {
      const { fs, path, directory, snapshotPath } = yield* snapshotFixture
      expect(yield* runMigrationsWithSnapshot({ loader: migrations, snapshotPath })).toEqual([
        [1, "create_accounts"],
        [2, "add_nickname"],
      ])
      const schema = yield* fs.readFileString(snapshotPath)
      expect(schema).toContain("CREATE UNIQUE INDEX accounts_email")
      expect(schema).toContain("CREATE TRIGGER log_account")
      expect(schema).toContain("CREATE VIEW account_names")
      expect(schema).toContain("'a;b'")
      expect(schema).not.toContain("private-seed-row")
      expect(schema).not.toContain("seed@example.test")
      expect(schema).not.toContain("effect_sql_migrations")
      expect(schema).not.toContain("CREATE TABLE sqlite_sequence")
      const query = "SELECT id, name, nickname FROM accounts WHERE email=:email"
      const definition = yield* analyzeSqlQuery({ schema, sql: query, source: "account.sql" })
      expect(definition.cardinality).toBe("maybeOne")
      expect(definition.columns).toEqual([
        { name: "id", kind: "integer", nullable: false },
        { name: "name", kind: "text", nullable: false },
        { name: "nickname", kind: "text", nullable: true },
      ])
      yield* fs.writeFileString(
        path.join(directory, "silt.config.json"),
        '{"dialect":"sqlite","schema":"schema.sql"}',
      )
      const queryPath = path.join(directory, "account.sql")
      yield* fs.writeFileString(queryPath, query)
      const compiled = yield* loadSqlModule(queryPath)
      expect(compiled.watchedFiles).toContain(snapshotPath)
      expect(compiled.code).toContain('"maybeOne"')
    }).pipe(Effect.scoped, Effect.provide(database)),
)

it.effect(
  "refreshes a missing or edited snapshot after no-op migrations with deterministic output",
  () =>
    Effect.gen(function* () {
      const { fs, snapshotPath } = yield* snapshotFixture
      const options = { loader: migrations, snapshotPath, table: "custom_history" }
      yield* runMigrationsWithSnapshot(options)
      const original = yield* fs.readFileString(snapshotPath)
      expect(original).not.toContain("custom_history")
      yield* fs.remove(snapshotPath)
      expect(yield* runMigrationsWithSnapshot(options)).toEqual([])
      expect(yield* fs.readFileString(snapshotPath)).toBe(original)
      yield* fs.writeFileString(snapshotPath, "stale snapshot")
      expect(yield* runMigrationsWithSnapshot(options)).toEqual([])
      expect(yield* fs.readFileString(snapshotPath)).toBe(original)
    }).pipe(Effect.scoped, Effect.provide(database)),
)

it.effect("creates a nested snapshot for an empty migration history", () =>
  Effect.gen(function* () {
    const { fs, path, directory } = yield* snapshotFixture
    const snapshotPath = path.join(directory, "generated", "schema.sql")
    expect(
      yield* runMigrationsWithSnapshot({ loader: Migrator.fromRecord({}), snapshotPath }),
    ).toEqual([])
    const schema = yield* fs.readFileString(snapshotPath)
    expect(schema).not.toContain("CREATE TABLE")
    const definition = yield* analyzeSqlQuery({
      schema,
      sql: "SELECT 1 AS value",
      source: "constant.sql",
    })
    expect(definition.cardinality).toBe("one")
    expect(definition.columns).toEqual([{ name: "value", kind: "integer", nullable: false }])
  }).pipe(Effect.scoped, Effect.provide(database)),
)

it.effect("rejects an outer transaction before it can export uncommitted schema", () =>
  Effect.gen(function* () {
    const { fs, sql, snapshotPath } = yield* snapshotFixture
    yield* fs.writeFileString(snapshotPath, "previous snapshot")
    const error = yield* sql
      .withTransaction(runMigrationsWithSnapshot({ loader: migrations, snapshotPath }))
      .pipe(Effect.flip)
    expect(error).toMatchObject({
      _tag: "SchemaSnapshotError",
      detail: "Run migration snapshots outside an existing transaction",
    })
    expect(yield* fs.readFileString(snapshotPath)).toBe("previous snapshot")
  }).pipe(Effect.scoped, Effect.provide(database)),
)

it.effect("returns migration failures without replacing the last valid snapshot", () =>
  Effect.gen(function* () {
    const { fs, sql, snapshotPath } = yield* snapshotFixture
    yield* runMigrationsWithSnapshot({ loader: migrations, snapshotPath })
    const original = yield* fs.readFileString(snapshotPath)
    const broken = Migrator.fromRecord({
      "0003_broken": Effect.gen(function* () {
        yield* sql.unsafe("ALTER TABLE accounts ADD COLUMN rolled_back TEXT")
        yield* sql.unsafe("INSERT INTO missing_table VALUES (1)")
      }),
    })
    const error = yield* runMigrationsWithSnapshot({ loader: broken, snapshotPath }).pipe(
      Effect.flip,
    )
    expect(error._tag).toBe("MigrationError")
    expect(yield* fs.readFileString(snapshotPath)).toBe(original)
    const columns = yield* sql.unsafe<{ name: string }>(
      "SELECT name FROM pragma_table_info('accounts')",
    ).withoutTransform
    expect(columns.map((column) => column.name)).not.toContain("rolled_back")
  }).pipe(Effect.scoped, Effect.provide(database)),
)

it.effect(
  "preserves the old snapshot on replacement failure and cleans its temporary directory",
  () =>
    Effect.gen(function* () {
      const { fs, directory, snapshotPath } = yield* snapshotFixture
      yield* fs.writeFileString(snapshotPath, "previous snapshot")
      const error = yield* runMigrationsWithSnapshot({ loader: migrations, snapshotPath }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          rename: () =>
            Effect.fail(
              PlatformError.badArgument({
                module: "FileSystem",
                method: "rename",
                description: "injected replacement failure",
              }),
            ),
        }),
        Effect.flip,
      )
      expect(error._tag).toBe("SchemaSnapshotError")
      expect(yield* fs.readFileString(snapshotPath)).toBe("previous snapshot")
      expect(yield* fs.readDirectory(directory)).toEqual(["schema.sql"])
      expect(yield* runMigrationsWithSnapshot({ loader: migrations, snapshotPath })).toEqual([])
      expect(yield* fs.readFileString(snapshotPath)).toContain("CREATE TABLE accounts")
    }).pipe(Effect.scoped, Effect.provide(database)),
)

it.effect("rejects virtual tables instead of exporting duplicate shadow-table DDL", () =>
  Effect.gen(function* () {
    const { fs, sql, snapshotPath } = yield* snapshotFixture
    yield* fs.writeFileString(snapshotPath, "previous snapshot")
    const loader = Migrator.fromRecord({
      "0001_virtual": sql
        .unsafe("CREATE VIRTUAL TABLE documents USING fts5(body)")
        .pipe(Effect.asVoid),
    })
    const error = yield* runMigrationsWithSnapshot({ loader, snapshotPath }).pipe(Effect.flip)
    expect(error._tag).toBe("SchemaSnapshotError")
    expect(yield* fs.readFileString(snapshotPath)).toBe("previous snapshot")
  }).pipe(Effect.scoped, Effect.provide(database)),
)

it.effect("rejects non-SQLite clients before migrations can run", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const onDialectOrElse: SqlClient["onDialectOrElse"] = (options) => options.orElse()
    const nonSqlite = new Proxy(sql, {
      get(target, name, receiver): unknown {
        return name === "onDialectOrElse" ? onDialectOrElse : Reflect.get(target, name, receiver)
      },
    })
    const loader = Effect.die("A non-SQLite client must not load migrations")
    const error = yield* runMigrationsWithSnapshot({ loader, snapshotPath: "schema.sql" }).pipe(
      Effect.provideService(SqlClient, nonSqlite),
      Effect.flip,
    )
    expect(error).toMatchObject({
      _tag: "SchemaSnapshotError",
      detail: "Only SQLite schema snapshots are supported",
    })
  }).pipe(Effect.provide(database)),
)

it.effect("keeps the checked-in example snapshot in sync with its runtime migrations", () =>
  Effect.gen(function* () {
    const { fs, path, snapshotPath } = yield* snapshotFixture
    yield* runMigrationsWithSnapshot({ loader: exampleMigrations, snapshotPath })
    const examplePath = yield* path.fromFileUrl(new URL("../examples/schema.sql", import.meta.url))
    expect(
      yield* fs.readFileString(examplePath),
      "Regenerate the example with pnpm schema:snapshot",
    ).toBe(yield* fs.readFileString(snapshotPath))
  }).pipe(Effect.scoped, Effect.provide(database)),
)

it.effect("cleans an interrupted export without replacing the old snapshot", () =>
  Effect.gen(function* () {
    const { fs, snapshotPath, directory } = yield* snapshotFixture
    yield* fs.writeFileString(snapshotPath, "previous snapshot")
    const writing = yield* Deferred.make<void>()
    const fiber = yield* runMigrationsWithSnapshot({ loader: migrations, snapshotPath }).pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        writeFileString: () =>
          Deferred.succeed(writing, undefined).pipe(Effect.andThen(Effect.never)),
      }),
      Effect.forkChild,
    )
    yield* Deferred.await(writing)
    yield* Fiber.interrupt(fiber)
    expect(yield* fs.readFileString(snapshotPath)).toBe("previous snapshot")
    expect(yield* fs.readDirectory(directory)).toEqual(["schema.sql"])
    expect(yield* runMigrationsWithSnapshot({ loader: migrations, snapshotPath })).toEqual([])
  }).pipe(Effect.scoped, Effect.provide(database)),
)

it.effect.prop(
  "snapshots preserve inferred scalar types, nullability, keys, and quoted defaults",
  [
    Schema.Struct({
      type: Schema.Literals(["INTEGER", "TEXT", "REAL", "BIGINT", "BOOLEAN", "JSON", "BLOB"]),
      nullable: Schema.Boolean,
      unique: Schema.Boolean,
      defaultValue: Schema.String,
    }),
  ],
  ([input]) =>
    Effect.gen(function* () {
      const { fs, sql, snapshotPath } = yield* snapshotFixture
      const quoted = input.defaultValue.replaceAll("'", "''").replaceAll("\u0000", "")
      const schema = `CREATE TABLE records (value ${input.type}${input.nullable ? "" : " NOT NULL"}${input.unique ? " UNIQUE" : ""} DEFAULT '${quoted}')`
      const loader = Migrator.fromRecord({ "0001_records": sql.unsafe(schema).pipe(Effect.asVoid) })
      yield* runMigrationsWithSnapshot({ loader, snapshotPath })
      const saved = yield* fs.readFileString(snapshotPath)
      const query = { sql: "SELECT value FROM records WHERE value=:value", source: "records.sql" }
      expect(yield* analyzeSqlQuery({ ...query, schema: saved })).toEqual(
        yield* analyzeSqlQuery({ ...query, schema }),
      )
    }).pipe(Effect.scoped, Effect.provide(database)),
  { arbitrary: { runs: 25 } },
)
