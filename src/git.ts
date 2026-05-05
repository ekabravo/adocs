import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { INSTRUCTION_FILES } from "./constants";
import { isInstructionFilePath, hasExcludedDirectory } from "./discovery";

type GitOptions = {
  cwd: string;
};

const TRACKED_INSTRUCTION_PATHSPECS = INSTRUCTION_FILES.flatMap((name) => [`:(glob)${name}`, `:(glob)**/${name}`]);

function runGit(args: string[], options: GitOptions): string {
  return execFileSync("git", args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function runGitRaw(args: string[], options: GitOptions): string {
  return execFileSync("git", args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function isWithinScope(filePath: string, scopePath: string): boolean {
  if (!scopePath || scopePath === ".") {
    return true;
  }

  return filePath === scopePath || filePath.startsWith(`${scopePath}/`);
}

export function resolveRepositoryRoot(startPath: string): string {
  return runGit(["rev-parse", "--show-toplevel"], { cwd: startPath });
}

export function getScopePath(repositoryRoot: string, root: string): string {
  const relativePath = path.relative(repositoryRoot, root);
  return toPosixPath(relativePath || ".");
}

export function listTrackedInstructionFiles(repositoryRoot: string, scopePath = ".", includeExcluded = true): string[] {
  const output = runGitRaw(["ls-files", "-z", "--full-name", "--", ...TRACKED_INSTRUCTION_PATHSPECS], { cwd: repositoryRoot });

  return output
    .split("\0")
    .filter(Boolean)
    .map(toPosixPath)
    .filter(isInstructionFilePath)
    .filter((filePath) => isWithinScope(filePath, scopePath))
    .filter((filePath) => includeExcluded || !hasExcludedDirectory(filePath))
    .sort();
}

export function getTrackedInstructionNames(filePaths: string[]): string[] {
  return [...new Set(filePaths.map((filePath) => path.posix.basename(filePath)))].sort();
}

export function getTrackedRootInstructionNames(filePaths: string[], scopePath = "."): string[] {
  return getTrackedInstructionNames(
    filePaths.filter((filePath) => {
      const baseName = path.posix.basename(filePath);
      const expected = scopePath && scopePath !== "." ? `${scopePath}/${baseName}` : baseName;
      return filePath === expected;
    }),
  );
}

export function markSkipWorktree(repositoryRoot: string, filePaths: string[]): void {
  if (filePaths.length === 0) {
    return;
  }

  runGit(["update-index", "--skip-worktree", "--", ...filePaths], { cwd: repositoryRoot });
}

export function clearSkipWorktree(repositoryRoot: string, filePaths: string[]): void {
  if (filePaths.length === 0) {
    return;
  }

  runGit(["update-index", "--no-skip-worktree", "--", ...filePaths], { cwd: repositoryRoot });
}

export function restoreTrackedFiles(repositoryRoot: string, filePaths: string[]): void {
  if (filePaths.length === 0) {
    return;
  }

  runGit(["restore", "--source=HEAD", "--staged", "--worktree", "--", ...filePaths], { cwd: repositoryRoot });
}

export async function removeFiles(repositoryRoot: string, filePaths: string[]): Promise<void> {
  await Promise.all(
    filePaths.map((filePath) => fs.rm(path.join(repositoryRoot, filePath), { force: true })),
  );
}
