import * as Effect from "effect/Effect"
import * as Path from "effect/Path"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import { runMigrationsWithSnapshot } from "effect-silt/migrations"
import { migrations } from "./migrations.ts"

const snapshot = Effect.gen(function* () {
  const path = yield* Path.Path
  const snapshotPath = yield* path.fromFileUrl(new URL("./schema.sql", import.meta.url))
  yield* runMigrationsWithSnapshot({ loader: migrations, snapshotPath })
}).pipe(Effect.provide([SqliteClient.layer({ filename: ":memory:" }), NodeServices.layer]))

await Effect.runPromise(snapshot)
