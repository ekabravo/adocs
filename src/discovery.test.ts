import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverInstructionFiles, hasExcludedDirectory, isInstructionFilePath } from "./discovery";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "adocs-discovery-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

describe("discovery", () => {
  test("detects supported instruction file names", () => {
    expect(isInstructionFilePath("AGENTS.md")).toBe(true);
    expect(isInstructionFilePath("nested/CLAUDE.md")).toBe(true);
    expect(isInstructionFilePath("README.md")).toBe(false);
  });

  test("filters excluded directories", () => {
    expect(hasExcludedDirectory("node_modules/pkg/CLAUDE.md")).toBe(true);
    expect(hasExcludedDirectory(".git/hooks/AGENTS.md")).toBe(true);
    expect(hasExcludedDirectory("packages/api/CLAUDE.md")).toBe(false);
  });

  test("discovers files and excludes node_modules by default", async () => {
    const root = await makeTempRoot();

    await fs.mkdir(path.join(root, "packages", "api"), { recursive: true });
    await fs.mkdir(path.join(root, "node_modules", "dep"), { recursive: true });
    await fs.writeFile(path.join(root, "AGENTS.md"), "");
    await fs.writeFile(path.join(root, "packages", "api", "CLAUDE.md"), "");
    await fs.writeFile(path.join(root, "node_modules", "dep", "CLAUDE.md"), "");

    expect(await discoverInstructionFiles(root)).toEqual(["AGENTS.md", "packages/api/CLAUDE.md"]);
    expect(await discoverInstructionFiles(root, { includeExcluded: true })).toEqual([
      "AGENTS.md",
      "node_modules/dep/CLAUDE.md",
      "packages/api/CLAUDE.md",
    ]);
  });
});
