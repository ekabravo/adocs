import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveGitPath } from "./git";
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

  return root;
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

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

describe("override", () => {
  test("copies source AGENTS.md into root AGENTS.md and CLAUDE.md", async () => {
    const tempRoot = await makeRepository({
      "AGENTS.md": "root agents\n",
      "packages/api/CLAUDE.md": "nested claude\n",
      "packages/web/AGENTS.md": "nested agents\n",
    });
    const root = await fs.realpath(tempRoot);
    const source = await makeSourceDirectory({
      "AGENTS.md": "override contents\n",
    });

    const result = await applyOverride({ root, source });
    const excludePath = resolveGitPath(root, "info/exclude");

    expect(result.targets).toEqual(["AGENTS.md", "packages/api/CLAUDE.md", "packages/web/AGENTS.md"]);
    expect(result.writtenPaths).toEqual([path.join(root, "AGENTS.md"), path.join(root, "CLAUDE.md")]);
    expect(await fs.readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("override contents\n");
    expect(await fs.readFile(path.join(root, "CLAUDE.md"), "utf8")).toBe("override contents\n");
    expect(await pathExists(path.join(root, ".claude"))).toBe(false);
    expect(await pathExists(path.join(root, ".codex"))).toBe(false);
    expect(await fs.readFile(excludePath, "utf8")).toContain("AGENTS.md\nCLAUDE.md\n.claude/\n.codex/\n");
    expect(runGit(root, ["status", "--short"])).toBe("");
  });

  test("requires --source to point to a directory", async () => {
    const tempRoot = await makeRepository({
      "AGENTS.md": "root agents\n",
    });
    const root = await fs.realpath(tempRoot);
    const source = path.join(root, "override-source.md");
    await fs.writeFile(source, "override contents\n", "utf8");

    await expect(applyOverride({ root, source })).rejects.toThrow(`Source must be a directory: ${source}`);
  });

  test("replaces root .claude and .codex directories from the source directory", async () => {
    const tempRoot = await makeRepository({
      "AGENTS.md": "root agents\n",
      ".claude/old.txt": "old claude\n",
      ".codex/old.txt": "old codex\n",
      "packages/api/CLAUDE.md": "nested claude\n",
    });
    const root = await fs.realpath(tempRoot);
    const source = await makeSourceDirectory({
      "AGENTS.md": "override contents\n",
      ".claude/new.txt": "new claude\n",
      ".codex/new.txt": "new codex\n",
    });

    const result = await applyOverride({ root, source });

    expect(result.skippedTargets).toEqual([
      ".claude/old.txt",
      ".codex/old.txt",
      "AGENTS.md",
      "packages/api/CLAUDE.md",
    ]);
    expect(await fs.readFile(path.join(root, ".claude", "new.txt"), "utf8")).toBe("new claude\n");
    expect(await fs.readFile(path.join(root, ".codex", "new.txt"), "utf8")).toBe("new codex\n");
    expect(await pathExists(path.join(root, ".claude", "old.txt"))).toBe(false);
    expect(await pathExists(path.join(root, ".codex", "old.txt"))).toBe(false);
    expect(runGit(root, ["status", "--short"])).toBe("");
  });

  test("allows missing source artifacts and removes stale managed files", async () => {
    const tempRoot = await makeRepository({
      "AGENTS.md": "root agents\n",
      "packages/api/CLAUDE.md": "nested claude\n",
    });
    const root = await fs.realpath(tempRoot);
    await fs.writeFile(path.join(root, "CLAUDE.md"), "stale claude\n", "utf8");
    await fs.mkdir(path.join(root, ".codex"), { recursive: true });
    await fs.writeFile(path.join(root, ".codex", "stale.txt"), "stale codex\n", "utf8");
    const source = await makeSourceDirectory({
      ".claude/new.txt": "new claude\n",
    });

    const result = await applyOverride({ root, source });

    expect(result.writtenPaths).toEqual([path.join(root, ".claude")]);
    expect(await pathExists(path.join(root, "AGENTS.md"))).toBe(false);
    expect(await pathExists(path.join(root, "CLAUDE.md"))).toBe(false);
    expect(await fs.readFile(path.join(root, ".claude", "new.txt"), "utf8")).toBe("new claude\n");
    expect(await pathExists(path.join(root, ".codex"))).toBe(false);
    expect(runGit(root, ["status", "--short"])).toBe("");
  });

  test("restore removes temporary override artifacts and clears local exclude entries", async () => {
    const tempRoot = await makeRepository({
      "packages/api/CLAUDE.md": "nested claude\n",
    });
    const root = await fs.realpath(tempRoot);
    const source = await makeSourceDirectory({
      "AGENTS.md": "override contents\n",
      ".claude/new.txt": "new claude\n",
      ".codex/new.txt": "new codex\n",
    });

    await applyOverride({ root, source });

    const result = await restoreOverride({ root });
    const excludePath = resolveGitPath(root, "info/exclude");

    expect(result.removedOverridePaths).toEqual([
      path.join(root, "AGENTS.md"),
      path.join(root, "CLAUDE.md"),
      path.join(root, ".claude"),
      path.join(root, ".codex"),
    ]);
    expect(await pathExists(path.join(root, "AGENTS.md"))).toBe(false);
    expect(await pathExists(path.join(root, "CLAUDE.md"))).toBe(false);
    expect(await pathExists(path.join(root, ".claude"))).toBe(false);
    expect(await pathExists(path.join(root, ".codex"))).toBe(false);
    expect(await fs.readFile(path.join(root, "packages/api/CLAUDE.md"), "utf8")).toBe("nested claude\n");
    expect(await fs.readFile(excludePath, "utf8")).not.toContain("# adocs local overrides: begin");
    expect(runGit(root, ["status", "--short"])).toBe("");
  });

  test("restore brings back tracked root instruction and context directories", async () => {
    const tempRoot = await makeRepository({
      "AGENTS.md": "root agents\n",
      ".claude/settings.json": "{\"tracked\":true}\n",
      ".codex/config.json": "{\"tracked\":true}\n",
      "packages/api/CLAUDE.md": "nested claude\n",
    });
    const root = await fs.realpath(tempRoot);
    const source = await makeSourceDirectory({
      "AGENTS.md": "override contents\n",
      ".claude/settings.json": "{\"override\":true}\n",
      ".codex/config.json": "{\"override\":true}\n",
    });

    await applyOverride({ root, source });

    const result = await restoreOverride({ root });

    expect(result.restoredTargets).toEqual([
      ".claude/settings.json",
      ".codex/config.json",
      "AGENTS.md",
      "packages/api/CLAUDE.md",
    ]);
    expect(await fs.readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("root agents\n");
    expect(await fs.readFile(path.join(root, ".claude", "settings.json"), "utf8")).toBe("{\"tracked\":true}\n");
    expect(await fs.readFile(path.join(root, ".codex", "config.json"), "utf8")).toBe("{\"tracked\":true}\n");
    expect(await pathExists(path.join(root, "CLAUDE.md"))).toBe(false);
    expect(runGit(root, ["status", "--short"])).toBe("");
  });
});
