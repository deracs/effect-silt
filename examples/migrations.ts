import * as Effect from "effect/Effect"
import * as Migrator from "effect/sql/Migrator"
import { SqlClient } from "effect/sql/SqlClient"

/** The example runtime and saved schema snapshot share the same migration history. */
export const migrations = Migrator.fromRecord({
  "0001_create_users": Effect.gen(function* () {
    const sql = yield* SqlClient
    yield* sql.unsafe(`CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      password TEXT NOT NULL,
      email TEXT UNIQUE,
      active BOOLEAN NOT NULL DEFAULT 1,
      external_id BIGINT NOT NULL DEFAULT 0
    )`)
  }),
  "0002_create_posts_and_payloads": Effect.gen(function* () {
    const sql = yield* SqlClient
    yield* sql.unsafe(`CREATE TABLE posts (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      title TEXT NOT NULL
    )`)
    yield* sql.unsafe(`CREATE TABLE payloads (
      id INTEGER PRIMARY KEY,
      body JSON NOT NULL,
      data BLOB NOT NULL
    )`)
  }),
})
