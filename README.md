# Silt

Import SQL files as typed Effect queries.

```sql
-- find-user.sql
SELECT id, name, email FROM users WHERE id = :id;
```

```ts
import * as Effect from "effect/Effect"
import findUser from "./find-user.sql"

const program = Effect.gen(function* () {
  const user = yield* findUser({ id: 1 })
  // Option<{ readonly id: number; readonly name: string; readonly email: string | null }>
  return user
})
```

Silt derives parameter types, result fields, nullability, and cardinality from SQL and a saved database schema.
The TypeScript content mapper supplies types for `.sql` imports and shows SQL errors in the source file.
Each query returns an Effect that uses the caller's `SqlClient`, transaction, scope, and trace context.

**Status:** early development, SQLite only. The repository is public and the npm package is unpublished.
The API and compiler requirements can change before the first npm release.

## What Silt provides

- Direct `.sql` imports with inferred parameter and result types.
- Editor hovers that show the inferred fields.
- Effect Schema decoders for query parameters and database results.
- Effect errors for SQL, input, result, and cardinality failures.
- A Node preload and a Vite plugin for runtime SQL imports.
- TypeScript declarations in memory, without generated declaration files on disk.

Silt supports Effect 4, Node.js 24 or later, and TypeScript 7.1 content mappers.
The repository pins a compiler nightly because TypeScript 7.0 does not provide content mappers.

## Try the project

Use Node.js 24 or later and the pnpm version from `package.json`.

```sh
git clone https://github.com/deracs/effect-silt.git
cd effect-silt
pnpm install --frozen-lockfile
pnpm verify
```

The verification command checks format, types, lint, runtime behavior, SQL inference, and the Node example.
The example creates an in-memory SQLite database and executes the queries in [`examples/`](./examples).

To execute the example again:

```sh
pnpm example
```

## Use Silt in another project

The package does not have a public npm release yet.
Use a local package archive until the first release.

### 1. Create and install the package archive

From the Silt repository:

```sh
pnpm pack
```

In the consumer project, install the archive and the Effect SQLite driver:

```sh
pnpm add /absolute/path/to/effect-silt/effect-silt-0.1.0.tgz effect@4.0.5 @effect/sql-sqlite-node@4.0.5
pnpm add -D typescript@7.1.0-dev.20261020.3
```

The archive filename includes the version from `package.json`.
The package contains compiled JavaScript and type declarations in `dist/`.
The consumer does not need Silt's development tools or its compiler patches.

### 2. Describe the database schema

Create `silt.config.json` beside the consumer's `package.json`:

```json
{ "dialect": "sqlite", "schema": "schema.sql" }
```

Create `schema.sql`:

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE
);
```

The schema path is relative to `silt.config.json`.
Silt searches parent directories for the nearest configuration file.
The analyzer uses a separate in-memory SQLite database for schema facts and statement preparation.
It does not execute the query statements during analysis.

The saved schema must describe the runtime database.
Your application owns database creation and migrations. Silt does not apply this schema to the runtime database.

### 3. Enable the TypeScript content mapper

Add the content mapper to `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true
  },
  "contentMappers": [{ "package": "effect-silt", "extensions": [".sql"] }]
}
```

Compile with permission to execute the content mapper:

```sh
pnpm exec tsc --noEmit --runExternalCode
```

The mapper executes local package code. Enable external code only for packages that you trust.
The mapper watches the configuration and saved schema files.
An invalid SQL column produces a diagnostic in the SQL file.
An invalid query argument produces a TypeScript error at the call site.

### 4. Import and execute a query

Create `find-user.sql`:

```sql
SELECT id, name, email FROM users WHERE id = :id;
```

Create `main.ts`:

```ts
import * as Effect from "effect/Effect"
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import findUser from "./find-user.sql"

const program = findUser({ id: 1 }).pipe(Effect.provide(SqliteClient.layer({ filename: "app.db" })))

const user = await Effect.runPromise(program)
// Option<{ readonly id: number; readonly name: string; readonly email: string | null }>
```

Create the tables in `app.db` through your application's database setup.
Then execute the program through the SQL preload:

```sh
node --import effect-silt/register main.ts
```

The preload installs an asynchronous Node loader that compiles SQL imports through Effect's filesystem and path services.

## Vite and Vitest

Add the Silt plugin to the Vite or Vitest configuration:

```ts
import { defineConfig } from "vite"
import silt from "effect-silt/vite"

export default defineConfig({ plugins: [silt()] })
```

The plugin compiles query modules and watches schema dependencies.
It shares the analyzer with the Node loader and TypeScript content mapper.
The plugin runs in Node.js. Silt does not provide a browser SQLite driver.

## Transactions

Execute imported queries inside the Effect transaction API:

```ts
import * as Effect from "effect/Effect"
import { SqlClient } from "effect/sql/SqlClient"
import createUser from "./create-user.sql"
import renameUser from "./rename-user.sql"

