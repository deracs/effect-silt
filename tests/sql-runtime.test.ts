import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Deferred from "effect/Deferred"
import * as Fiber from "effect/Fiber"
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import { SqlClient } from "effect/sql/SqlClient"
import * as Migrator from "effect/sql/Migrator"
import { migrations } from "../examples/migrations.ts"
import createUser from "../examples/queries/create-user.sql"
import createManyUsers from "../examples/queries/create-many-users.sql"
import createManyValues from "./queries/create-many-values.sql"
import createManyPayloads from "./queries/create-many-payloads.sql"
import createManyWithoutReturning from "./queries/create-many-without-returning.sql"
import findUser from "../examples/queries/find-user.sql"
import listUsers from "../examples/queries/list-users.sql"
import countUsers from "../examples/queries/count-users.sql"
import userPosts from "../examples/queries/user-posts.sql"
import renameUser from "../examples/queries/rename-user.sql"
import createPayload from "../examples/queries/create-payload.sql"
import prototypeColumn from "../examples/queries/prototype-column.sql"

const database = SqliteClient.layer({
  filename: ":memory:",
  transformResultNames: (name) => name.toUpperCase(),
})
const initializeDatabase = Effect.gen(function* () {
  yield* Migrator.make({})({ loader: migrations })
  return yield* SqlClient
})

it.effect("inserts variable-length batches through the same imported query", () =>
  Effect.gen(function* () {
    yield* initializeDatabase
    expect(yield* countUsers()).toEqual({ total: 0 })
    let inserted = 0
    for (const size of [1, 2, 5]) {
      const users = Array.from({ length: size }, (_, index) => ({
        name: `User ${inserted + index}: '); DROP TABLE users; -- ? :users[]`,
        email: null,
        password: "test-password",
      }))
      const pending = createManyUsers({ users })
      expect(yield* countUsers()).toEqual({ total: inserted })
      const rows = yield* pending
      expect(rows).toEqual(
        users.map((user, index) => ({ id: inserted + index + 1, name: user.name, email: null })),
      )
      inserted += size
    }
    expect(yield* countUsers()).toEqual({ total: 8 })
  }).pipe(Effect.provide(database)),
)

it.effect("returns empty batch results without a database statement", () =>
  Effect.gen(function* () {
    // This database has no tables, so any attempted INSERT fails.
    expect(yield* createManyUsers({ users: [] })).toEqual([])
    expect(yield* createManyWithoutReturning({ users: [] })).toBeUndefined()
  }).pipe(Effect.provide(database)),
)

it.effect.each([
  undefined,
  null,
  {},
  "secret input",
  [null],
  [undefined],
  [
    { name: "valid", email: null, password: "test-password" },
    { name: "invalid", email: null },
  ],
  [{ name: null, email: null, password: "test-password" }],
  [{ name: "invalid", password: "test-password" }],
])("validates the entire row array before a write: %j", (users) =>
  Effect.gen(function* () {
    yield* initializeDatabase
    // @ts-expect-error -- Untyped callers can supply malformed arrays and rows.
    const error = yield* createManyUsers({ users }).pipe(Effect.flip)
    expect(error._tag).toBe("SqlInputError")
    expect(String(error)).not.toContain("secret input")
    expect(yield* countUsers()).toEqual({ total: 0 })
  }).pipe(Effect.provide(database)),
)

it.effect("keeps a bulk INSERT atomic when a later row violates a constraint", () =>
  Effect.gen(function* () {
    yield* initializeDatabase
    const error = yield* createManyUsers({
      users: [
        { name: "first", email: "duplicate@example.com", password: "test-password" },
        { name: "second", email: "duplicate@example.com", password: "test-password" },
      ],
    }).pipe(Effect.flip)
    expect(error._tag).toBe("SqlError")
    expect(yield* countUsers()).toEqual({ total: 0 })
    expect(
      yield* createManyWithoutReturning({ users: [{ name: "Ada", password: "test-password" }] }),
    ).toBeUndefined()
    expect(yield* countUsers()).toEqual({ total: 1 })
  }).pipe(Effect.provide(database)),
)

