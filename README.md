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
adocs override --source ~/docs/agent-context --dry-run
adocs override --source ~/docs/agent-context
adocs restore --dry-run
adocs restore
```

## Overview

`adocs` is a CLI for inspecting and locally overriding repository AI instructions and project-scoped agent configuration.

It was built for a simple reason: many repositories add too many AI instruction files, often spread across nested directories, and they end up adding noise instead of clarity. When you work locally, you may want a short, consistent set of instructions that matches how you prefer to work, without editing the repository for everyone else.

`adocs` automates that local workflow. It helps you inspect instruction files, temporarily override them on your machine, and restore the tracked versions later.

## How It Works

`adocs` supports four main workflows:

1. Find instruction files and known Claude/Codex project configuration in one filesystem pass.
2. Show configured skills, agents, MCP servers, hooks, plugins/marketplaces, apps/connectors, rules, workflows, and related artifacts.
3. Remove only documented, repository-shared artifacts and mark tracked files with Git `skip-worktree`.
4. Copy the matching artifacts from your local override directory, then restore the tracked versions later.

Mutating commands require at least one Git-tracked instruction or managed configuration file in scope so the original state can be restored safely.

## Commands

### Inspect project context

```bash
npx adocs-cli
npx adocs-cli ./repo
npx adocs-cli --json
npx adocs-cli --excluded
```

Shows all discovered `AGENTS.md` and `CLAUDE.md` files plus known project-scoped Claude and Codex configuration. The tree shows where each artifact lives, followed by a compact semantic inventory of configured skills, agents, MCP servers, hooks, plugins, apps, and other extensions.

Excluded directories such as `node_modules` and `.git` are skipped during traversal unless `--excluded` is passed. Configuration values that may contain credentials or environment variables are never printed.

### Apply a local override

```bash
npx adocs-cli override --source ~/docs/agent-context
npx adocs-cli override --source ./agent-context ./repo
npx adocs-cli override --source ./agent-context --excluded
npx adocs-cli override --source ./agent-context ./repo --dry-run
```

This command:

1. Resolves the Git repository root.
2. Finds tracked `AGENTS.md` and `CLAUDE.md` files in scope.
3. Finds tracked files belonging to the documented managed artifacts below.
4. Writes recovery state inside the repository's Git directory.
5. Removes only those tracked files and managed artifact paths from the working tree.
6. Marks tracked targets with Git `skip-worktree`.
7. Copies matching source artifacts into the target root.
8. Adds only the generated artifact paths to `.git/info/exclude`.

`--dry-run` performs discovery and prints the same removal, write, skip-worktree, exclude, and state paths without changing the filesystem or Git index.

For safety, a first-time override is refused when a target is modified or already has a `skip-worktree` or `assume-unchanged` flag, because those conditions may hide a local customization that Git cannot recover. Active override scopes also cannot overlap as ancestor and descendant directories; restore the active scope first. Independent sibling scopes are supported.

Override and restore are intentionally disabled while linked Git worktrees exist. Git shares `.git/info/exclude` between linked worktrees but keeps index flags and adocs state per worktree, so mutating an override in that situation cannot be made safely atomic. Inspection with plain `adocs` remains available.

The managed paths are:

```text
AGENTS.md
CLAUDE.md
.claude/CLAUDE.md
.claude/settings.json
.claude/{skills,commands,agents,rules,workflows,output-styles,agent-memory,hooks}/
.mcp.json
.codex/config.toml
.codex/{agents,skills,rules,hooks}/
.codex/hooks.json
.agents/skills/
.agents/plugins/marketplace.json
.claude-plugin/marketplace.json
```

Codex documents `.agents/skills` as the canonical repository skill location; `.codex/skills` remains supported by the current Codex runtime and is included for compatibility.

The following are deliberately preserved:

```text
.claude/settings.local.json
.claude/agent-memory-local/
CLAUDE.local.md
.worktreeinclude
every unknown .claude/* or .codex/* sibling
```

This follows the official [Claude project configuration](https://code.claude.com/docs/en/claude-directory), [Codex project configuration](https://developers.openai.com/codex/config-basic), [Codex skills](https://developers.openai.com/codex/skills), and [Codex plugin marketplace](https://developers.openai.com/codex/plugins/build/) layouts.

`.claude/hooks/` is treated as a conventional payload directory for hook scripts referenced by Claude settings; Claude discovers hook declarations from settings rather than automatically loading that directory.

The source path must be a directory. Missing artifacts are allowed and are omitted from the override. If source `AGENTS.md` exists, its contents are written to both root `AGENTS.md` and root `CLAUDE.md` for cross-agent compatibility.

### Restore tracked files

```bash
npx adocs-cli restore
npx adocs-cli restore ./repo
npx adocs-cli restore ./repo --dry-run
```

This removes the exact override artifacts recorded for the target scope, clears the `skip-worktree` flags added by `adocs`, restores tracked files from `HEAD`, and removes that scope's `.git/info/exclude` entries. Overrides in independent sibling scopes remain active. If no current state or positively identified legacy override exists, restore exits without touching local files.

`restore --dry-run` reports the exact restore and removal plan without making changes.

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
