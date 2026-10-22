# Public release checklist

The repository is public. The npm package remains unpublished while development continues.
This document describes future release work. It does not schedule or authorize a release.

## Complete the release candidate

1. Review the supported SQL and limitations in the README.
2. Select the supported Node.js, Effect, TypeScript, and editor versions.
3. Replace nightly compiler requirements when a suitable stable compiler provides content mappers.
4. Confirm ownership and availability of the npm package name. Use an owned scope if the name is unavailable.
5. Update the package version, repository links, README install command, and release notes.
6. Remove `private: true` from `package.json` only when the npm release is ready.
7. Keep development dependencies separate from runtime and peer dependencies.

## Verify the package archive

Run these commands from a clean checkout:

```sh
pnpm install --frozen-lockfile
pnpm verify
pnpm pack --dry-run
pnpm pack
```

Inspect the archive contents:

```sh
tar -tzf effect-silt-0.1.0.tgz
```

Use the filename for the selected release version.
The archive must contain the README, license, compiled exports, content mapper, and asynchronous SQL loader.
Source maps must reference source files that the archive contains.
The archive must exclude test fixtures, editor settings, local databases, credentials, and dependency directories.

Install the archive in a separate consumer project.
Use only the documented runtime and development dependencies in that project.
Verify the README setup procedure, compiler diagnostics, editor hover, Node preload, and Vite plugin.
Verify that the consumer does not require Silt's development dependencies or local source checkout.

## Review the public repository

1. Review the full Git history and files for private material.
2. Confirm the license, attribution, issue links, and contribution instructions.
3. Configure CI to run the verification command and archive checks.
4. Replace the unpublished status text in the README with the actual npm release status.

## Publish the first version

Use [npm's current release instructions](https://docs.npmjs.com/cli/commands/npm-publish/).
Configure [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for subsequent automated releases when applicable.
Public repository access is necessary for npm provenance from GitHub Actions.

Publish the reviewed archive only after explicit release approval:

```sh
npm publish ./effect-silt-0.1.0.tgz --access public
```

Use the filename for the selected release version.
Then verify the registry install in a clean consumer project.
Create a Git tag and GitHub release for the exact source commit of the archive.
