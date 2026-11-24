# Contributing

Development runs on [bun](https://bun.sh). The published package runs on Node
22 or later, with no bun.

## Report a bug or ask for a feature

Open an issue on
[GitHub Issues](https://github.com/gillesdandrea/mdmem/issues).

## Run mdmem from a checkout

```bash
git clone https://github.com/gillesdandrea/mdmem.git
cd mdmem
bun install
bun run build      # builds dist/, what `mdmem` on your PATH runs
bun link           # puts this checkout's `mdmem` on your PATH
```

Run `bun run build` again after changing `src/`, so the linked `mdmem` follows.
To run the sources with no build, use `bun src/cli/index.ts <command>`.

## Check your change

```bash
bun run all:check  # type:check + ultracite check + test + test:hooks (what CI runs)
bun run check      # ultracite check: oxlint + oxfmt
bun run fix        # ultracite fix
bun test           # tests only
```

`bun run build` bundles `src/` into `dist/` for Node, with the dependencies
left external, and refuses a Bun API in `src/`. `npm pack` ships `dist/`,
`templates/`, the README and the changelog.
`scripts/smoke-node.sh <tarball>` installs the tarball into a temporary prefix
and runs it with Node alone, as CI does.

The stack is `bun` (development runtime, bundler, tests), Node 22+ (the
published package), TypeScript 7 (`tsc`, typecheck), and `ultracite` driving
`oxlint` and `oxfmt`. The maintainer tracks work as beads with the `bd` CLI, in
a database kept outside the repository, and turns an issue that leads to work
into a bead: see [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).

## Propose a change

`main` changes through pull requests only. Commit on a branch, push it, and
open a pull request against `main`. It merges once CI's `check` job passes.

## Release

1. In a pull request, set the version in `package.json` and date the
   changelog's section.
2. Once it merges, publish a GitHub release tagged `v<version>` on that
   commit. The Release workflow checks,
   packs and smoke-tests that tag, then stages the tarball on npm, under `next`
   for a prerelease version and `latest` otherwise.
3. Approve the staged version with 2FA, on npmjs.com or with
   `npm stage list @gillesdandrea/mdmem`, then `npm stage approve <stage-id>`.
   The version is installable once approved.
