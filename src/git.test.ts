import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getScopePath, getTrackedInstructionNames, getTrackedRootInstructionNames, listTrackedInstructionFiles, resolveRepositoryRoot } from "./git";

const tempRoots: string[] = [];

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function makeRepository(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "adocs-git-"));
  tempRoots.push(root);

  runGit(root, ["init"]);
  runGit(root, ["config", "user.name", "adocs"]);
  runGit(root, ["config", "user.email", "adocs@example.com"]);

  await fs.mkdir(path.join(root, "packages", "web"), { recursive: true });
  await fs.mkdir(path.join(root, "node_modules", "dep"), { recursive: true });
  await fs.writeFile(path.join(root, "AGENTS.md"), "root");
  await fs.writeFile(path.join(root, "packages", "web", "CLAUDE.md"), "web");
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
  });

  test("derives root-level override targets from tracked files", () => {
    const files = ["AGENTS.md", "packages/api/CLAUDE.md", "packages/web/AGENTS.md"];

    expect(getTrackedInstructionNames(files)).toEqual(["AGENTS.md", "CLAUDE.md"]);
    expect(getTrackedRootInstructionNames(files, ".")).toEqual(["AGENTS.md"]);
    expect(getTrackedRootInstructionNames(files, "packages")).toEqual([]);
    expect(getScopePath("/repo", "/repo/packages/web")).toBe("packages/web");
  });
});
