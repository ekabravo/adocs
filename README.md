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
adocs override --source ~/docs/AGENTS.md
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
3. Write your local override as root `AGENTS.md`, then restore the tracked files later when needed.

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
npx adocs-cli override --source ~/docs/AGENTS.md
npx adocs-cli override --source ./AGENTS.local.md ./repo
npx adocs-cli override --source ./AGENTS.local.md --excluded
```

This command:

1. Resolves the Git repository root.
2. Finds tracked `AGENTS.md` and `CLAUDE.md` files in scope.
3. Removes those tracked files from the working tree.
4. Marks them with Git `skip-worktree`.
5. Writes your local override to root `AGENTS.md`.

### Restore tracked files

```bash
npx adocs-cli restore
npx adocs-cli restore ./repo
```

This clears `skip-worktree`, restores the tracked files from `HEAD`, and removes the temporary root `AGENTS.md` if it was created only for the local override.

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
