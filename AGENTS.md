# Effect conventions

- Use native Effect APIs whenever the installed version provides the capability. Check the pinned package source before choosing an API.
- Use `effect/FileSystem`, `effect/Path`, `effect/Crypto`, `effect/Stdio`, and `effect/process` for filesystem, path, hashing, standard I/O, and child process operations, including tests and examples.
- Let service requirements propagate through application code. Provide Node implementations from `@effect/platform-node` at entrypoints, framework hooks, and test boundaries.
- Compose fallible operations with Effect and decode external data with Effect Schema. Preserve typed errors until a boundary renders diagnostics or a framework result.
- Use `Effect.runPromise` at asynchronous framework boundaries. Reserve `Effect.runSync` for effects proven to complete synchronously.
- Use `@effect/vitest` for Effect tests and scoped acquisition for temporary files and child processes.

## Platform boundaries

Node's module registration API in `src/register.ts` installs the asynchronous SQL loader; keep Node-specific loader mechanics there and in `src/sql-loader.ts`.

The analyzer in `src/sql-analyzer.ts` uses `node:sqlite` for statement preparation and `StatementSync.columns()` metadata without executing queries. Effect's SQL client does not expose that metadata. Keep this raw driver access inside the analyzer; application queries use Effect's `SqlClient`.

When an Effect equivalent cannot meet a platform contract, contain the direct platform API in its owning adapter and document the concrete reason beside the usage.
