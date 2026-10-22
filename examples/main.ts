import * as Effect from "effect/Effect"
import * as Console from "effect/Console"
import * as Option from "effect/Option"
import * as Migrator from "effect/sql/Migrator"
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import { SqlClient } from "effect/sql/SqlClient"
import { migrations } from "./migrations.ts"
import createUser from "./queries/create-user.sql"
import findUser from "./queries/find-user.sql"

const program = Effect.gen(function* () {
  yield* Migrator.make({})({ loader: migrations })
  const sql = yield* SqlClient

  yield* sql.withTransaction(
    Effect.gen(function* () {
      const created = yield* createUser({
        name: "Ada",
        email: "ada@example.com",
        password: "example-password",
      })
      const first = created[0]
      if (!first) return yield* Effect.die("The example insert returned no user")
      const user = Option.getOrNull(yield* findUser({ id: first.id }))

      yield* Console.log(user)
    }),
  )
}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })))

await Effect.runPromise(program)
