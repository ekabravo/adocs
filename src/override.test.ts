import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  test("writes only a root AGENTS.md override", async () => {
    const tempRoot = await makeRepository({
      "AGENTS.md": "root agents\n",
      "packages/api/CLAUDE.md": "nested claude\n",
      "packages/web/AGENTS.md": "nested agents\n",
    });
    const root = await fs.realpath(tempRoot);
    const source = path.join(root, "override-source.md");
    await fs.writeFile(source, "override contents\n", "utf8");

    const result = await applyOverride({ root, source });

    expect(result.writtenFiles).toEqual([path.join(root, "AGENTS.md")]);
    expect(await fs.readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("override contents\n");
    expect(await pathExists(path.join(root, "CLAUDE.md"))).toBe(false);
  });

  test("restore removes only the temporary AGENTS.md override when root AGENTS.md was not tracked", async () => {
    const tempRoot = await makeRepository({
      "packages/api/CLAUDE.md": "nested claude\n",
    });
    const root = await fs.realpath(tempRoot);
    const source = path.join(root, "override-source.md");
    await fs.writeFile(source, "override contents\n", "utf8");

    await applyOverride({ root, source });

    expect(await fs.readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("override contents\n");

    const result = await restoreOverride({ root });

    expect(result.removedOverrideFiles).toEqual([path.join(root, "AGENTS.md")]);
    expect(await pathExists(path.join(root, "AGENTS.md"))).toBe(false);
    expect(await fs.readFile(path.join(root, "packages/api/CLAUDE.md"), "utf8")).toBe("nested claude\n");
  });
});