const transaction = Effect.gen(function* () {
  const sql = yield* SqlClient
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const rows = yield* createUser({ name: "Ada", email: null })
      const user = rows[0]
      if (user) yield* renameUser({ id: user.id, name: "Ada Lovelace" })
      return rows
    }),
  )
})
```

Provide the SQLite layer at the application entrypoint, as in the earlier example.
Silt executes each query in the caller's fiber.
Effect controls nested savepoints, rollback after failure, and rollback after interruption.

## Result types

| SQL statement                                                               | Result               |
| --------------------------------------------------------------------------- | -------------------- |
| Single-table lookup that constrains every column of a primary or unique key | `Option<Row>`        |
| `LIMIT 1`                                                                   | `Option<Row>`        |
| Aggregate without `GROUP BY`, `HAVING`, or a limit                          | `Row`                |
| Scalar select without a filter or limit                                     | `Row`                |
| Statement without result columns                                            | `void`               |
| Other statements, such as writes with `RETURNING`                           | `ReadonlyArray<Row>` |

Cardinality inference is conservative. A join can multiply rows, so a unique lookup with a join returns an array.
This also applies to grouped joins that Silt cannot prove produce a single row.
Nullable columns and outer joins retain `null` in their field types.
The runtime checks single-row cardinality against the actual result.

## SQL values and errors

| SQLite declaration                       | TypeScript representation |
| ---------------------------------------- | ------------------------- |
| `INTEGER` and other integer declarations | Safe integer `number`     |
| `BIGINT`, `INT8`, `UNSIGNED BIG INT`     | `bigint`                  |
| `REAL`, `FLOAT`, `DOUBLE`                | `number`                  |
| `TEXT`, `CHAR`, `CLOB`                   | `string`                  |
| `BOOLEAN`, `BOOL`                        | `boolean`                 |
| `BLOB`                                   | `Uint8Array`              |
| `JSON`                                   | `Schema.Json`             |

Silt requests exact integers from the Effect SQLite client.
The result decoder rejects an `INTEGER` outside the safe JavaScript range. Use `BIGINT` for those values.
The decoder also rejects invalid stored booleans, malformed JSON, and values that disagree with the inferred schema.

Queries expose these error types:

| Error                 | Meaning                                            |
| --------------------- | -------------------------------------------------- |
| `SqlError`            | The Effect driver reports a database failure.      |
| `SqlInputError`       | A parameter does not match its inferred codec.     |
| `SqlResultError`      | A result column does not match its inferred codec. |
| `SqlCardinalityError` | The row count violates a single-row proof.         |

Input and result errors identify the source and field. They omit parameter and row values.
Applications can use Effect Schema to decode result records into domain types.

## Supported SQL and limitations

Silt supports named parameters such as `:id`, repeated parameters, aliases, wildcards, joins with `ON`, and common scalar functions.
It also supports `INSERT ... VALUES`, `UPDATE`, `DELETE`, `RETURNING`, aggregates, and composite unique-key lookups.

Use one statement in each SQL file.
The analyzer reports unsupported expressions as SQL diagnostics. It does not substitute `any` for missing inference.

The current version does not support:

- PostgreSQL, MySQL, or PostgreSQL casts such as `::int`.
- CTEs, subqueries, compound queries, or window functions.
- Conflict clauses, `REPLACE`, `NATURAL JOIN`, or `JOIN ... USING`.
- Arbitrary SQL functions or inferred field types inside JSON values.
- Decimal or date codecs, untyped SQLite columns, or attached databases.
- A persistent analysis cache, incremental watch-mode tests, or SQL streams.

## Editor setup

SQL inference requires the TypeScript 7.1 native language server and permission to execute content mappers.
Older TypeScript servers cannot infer these imports.

### Zed

Install the **TypeScript Language Server** (`tsgo`) and **Oxc** extensions.
Open the repository root after `pnpm install` and `pnpm build`.

The [Zed settings](./.zed/settings.json) select the local compiler and enable external code for content mappers.
They also select the local Oxlint and Oxfmt servers.
Restart the TypeScript language server after a content mapper rebuild to refresh its process.

For a consumer project, adapt these settings to that project's local TypeScript binary.
Zed's default `vtsls` server cannot supply this inference.

### VS Code

Install the extensions in [the workspace recommendations](./.vscode/extensions.json).
The [workspace settings](./.vscode/settings.json) select the patched native language server and Oxc format support.
Effect diagnostics come from Oxlint. The language server provides Effect completions, hovers, and refactors.

## Development and contributions

Use the versions in `package.json` and `pnpm-lock.yaml` for reproducible development.
The install hook patches the native compiler and Oxlint through `@effect/tsgo`.
Keep the compiler, Oxlint, and `oxlint-tsgolint` versions compatible with that integration.

```sh
pnpm format
pnpm verify
pnpm pack --dry-run
```

The project uses native Effect services for platform operations.
[AGENTS.md](./AGENTS.md) describes the conventions and the few required Node-specific boundaries.
Oxlint enforces the direct-import restrictions and the recommended Effect rules.
Some Effect recommendations remain visible as warnings.

Oxlint's type engine cannot execute SQL content mappers.
The compiler checks SQL inference with `--runExternalCode`, with the negative type assertions in `tests/query-inference.ts`.

For a change, describe the behavior and include tests through the relevant public interface.
Use the SQLite, compiler, and runtime fixtures where possible.
Report bugs through [GitHub issues](https://github.com/deracs/effect-silt/issues).
Include the SQL, schema, compiler version, and expected result.

## Public release preparation

The project is not ready for a public npm release.
The package manifest currently sets `private: true` to prevent accidental publication.
[The release checklist](./docs/RELEASING.md) covers package metadata, archive checks, and the first npm release.

## License and acknowledgments

[MIT](./LICENSE) © Michael Goldsmith.

Reylo inspired the SQL import design. Silt has its own analyzer, compiler protocol, runtime decoder, and import hooks.
It does not depend on Reylo or its analysis engines.
The SQL parser dependency, `node-sql-parser`, uses Apache-2.0.
