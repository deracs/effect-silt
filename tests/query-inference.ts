import { expectTypeOf } from "vitest"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import type { SqlClient } from "effect/sql/SqlClient"
import type { SqlQueryError } from "effect-silt"
import * as Context from "effect/Context"
import type * as FileSystem from "effect/FileSystem"
import type * as Path from "effect/Path"
import type * as Migrator from "effect/sql/Migrator"
import type { SqlError } from "effect/sql/SqlError"
import { runMigrationsWithSnapshot, type SchemaSnapshotError } from "effect-silt/migrations"
import findUser from "../examples/queries/find-user.sql"
import createUser from "../examples/queries/create-user.sql"
import createManyUsers, {
  type Params as CreateManyUsersParams,
} from "../examples/queries/create-many-users.sql"
import createManyWithoutReturning from "./queries/create-many-without-returning.sql"
import listUsers from "../examples/queries/list-users.sql"
import countUsers from "../examples/queries/count-users.sql"
import userPosts from "../examples/queries/user-posts.sql"
import renameUser from "../examples/queries/rename-user.sql"

const found = findUser({ id: 1 })
expectTypeOf<Effect.Success<typeof found>>().toEqualTypeOf<
  Option.Option<{
    readonly id: number
    readonly name: string
    readonly email: string | null
    readonly active: boolean
    readonly external_id: bigint
  }>
>()
expectTypeOf<Effect.Services<typeof found>>().toEqualTypeOf<SqlClient>()
expectTypeOf<Effect.Error<typeof found>>().toEqualTypeOf<SqlQueryError>()
expectTypeOf<Effect.Success<ReturnType<typeof createUser>>>().toEqualTypeOf<
  ReadonlyArray<{ readonly id: number; readonly name: string; readonly email: string | null }>
>()
expectTypeOf<Effect.Success<ReturnType<typeof listUsers>>>().toEqualTypeOf<
  ReadonlyArray<{ readonly id: number; readonly name: string; readonly email: string | null }>
>()
expectTypeOf<Effect.Success<ReturnType<typeof countUsers>>>().toEqualTypeOf<{
  readonly total: number
}>()
expectTypeOf<Effect.Success<ReturnType<typeof userPosts>>>().toEqualTypeOf<
  ReadonlyArray<{ readonly id: number; readonly name: string; readonly title: string | null }>
>()
expectTypeOf<Effect.Success<ReturnType<typeof renameUser>>>().toEqualTypeOf<void>()
expectTypeOf<CreateManyUsersParams>().toEqualTypeOf<{
  readonly users: ReadonlyArray<{
    readonly name: string
    readonly email: string | null
    readonly password: string
  }>
}>()
const batch = createManyUsers({
  users: [{ name: "Ada", email: null, password: "test-password" }],
} as const)
createManyUsers({ users: [] })
expectTypeOf<Effect.Success<typeof batch>>().toEqualTypeOf<
  ReadonlyArray<{ readonly id: number; readonly name: string; readonly email: string | null }>
>()
expectTypeOf<Effect.Error<typeof batch>>().toEqualTypeOf<SqlQueryError>()
expectTypeOf<Effect.Services<typeof batch>>().toEqualTypeOf<SqlClient>()
expectTypeOf<Effect.Success<ReturnType<typeof createManyWithoutReturning>>>().toEqualTypeOf<void>()
// @ts-expect-error -- A row array is required.
createManyUsers()
// @ts-expect-error -- Every row requires the migrated password column.
createManyUsers({ users: [{ name: "Ada", email: null }] })
// @ts-expect-error -- Row fields retain their inferred scalar types.
createManyUsers({ users: [{ name: 1, email: null, password: "test-password" }] })
// @ts-expect-error -- Row arrays require records, not positional tuples.
createManyUsers({ users: [["Ada", null, "test-password"]] })

// @ts-expect-error -- SQL infers an INTEGER parameter, so strings must fail type checking.
findUser({ id: "1" })
// @ts-expect-error -- Queries with parameters cannot be called without them.
findUser()
// @ts-expect-error -- NOT NULL constrains the INSERT name parameter.
createUser({ name: null, email: null, password: "test-password" })
// @ts-expect-error -- Nullable values are accepted, but required SQL parameters cannot be omitted.
createUser({ name: "Ada", password: "test-password" })

// @ts-expect-error -- The migrated schema requires the password parameter.
createUser({ name: "Ada", email: null })

class SnapshotDependency extends Context.Service<SnapshotDependency, { readonly marker: true }>()(
  "test/SnapshotDependency",
) {}
declare const snapshotLoader: Migrator.Loader<SnapshotDependency>
const snapshot = runMigrationsWithSnapshot({ loader: snapshotLoader, snapshotPath: "schema.sql" })
expectTypeOf<Effect.Services<typeof snapshot>>().toEqualTypeOf<
  SqlClient | FileSystem.FileSystem | Path.Path | SnapshotDependency
>()
expectTypeOf<Effect.Error<typeof snapshot>>().toEqualTypeOf<
  Migrator.MigrationError | SqlError | SchemaSnapshotError
>()
