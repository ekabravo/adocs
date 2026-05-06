# adocs

## Quick Start

Run without installing:

```bash
npx adocs-cli
```

Install globally:

```bash
npm install -g adocs-cli
```

Then use:

```bash
adocs
adocs ./repo
adocs override --source ~/docs/agent-context
adocs restore
```

## Overview

`adocs` is a CLI for managing repository-local `AGENTS.md` and `CLAUDE.md` files.

It was built for a simple reason: many repositories add too many AI instruction files, often spread across nested directories, and they end up adding noise instead of clarity. When you work locally, you may want a short, consistent set of instructions that matches how you prefer to work, without editing the repository for everyone else.

`adocs` automates that local workflow. It helps you inspect instruction files, temporarily override them on your machine, and restore the tracked versions later.

## How It Works

`adocs` supports three main workflows:

1. Find instruction files and show them as a pruned tree.
2. Remove tracked instruction files locally and mark them with Git `skip-worktree`.
3. Copy your local override directory into the target root, then restore the tracked files later when needed.

By default, mutating commands operate only on Git-tracked instruction files so the original state can be restored safely.

## Commands

### Show instruction files

```bash
npx adocs-cli
npx adocs-cli ./repo
npx adocs-cli --json
npx adocs-cli --excluded
```

Shows all discovered `AGENTS.md` and `CLAUDE.md` files under the target directory as a pruned tree. Excluded directories such as `node_modules` are hidden unless `--excluded` is passed.

### Apply a local override

```bash
npx adocs-cli override --source ~/docs/agent-context
npx adocs-cli override --source ./agent-context ./repo
npx adocs-cli override --source ./agent-context --excluded
```

This command:

1. Resolves the Git repository root.
2. Finds tracked `AGENTS.md` and `CLAUDE.md` files in scope.
3. Removes those tracked files and any tracked root `.claude` or `.codex` files from the working tree.
4. Marks those tracked files with Git `skip-worktree`.
5. Removes root `AGENTS.md`, `CLAUDE.md`, `.claude`, and `.codex` before applying the new override.
6. Copies `AGENTS.md` from the source directory into both root `AGENTS.md` and root `CLAUDE.md` when present.
7. Recursively copies source `.claude` and `.codex` directories when present.
8. Adds the generated local artifacts to `.git/info/exclude`.

The source path must be a directory. Missing `AGENTS.md`, `.claude`, or `.codex` entries are allowed and will simply be omitted from the override.

### Restore tracked files

```bash
npx adocs-cli restore
npx adocs-cli restore ./repo
```

This clears `skip-worktree`, restores tracked files from `HEAD`, removes temporary root override artifacts that were not tracked, and clears the local `.git/info/exclude` entries added by `adocs`.

## Local Development

Install dependencies:

```bash
bun install
```

Run the local source tree:

```bash
bun run ./index.ts
```

Run tests:

```bash
bun test
```