it.effect("rolls back an imported bulk insert with its caller's transaction", () =>
  Effect.gen(function* () {
    const sql = yield* initializeDatabase
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* createManyUsers({
            users: [
              { name: "Ada", email: null, password: "test-password" },
              { name: "Grace", email: null, password: "test-password" },
            ],
          })
          return yield* Effect.fail("cancelled")
        }),
      )
      .pipe(Effect.flip)
    expect(yield* countUsers()).toEqual({ total: 0 })
  }).pipe(Effect.provide(database)),
)

it.effect("preserves row codecs, scalar binding order, and quoted parameter-like text", () =>
  Effect.gen(function* () {
    yield* initializeDatabase
    const users = [
      {
        name: "Ada",
        email: null,
        password: "test-password",
        active: true,
        external_id: 9007199254740993n,
      },
      { name: "Grace", email: null, password: "test-password", active: false, external_id: 0n },
    ]
    expect(yield* createManyValues({ users, label: "batch" })).toEqual(
      users.map((user, index) => ({
        id: index + 1,
        name: user.name,
        email: null,
        active: user.active,
        external_id: user.external_id,
        label: "batch",
        marker: "? :ignored[]",
      })),
    )
    const payloads = [
      { body: { nested: [true, null, "hello"] }, data: new Uint8Array([0, 255]) },
      { body: [1, "two"], data: new Uint8Array([]) },
    ]
    expect(yield* createManyPayloads({ payloads })).toEqual(
      payloads.map((payload, index) => ({ id: index + 1, body: payload.body, data: payload.data })),
    )
  }).pipe(Effect.provide(database)),
)

it.effect("runs imported queries lazily, decodes values, and supports parameterless queries", () =>
  Effect.gen(function* () {
    yield* initializeDatabase
    const insert = createUser({ name: "Ada", email: null, password: "test-password" })
    expect(yield* countUsers()).toEqual({ total: 0 })
    expect(yield* insert).toEqual([{ id: 1, name: "Ada", email: null }])
    expect(yield* findUser({ id: 1 })).toEqual(
      Option.some({ id: 1, name: "Ada", email: null, active: true, external_id: 0n }),
    )
    expect(yield* findUser({ id: 999 })).toEqual(Option.none())
    yield* renameUser({ id: 1, name: "Ada Lovelace" })
    expect(yield* listUsers()).toEqual([{ id: 1, name: "Ada Lovelace", email: null }])
  }).pipe(Effect.provide(database)),
)

it.effect("rolls back imported writes on a typed failure", () =>
  Effect.gen(function* () {
    const sql = yield* initializeDatabase
    const result = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* createUser({ name: "Ada", email: null, password: "test-password" })
          return yield* Effect.fail("cancelled" as const)
        }),
      )
      .pipe(Effect.flip)
    expect(result).toBe("cancelled")
    expect(yield* countUsers()).toEqual({ total: 0 })
  }).pipe(Effect.provide(database)),
)

it.effect("keeps nested transactions on their savepoint connection", () =>
  Effect.gen(function* () {
    const sql = yield* initializeDatabase
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* createUser({ name: "outer", email: null, password: "test-password" })
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* createUser({ name: "inner", email: null, password: "test-password" })
              return yield* Effect.fail("rollback inner")
            }),
          )
          .pipe(Effect.catch(() => Effect.void))
      }),
    )
    expect(yield* listUsers()).toEqual([{ id: 1, name: "outer", email: null }])
  }).pipe(Effect.provide(database)),
)

it.effect("rolls back an interrupted transaction and releases its connection", () =>
  Effect.gen(function* () {
    const sql = yield* initializeDatabase
    const inserted = yield* Deferred.make<void>()
    const fiber = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* createUser({ name: "interrupted", email: null, password: "test-password" })
          yield* Deferred.succeed(inserted, undefined)
          return yield* Effect.never
        }),
      )
      .pipe(Effect.forkChild)
    yield* Deferred.await(inserted)
    yield* Fiber.interrupt(fiber)
    expect(yield* countUsers()).toEqual({ total: 0 })
  }).pipe(Effect.provide(database)),
)

