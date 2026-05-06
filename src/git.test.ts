import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getScopePath,
  getTrackedInstructionNames,
  getTrackedRootInstructionNames,
  listTrackedInstructionFiles,
  listTrackedOverrideDirectoryFiles,
  resolveGitPath,
  resolveRepositoryRoot,
  setManagedLocalExcludeEntries,
} from "./git";

const tempRoots: string[] = [];

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function runGitWithInput(cwd: string, args: string[], input: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

async function makeRepository(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "adocs-git-"));
  tempRoots.push(root);

  runGit(root, ["init"]);
  runGit(root, ["config", "user.name", "adocs"]);
  runGit(root, ["config", "user.email", "adocs@example.com"]);

  await fs.mkdir(path.join(root, "packages", "web"), { recursive: true });
  await fs.mkdir(path.join(root, ".claude"), { recursive: true });
  await fs.mkdir(path.join(root, "packages", "web", ".codex"), { recursive: true });
  await fs.mkdir(path.join(root, "node_modules", "dep"), { recursive: true });
  await fs.writeFile(path.join(root, "AGENTS.md"), "root");
  await fs.writeFile(path.join(root, ".claude", "settings.json"), "{}");
  await fs.writeFile(path.join(root, "packages", "web", "CLAUDE.md"), "web");
  await fs.writeFile(path.join(root, "packages", "web", ".codex", "config.json"), "{}");
  await fs.writeFile(path.join(root, "node_modules", "dep", "AGENTS.md"), "dep");

  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-m", "init"]);

  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

describe("git helpers", () => {
  test("lists tracked instruction files with scope and exclusion filters", async () => {
    const root = await makeRepository();
    const repositoryRoot = resolveRepositoryRoot(root);

    expect(await fs.realpath(repositoryRoot)).toBe(await fs.realpath(root));
    expect(listTrackedInstructionFiles(root, ".", false)).toEqual(["AGENTS.md", "packages/web/CLAUDE.md"]);
    expect(listTrackedInstructionFiles(root, ".", true)).toEqual([
      "AGENTS.md",
      "node_modules/dep/AGENTS.md",
      "packages/web/CLAUDE.md",
    ]);
    expect(listTrackedInstructionFiles(root, "packages", true)).toEqual(["packages/web/CLAUDE.md"]);
    expect(listTrackedOverrideDirectoryFiles(root, ".", ".claude")).toEqual([".claude/settings.json"]);
    expect(listTrackedOverrideDirectoryFiles(root, "packages/web", ".codex")).toEqual([
      "packages/web/.codex/config.json",
    ]);
  });

  test("derives root-level override targets from tracked files", () => {
    const files = ["AGENTS.md", "packages/api/CLAUDE.md", "packages/web/AGENTS.md"];

    expect(getTrackedInstructionNames(files)).toEqual(["AGENTS.md", "CLAUDE.md"]);
    expect(getTrackedRootInstructionNames(files, ".")).toEqual(["AGENTS.md"]);
    expect(getTrackedRootInstructionNames(files, "packages")).toEqual([]);
    expect(getScopePath("/repo", "/repo/packages/web")).toBe("packages/web");
  });

  test("ignores large tracked non-instruction output when listing instruction files", async () => {
    const root = await makeRepository();
    const blobId = runGitWithInput(root, ["hash-object", "-w", "--stdin"], "tracked\n");
    const bulkEntries = Array.from({ length: 12000 }, (_, index) => {
      const name = `bulk/${String(index).padStart(5, "0")}/${"x".repeat(120)}.txt`;
      return `100644 ${blobId}\t${name}\n`;
    }).join("");

    runGitWithInput(root, ["update-index", "--add", "--index-info"], bulkEntries);

    expect(listTrackedInstructionFiles(root, ".", false)).toEqual(["AGENTS.md", "packages/web/CLAUDE.md"]);
  });

  test("manages a dedicated block in git info exclude", async () => {
    const root = await makeRepository();
    const excludePath = resolveGitPath(root, "info/exclude");

    await fs.writeFile(excludePath, "existing\ncustom\n", "utf8");
    await setManagedLocalExcludeEntries(root, ["packages/web/AGENTS.md", "packages/web/.claude/"]);

    expect(await fs.readFile(excludePath, "utf8")).toBe(
      [
        "existing",
        "custom",
        "",
        "# adocs local overrides: begin",
        "packages/web/AGENTS.md",
        "packages/web/.claude/",
        "# adocs local overrides: end",
        "",
      ].join("\n"),
    );

    await setManagedLocalExcludeEntries(root, []);

    expect(await fs.readFile(excludePath, "utf8")).toBe("existing\ncustom\n");
  });
});
