import * as Effect from "effect/Effect"
import * as Console from "effect/Console"
import * as Option from "effect/Option"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import { SqlClient } from "effect/sql/SqlClient"
import createUser from "./queries/create-user.sql"
import findUser from "./queries/find-user.sql"

const program = Effect.gen(function* () {
  const sql = yield* SqlClient
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const schemaPath = yield* path.fromFileUrl(new URL("./schema.sql", import.meta.url))
  const schema = yield* fs.readFileString(schemaPath)

  // Execute each schema statement through the same Effect SQL client.
  for (const statement of schema.split(";").filter((part) => part.trim())) {
    yield* sql.unsafe(statement)
  }

  yield* sql.withTransaction(
    Effect.gen(function* () {
      const created = yield* createUser({ name: "Ada", email: "ada@example.com" })
      const first = created[0]
      if (!first) return yield* Effect.die("The example insert returned no user")
      const user = yield* findUser({ id: first.id })

      yield* Console.log(Option.getOrNull(user))
    }),
  )
}).pipe(Effect.provide([SqliteClient.layer({ filename: ":memory:" }), NodeServices.layer]))

await Effect.runPromise(program)