it.effect("preserves database constraint failures in the SqlError channel", () =>
  Effect.gen(function* () {
    const sql = yield* initializeDatabase
    yield* createUser({ name: "existing", email: "same@example.com", password: "test-password" })
    const error = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* createUser({ name: "rolled back", email: null, password: "test-password" })
          yield* createUser({
            name: "duplicate",
            email: "same@example.com",
            password: "test-password",
          })
        }),
      )
      .pipe(Effect.flip)
    expect(error._tag).toBe("SqlError")
    expect(yield* countUsers()).toEqual({ total: 1 })
  }).pipe(Effect.provide(database)),
)

it.effect("checks JavaScript callers before executing a statement", () =>
  Effect.gen(function* () {
    yield* initializeDatabase
    // @ts-expect-error -- Exercise invalid input from untyped JavaScript at the real query boundary.
    const error = yield* findUser({ id: "secret input" }).pipe(Effect.flip)
    expect(error._tag).toBe("SqlInputError")
    expect(String(error)).not.toContain("secret input")
  }).pipe(Effect.provide(database)),
)

it.effect("decodes nullable LEFT JOIN columns", () =>
  Effect.gen(function* () {
    const sql = yield* initializeDatabase
    yield* createUser({ name: "Ada", email: null, password: "test-password" })
    expect(yield* userPosts({ id: 1 })).toEqual([{ id: 1, name: "Ada", title: null }])
    yield* sql.unsafe("INSERT INTO posts (user_id, title) VALUES (?, ?)", [1, "Notes"])
    expect(yield* userPosts({ id: 1 })).toEqual([{ id: 1, name: "Ada", title: "Notes" }])
  }).pipe(Effect.provide(database)),
)

it.effect("preserves BIGINT precision and rejects invalid stored booleans", () =>
  Effect.gen(function* () {
    const sql = yield* initializeDatabase
    yield* sql.unsafe(
      "INSERT INTO users(name, external_id, password) VALUES (?, ?, 'test-password')",
      ["Ada", 9007199254740993n],
    )
    const user = yield* findUser({ id: 1 })
    expect(Option.getOrThrow(user).external_id).toBe(9007199254740993n)
    yield* sql.unsafe("UPDATE users SET active = 2 WHERE id = 1")
    const error = yield* findUser({ id: 1 }).pipe(Effect.flip)
    expect(error._tag).toBe("SqlResultError")
  }).pipe(Effect.provide(database)),
)

it.effect("detects cardinality drift when a runtime schema loses its unique constraint", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    yield* sql.unsafe(
      "CREATE TABLE users (id INTEGER, name TEXT, email TEXT, active BOOLEAN, external_id BIGINT)",
    )
    yield* sql.unsafe("INSERT INTO users VALUES (1, 'a', NULL, 1, 0), (1, 'b', NULL, 1, 0)")
    const error = yield* findUser({ id: 1 }).pipe(Effect.flip)
    expect(error._tag).toBe("SqlCardinalityError")
  }).pipe(Effect.provide(database)),
)

it.effect("round trips JSON and binary SQL parameters through the inferred codecs", () =>
  Effect.gen(function* () {
    yield* initializeDatabase
    const data = new Uint8Array([0, 1, 128, 255])
    const body = { title: "hello", tags: ["sql", "effect"], nested: { active: true }, count: null }
    expect(yield* createPayload({ body, data })).toEqual([{ id: 1, body, data }])
  }).pipe(Effect.provide(database)),
)

it.effect("rejects INTEGER results beyond the safe number range", () =>
  Effect.gen(function* () {
    const sql = yield* initializeDatabase
    yield* sql.unsafe("INSERT INTO users (id, name, password) VALUES (?, ?, 'test-password')", [
      9007199254740993n,
      "large integer",
    ])
    const error = yield* listUsers().pipe(Effect.flip)
    expect(error._tag).toBe("SqlResultError")
  }).pipe(Effect.provide(database)),
)

it.effect("preserves a SQL column named __proto__ as an own result property", () =>
  Effect.gen(function* () {
    const result = yield* prototypeColumn()
    expect(Object.hasOwn(result, "__proto__")).toBe(true)
    expect(result.__proto__).toBe(1)
  }).pipe(Effect.provide(database)),
)
