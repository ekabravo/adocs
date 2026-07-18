import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LOCAL_EXCLUDE_BEGIN } from "./constants";
import { resolveGitPath, setManagedLocalExcludeEntries } from "./git";
import { applyOverride } from "./override";
import { restoreOverride } from "./restore";

const tempRoots: string[] = [];

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function makeRepository(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "adocs-override-"));
  tempRoots.push(root);
  runGit(root, ["init"]);
  runGit(root, ["config", "user.name", "adocs"]);
  runGit(root, ["config", "user.email", "adocs@example.com"]);

  for (const [relativePath, contents] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await fs.writeFile(path.join(root, relativePath), contents, "utf8");
  }
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-m", "init"]);
  return fs.realpath(root);
}

async function makeSourceDirectory(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "adocs-source-"));
  tempRoots.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await fs.writeFile(path.join(root, relativePath), contents, "utf8");
  }
  return root;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function dryRunSnapshot(root: string): Promise<Record<string, string>> {
  const excludePath = resolveGitPath(root, "info/exclude");
  return {
    status: runGit(root, ["status", "--short", "--untracked-files=all"]),
    index: runGit(root, ["ls-files", "-v"]),
    exclude: await fs.readFile(excludePath, "utf8"),
    agents: await fs.readFile(path.join(root, "AGENTS.md"), "utf8").catch(() => "<missing>"),
    claudeSettings: await fs.readFile(path.join(root, ".claude/settings.json"), "utf8").catch(() => "<missing>"),
    codexConfig: await fs.readFile(path.join(root, ".codex/config.toml"), "utf8").catch(() => "<missing>"),
  };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

describe("override", () => {
  test("copies source AGENTS.md into root AGENTS.md and CLAUDE.md", async () => {
    const root = await makeRepository({
      "AGENTS.md": "root agents\n",
      "packages/api/CLAUDE.md": "nested claude\n",
      "packages/web/AGENTS.md": "nested agents\n",
    });
    const source = await makeSourceDirectory({ "AGENTS.md": "override contents\n" });

    const result = await applyOverride({ root, source });
    const exclude = await fs.readFile(resolveGitPath(root, "info/exclude"), "utf8");

    expect(result.targets).toEqual(["AGENTS.md", "packages/api/CLAUDE.md", "packages/web/AGENTS.md"]);
    expect(result.writtenPaths).toEqual([path.join(root, "AGENTS.md"), path.join(root, "CLAUDE.md")]);
    expect(await fs.readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("override contents\n");
    expect(await fs.readFile(path.join(root, "CLAUDE.md"), "utf8")).toBe("override contents\n");
    expect(exclude).toContain(".claude/skills/\n");
    expect(exclude).toContain(".codex/config.toml\n");
    expect(exclude).not.toContain("\n.claude/\n");
    expect(runGit(root, ["status", "--short"])).toBe("");
  });

  test("requires --source to point to a directory", async () => {
    const root = await makeRepository({ "AGENTS.md": "root agents\n" });
    const source = path.join(root, "override-source.md");
    await fs.writeFile(source, "override contents\n", "utf8");
    await expect(applyOverride({ root, source })).rejects.toThrow(`Source must be a directory: ${source}`);
  });

  test("replaces only documented project artifacts and preserves unknown or local files", async () => {
    const root = await makeRepository({
      "AGENTS.md": "root agents\n",
      ".claude/settings.json": "{\"tracked\":true}\n",
      ".claude/skills/old/SKILL.md": "old claude skill\n",
      ".claude/cache/keep.txt": "keep claude cache\n",
      ".claude/settings.local.json": "{\"local\":true}\n",
      ".codex/config.toml": "model = \"tracked\"\n",
      ".codex/skills/old/SKILL.md": "old codex skill\n",
      ".codex/session/keep.txt": "keep codex session\n",
      ".agents/skills/old/SKILL.md": "old canonical skill\n",
    });
    const source = await makeSourceDirectory({
      ".claude/settings.json": "{\"override\":true}\n",
      ".claude/skills/new/SKILL.md": "new claude skill\n",
      ".codex/config.toml": "model = \"override\"\n",
      ".codex/skills/new/SKILL.md": "new codex skill\n",
      ".agents/skills/new/SKILL.md": "new canonical skill\n",
    });

    const result = await applyOverride({ root, source });

    expect(result.skippedTargets).toContain(".claude/skills/old/SKILL.md");
    expect(result.skippedTargets).toContain(".codex/config.toml");
    expect(await pathExists(path.join(root, ".claude/skills/old/SKILL.md"))).toBe(false);
    expect(await fs.readFile(path.join(root, ".claude/skills/new/SKILL.md"), "utf8")).toBe("new claude skill\n");
    expect(await fs.readFile(path.join(root, ".claude/cache/keep.txt"), "utf8")).toBe("keep claude cache\n");
    expect(await fs.readFile(path.join(root, ".claude/settings.local.json"), "utf8")).toBe("{\"local\":true}\n");
    expect(await fs.readFile(path.join(root, ".codex/session/keep.txt"), "utf8")).toBe("keep codex session\n");
    expect(runGit(root, ["status", "--short"])).toBe("");
  });

  test("missing source artifacts remove managed configuration but not unknown siblings", async () => {
    const root = await makeRepository({
      "AGENTS.md": "root agents\n",
      ".claude/settings.json": "{\"tracked\":true}\n",
      ".claude/unknown.txt": "preserved\n",
      ".codex/config.toml": "model = \"tracked\"\n",
      ".codex/unknown.txt": "preserved\n",
    });
    const source = await makeSourceDirectory({});

    const result = await applyOverride({ root, source });

    expect(result.writtenPaths).toEqual([]);
    expect(await pathExists(path.join(root, "AGENTS.md"))).toBe(false);
    expect(await pathExists(path.join(root, ".claude/settings.json"))).toBe(false);
    expect(await pathExists(path.join(root, ".codex/config.toml"))).toBe(false);
    expect(await fs.readFile(path.join(root, ".claude/unknown.txt"), "utf8")).toBe("preserved\n");
    expect(await fs.readFile(path.join(root, ".codex/unknown.txt"), "utf8")).toBe("preserved\n");
  });

  test("restore removes override artifacts, restores tracked content, and preserves unknown siblings", async () => {
    const root = await makeRepository({
      "AGENTS.md": "root agents\n",
      ".claude/settings.json": "{\"tracked\":true}\n",
      ".claude/skills/old/SKILL.md": "tracked skill\n",
      ".claude/cache/keep.txt": "keep\n",
      ".codex/config.toml": "model = \"tracked\"\n",
      "packages/api/CLAUDE.md": "nested claude\n",
    });
    const source = await makeSourceDirectory({
      "AGENTS.md": "override contents\n",
      ".claude/settings.json": "{\"override\":true}\n",
      ".claude/skills/new/SKILL.md": "override skill\n",
      ".codex/config.toml": "model = \"override\"\n",
    });
    await applyOverride({ root, source });

    const result = await restoreOverride({ root });
    const exclude = await fs.readFile(resolveGitPath(root, "info/exclude"), "utf8");

    expect(result.legacy).toBe(false);
    expect(result.restoredTargets).toContain(".claude/settings.json");
    expect(result.restoredTargets).toContain(".claude/skills/old/SKILL.md");
    expect(await fs.readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("root agents\n");
    expect(await fs.readFile(path.join(root, ".claude/settings.json"), "utf8")).toBe("{\"tracked\":true}\n");
    expect(await fs.readFile(path.join(root, ".claude/skills/old/SKILL.md"), "utf8")).toBe("tracked skill\n");
    expect(await pathExists(path.join(root, ".claude/skills/new/SKILL.md"))).toBe(false);
    expect(await fs.readFile(path.join(root, ".claude/cache/keep.txt"), "utf8")).toBe("keep\n");
    expect(exclude).not.toContain("# adocs local overrides: begin");
    expect(runGit(root, ["status", "--short"])).toBe("");
  });

  test("override dry-run reports changes without mutating files, index, excludes, or state", async () => {
    const root = await makeRepository({
      "AGENTS.md": "root agents\n",
      ".claude/settings.json": "{\"tracked\":true}\n",
      ".codex/config.toml": "model = \"tracked\"\n",
    });
    const source = await makeSourceDirectory({
      "AGENTS.md": "override\n",
      ".claude/settings.json": "{\"override\":true}\n",
      ".codex/config.toml": "model = \"override\"\n",
    });
    const before = await dryRunSnapshot(root);

    const result = await applyOverride({ root, source, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.removedPaths).toContain(path.join(root, ".claude/settings.json"));
    expect(result.writtenPaths).toContain(path.join(root, ".codex/config.toml"));
    expect(await dryRunSnapshot(root)).toEqual(before);
    expect(await pathExists(result.statePath)).toBe(false);
  });

  test("dry-run removedPaths includes every nested instruction deletion", async () => {
    const root = await makeRepository({
      "AGENTS.md": "root\n",
      "packages/api/CLAUDE.md": "nested\n",
    });
    const source = await makeSourceDirectory({ "AGENTS.md": "override\n" });

    const result = await applyOverride({ root, source, dryRun: true });

    expect(result.removedPaths).toContain(path.join(root, "AGENTS.md"));
    expect(result.removedPaths).toContain(path.join(root, "packages/api/CLAUDE.md"));
  });

  test("restore dry-run reports changes without mutating an active override", async () => {
    const root = await makeRepository({
      "AGENTS.md": "root agents\n",
      ".claude/settings.json": "{\"tracked\":true}\n",
      ".codex/config.toml": "model = \"tracked\"\n",
    });
    const source = await makeSourceDirectory({
      "AGENTS.md": "override\n",
      ".claude/settings.json": "{\"override\":true}\n",
      ".codex/config.toml": "model = \"override\"\n",
    });
    await applyOverride({ root, source });
    const before = await dryRunSnapshot(root);

    const result = await restoreOverride({ root, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.legacy).toBe(false);
    expect(result.restoredTargets).toContain("AGENTS.md");
    expect(await dryRunSnapshot(root)).toEqual(before);
    await restoreOverride({ root });
    expect(await fs.readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("root agents\n");
  });

  test("refuses to overwrite pre-existing skip-worktree customizations", async () => {
    const root = await makeRepository({
      "AGENTS.md": "root agents\n",
      ".claude/settings.json": "{\"tracked\":true}\n",
    });
    runGit(root, ["update-index", "--skip-worktree", "--", ".claude/settings.json"]);
    await fs.writeFile(path.join(root, ".claude/settings.json"), "{\"personal\":true}\n");
    const source = await makeSourceDirectory({ "AGENTS.md": "override\n" });

    const preview = await applyOverride({ root, source, dryRun: true });
    expect(preview.conflictingSkipWorktreeTargets).toEqual([".claude/settings.json"]);
    await expect(applyOverride({ root, source })).rejects.toThrow("Refusing to overwrite pre-existing skip-worktree files");

    expect(await fs.readFile(path.join(root, ".claude/settings.json"), "utf8")).toBe("{\"personal\":true}\n");
    expect(runGit(root, ["ls-files", "-v", "--", ".claude/settings.json"])).toStartWith("S ");
  });

  test("refuses to overwrite staged or unstaged tracked customizations", async () => {
    const root = await makeRepository({
      "AGENTS.md": "root agents\n",
      ".claude/settings.json": "{\"tracked\":true}\n",
    });
    await fs.writeFile(path.join(root, "AGENTS.md"), "locally modified\n");
    const source = await makeSourceDirectory({ "AGENTS.md": "override\n" });

    const preview = await applyOverride({ root, source, dryRun: true });
    expect(preview.modifiedTargets).toEqual(["AGENTS.md"]);
    await expect(applyOverride({ root, source })).rejects.toThrow("Refusing to overwrite modified tracked files: AGENTS.md");
    expect(await fs.readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("locally modified\n");
  });

  test("refuses to overwrite assume-unchanged customizations", async () => {
    const root = await makeRepository({
      "AGENTS.md": "root agents\n",
      ".claude/settings.json": "{\"tracked\":true}\n",
    });
    runGit(root, ["update-index", "--assume-unchanged", "--", ".claude/settings.json"]);
    await fs.writeFile(path.join(root, ".claude/settings.json"), "{\"personal\":true}\n");
    const source = await makeSourceDirectory({ "AGENTS.md": "override\n" });

    const preview = await applyOverride({ root, source, dryRun: true });
    expect(preview.conflictingAssumeUnchangedTargets).toEqual([".claude/settings.json"]);
    await expect(applyOverride({ root, source })).rejects.toThrow("Refusing to overwrite assume-unchanged files");
    expect(await fs.readFile(path.join(root, ".claude/settings.json"), "utf8")).toBe("{\"personal\":true}\n");
  });

  test("rejects a tracked source directory that recursive instruction cleanup would delete", async () => {
    const root = await makeRepository({
      "AGENTS.md": "root agents\n",
      "agent-context/AGENTS.md": "source override\n",
    });

    await expect(applyOverride({ root, source: path.join(root, "agent-context"), dryRun: true })).rejects.toThrow(
      "Source directory contains tracked files that the override would remove",
    );
    expect(await fs.readFile(path.join(root, "agent-context/AGENTS.md"), "utf8")).toBe("source override\n");
  });

  test("keeps excludes and state independent for multiple target scopes", async () => {
    const root = await makeRepository({
      "packages/a/AGENTS.md": "a tracked\n",
      "packages/a/.claude/skills/a/SKILL.md": "a skill\n",
      "packages/b/AGENTS.md": "b tracked\n",
      "packages/b/.codex/config.toml": "model = \"tracked\"\n",
    });
    const sourceA = await makeSourceDirectory({
      "AGENTS.md": "a override\n",
      ".claude/skills/local/SKILL.md": "local a\n",
    });
    const sourceB = await makeSourceDirectory({
      "AGENTS.md": "b override\n",
      ".codex/config.toml": "model = \"override\"\n",
    });
    const scopeA = path.join(root, "packages/a");
    const scopeB = path.join(root, "packages/b");

    await applyOverride({ root: scopeA, source: sourceA });
    await applyOverride({ root: scopeB, source: sourceB });
    let exclude = await fs.readFile(resolveGitPath(root, "info/exclude"), "utf8");
    expect(exclude).toContain("packages/a/.claude/skills/");
    expect(exclude).toContain("packages/b/.codex/config.toml");

    await restoreOverride({ root: scopeA });
    exclude = await fs.readFile(resolveGitPath(root, "info/exclude"), "utf8");
    expect(await fs.readFile(path.join(scopeA, "AGENTS.md"), "utf8")).toBe("a tracked\n");
    expect(await fs.readFile(path.join(scopeB, "AGENTS.md"), "utf8")).toBe("b override\n");
    expect(exclude).not.toContain("packages/a/.claude/skills/");
    expect(exclude).toContain("packages/b/.codex/config.toml");

    await restoreOverride({ root: scopeB });
    expect(await fs.readFile(path.join(scopeB, "AGENTS.md"), "utf8")).toBe("b tracked\n");
    expect(await fs.readFile(resolveGitPath(root, "info/exclude"), "utf8")).not.toContain(LOCAL_EXCLUDE_BEGIN);
  });

  test("refuses overlapping active override scopes", async () => {
    const root = await makeRepository({
      "AGENTS.md": "root tracked\n",
      "packages/a/AGENTS.md": "child tracked\n",
    });
    const rootSource = await makeSourceDirectory({ "AGENTS.md": "root override\n" });
    const childSource = await makeSourceDirectory({ "AGENTS.md": "child override\n" });

    await applyOverride({ root, source: rootSource });
    await expect(applyOverride({ root: path.join(root, "packages/a"), source: childSource })).rejects.toThrow(
      "overlaps active adocs override '.'",
    );
    await restoreOverride({ root });

    await applyOverride({ root: path.join(root, "packages/a"), source: childSource });
    await expect(applyOverride({ root, source: rootSource })).rejects.toThrow(
      "overlaps active adocs override 'packages/a'",
    );
    await restoreOverride({ root: path.join(root, "packages/a") });
  });

  test("restore without positive legacy state never deletes ordinary local configuration", async () => {
    const root = await makeRepository({ "nested/AGENTS.md": "tracked\n" });
    await fs.mkdir(path.join(root, ".claude/cache"), { recursive: true });
    await fs.writeFile(path.join(root, ".claude/cache/keep.txt"), "keep\n");

    await expect(restoreOverride({ root })).rejects.toThrow("No active adocs override found");

    expect(await fs.readFile(path.join(root, ".claude/cache/keep.txt"), "utf8")).toBe("keep\n");
  });

  test("restores a legacy broad override only when its managed marker is present", async () => {
    const root = await makeRepository({
      "nested/AGENTS.md": "tracked\n",
      ".claude/settings.json": "{\"tracked\":true}\n",
    });
    runGit(root, ["update-index", "--skip-worktree", "--", "nested/AGENTS.md", ".claude/settings.json"]);
    await fs.rm(path.join(root, "nested/AGENTS.md"));
    await fs.rm(path.join(root, ".claude"), { recursive: true });
    await fs.mkdir(path.join(root, ".claude"), { recursive: true });
    await fs.writeFile(path.join(root, ".claude/temporary.txt"), "legacy override\n");
    await setManagedLocalExcludeEntries(root, ["AGENTS.md", "CLAUDE.md", ".claude/", ".codex/"]);

    const result = await restoreOverride({ root });

    expect(result.legacy).toBe(true);
    expect(await fs.readFile(path.join(root, "nested/AGENTS.md"), "utf8")).toBe("tracked\n");
    expect(await fs.readFile(path.join(root, ".claude/settings.json"), "utf8")).toBe("{\"tracked\":true}\n");
    expect(await pathExists(path.join(root, ".claude/temporary.txt"))).toBe(false);
  });

  test("legacy markers without matching index flags never authorize destructive restore", async () => {
    const root = await makeRepository({
      "AGENTS.md": "tracked\n",
      ".claude/settings.json": "{\"tracked\":true}\n",
    });
    await fs.writeFile(path.join(root, ".claude/local-only.txt"), "keep\n", "utf8");
    await setManagedLocalExcludeEntries(root, ["AGENTS.md", "CLAUDE.md", ".claude/", ".codex/"]);

    await expect(restoreOverride({ root })).rejects.toThrow("does not identify a complete legacy override");
    expect(await fs.readFile(path.join(root, ".claude/local-only.txt"), "utf8")).toBe("keep\n");
    expect(await fs.readFile(path.join(root, ".claude/settings.json"), "utf8")).toBe("{\"tracked\":true}\n");
  });

  test("blocks every new scope while any legacy broad override marker remains", async () => {
    const root = await makeRepository({
      "packages/a/AGENTS.md": "a\n",
      "packages/b/AGENTS.md": "b\n",
    });
    await setManagedLocalExcludeEntries(root, [
      "packages/a/AGENTS.md",
      "packages/a/CLAUDE.md",
      "packages/a/.claude/",
      "packages/a/.codex/",
    ]);
    const source = await makeSourceDirectory({ "AGENTS.md": "override\n" });

    await expect(applyOverride({ root: path.join(root, "packages/b"), source })).rejects.toThrow(
      "A legacy adocs override is active",
    );
    expect(await fs.readFile(resolveGitPath(root, "info/exclude"), "utf8")).toContain("packages/a/.claude/");
  });

  test("refuses mutations with linked worktrees and cannot consume another worktree's legacy marker", async () => {
    const root = await makeRepository({
      "AGENTS.md": "tracked\n",
      ".claude/settings.json": "{\"tracked\":true}\n",
    });
    const linked = await fs.mkdtemp(path.join(os.tmpdir(), "adocs-linked-"));
    tempRoots.push(linked);
    runGit(root, ["worktree", "add", "-b", "adocs-linked-test", linked]);
    await fs.writeFile(path.join(linked, ".claude/local-only.txt"), "keep\n", "utf8");
    await setManagedLocalExcludeEntries(root, ["AGENTS.md", "CLAUDE.md", ".claude/", ".codex/"]);
    const source = await makeSourceDirectory({ "AGENTS.md": "override\n" });

    await expect(applyOverride({ root, source, dryRun: true })).rejects.toThrow("linked Git worktrees exist");
    await expect(restoreOverride({ root: linked })).rejects.toThrow("linked Git worktrees exist");
    expect(await fs.readFile(path.join(linked, ".claude/local-only.txt"), "utf8")).toBe("keep\n");
  });

  test("reports and preserves the root .worktreeinclude file", async () => {
    const root = await makeRepository({
      "AGENTS.md": "tracked\n",
      ".worktreeinclude": ".env\n",
    });
    const source = await makeSourceDirectory({ "AGENTS.md": "override\n" });

    const preview = await applyOverride({ root, source, dryRun: true });
    expect(preview.preservedPaths).toContain(path.join(root, ".worktreeinclude"));
    await applyOverride({ root, source });
    expect(await fs.readFile(path.join(root, ".worktreeinclude"), "utf8")).toBe(".env\n");
    await restoreOverride({ root });
  });
});
