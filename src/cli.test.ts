import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempRoots: string[] = [];
const projectRoot = path.resolve(import.meta.dir, "..");

function run(cwd: string, executable: string, args: string[]): string {
  return execFileSync(executable, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function makeRepository(): Promise<{ root: string; source: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "adocs-cli-repo-"));
  const source = await fs.mkdtemp(path.join(os.tmpdir(), "adocs-cli-source-"));
  tempRoots.push(root, source);

  run(root, "git", ["init"]);
  run(root, "git", ["config", "user.name", "adocs"]);
  run(root, "git", ["config", "user.email", "adocs@example.com"]);
  await fs.mkdir(path.join(root, ".claude"), { recursive: true });
  await fs.writeFile(path.join(root, "AGENTS.md"), "tracked\n");
  await fs.writeFile(path.join(root, ".claude/settings.json"), "{\"tracked\":true}\n");
  run(root, "git", ["add", "."]);
  run(root, "git", ["commit", "-m", "init"]);

  await fs.mkdir(path.join(source, ".claude"), { recursive: true });
  await fs.writeFile(path.join(source, "AGENTS.md"), "override\n");
  await fs.writeFile(path.join(source, ".claude/settings.json"), "{\"override\":true}\n");
  return { root: await fs.realpath(root), source: await fs.realpath(source) };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

describe("CLI", () => {
  test("override --dry-run returns a plan and leaves the disposable repository unchanged", async () => {
    const { root, source } = await makeRepository();
    const beforeIndex = run(root, "git", ["ls-files", "-v"]);
    const beforeExclude = await fs.readFile(path.join(root, ".git/info/exclude"), "utf8");

    const output = run(projectRoot, "bun", ["run", "./index.ts", "override", root, "--source", source, "--dry-run"]);
    const result = JSON.parse(output) as { dryRun: boolean; removedPaths: string[]; writtenPaths: string[] };

    expect(result.dryRun).toBe(true);
    expect(result.removedPaths).toContain(path.join(root, ".claude/settings.json"));
    expect(result.writtenPaths).toContain(path.join(root, ".claude/settings.json"));
    expect(await fs.readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("tracked\n");
    expect(await fs.readFile(path.join(root, ".claude/settings.json"), "utf8")).toBe("{\"tracked\":true}\n");
    expect(run(root, "git", ["ls-files", "-v"])).toBe(beforeIndex);
    expect(await fs.readFile(path.join(root, ".git/info/exclude"), "utf8")).toBe(beforeExclude);
    expect(run(root, "git", ["status", "--short"])).toBe("");
  });
});
