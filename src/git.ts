import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {
  INSTRUCTION_FILES,
  LOCAL_EXCLUDE_BEGIN,
  LOCAL_EXCLUDE_END,
} from "./constants";
import { type ManagedArtifact, scopedArtifactPath } from "./artifacts";
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

function listTrackedPaths(repositoryRoot: string, pathspecs: string[]): string[] {
  if (pathspecs.length === 0) {
    return [];
  }

  const output = runGitRaw(["ls-files", "-z", "--full-name", "--", ...pathspecs], { cwd: repositoryRoot });

  return output
    .split("\0")
    .filter(Boolean)
    .map(toPosixPath)
    .sort();
}

function getOverrideDirectoryPathspec(scopePath: string, directoryName: string): string {
  const prefix = scopePath && scopePath !== "." ? `${scopePath}/` : "";
  return `:(glob)${prefix}${directoryName}/**`;
}

function stripManagedExcludeBlock(contents: string): string {
  const lines = contents.split(/\r?\n/);
  const kept: string[] = [];
  let insideManagedBlock = false;

  for (const line of lines) {
    if (!insideManagedBlock && line === LOCAL_EXCLUDE_BEGIN) {
      insideManagedBlock = true;
      continue;
    }

    if (insideManagedBlock) {
      if (line === LOCAL_EXCLUDE_END) {
        insideManagedBlock = false;
      }
      continue;
    }

    kept.push(line);
  }

  return kept.join("\n").trim();
}

function renderManagedExcludeBlock(entries: string[]): string {
  return [LOCAL_EXCLUDE_BEGIN, ...entries, LOCAL_EXCLUDE_END].join("\n");
}

export async function getManagedLocalExcludeEntries(repositoryRoot: string): Promise<string[]> {
  const excludePath = resolveGitPath(repositoryRoot, "info/exclude");
  let contents: string;
  try {
    contents = await fs.readFile(excludePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const lines = contents.split(/\r?\n/);
  const begin = lines.indexOf(LOCAL_EXCLUDE_BEGIN);
  const end = begin === -1 ? -1 : lines.indexOf(LOCAL_EXCLUDE_END, begin + 1);
  return begin !== -1 && end !== -1 ? lines.slice(begin + 1, end) : [];
}

export function resolveRepositoryRoot(startPath: string): string {
  return runGit(["rev-parse", "--show-toplevel"], { cwd: startPath });
}

export function assertSingleWorktree(repositoryRoot: string): void {
  const worktreeCount = runGitRaw(["worktree", "list", "--porcelain"], { cwd: repositoryRoot })
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .length;
  if (worktreeCount > 1) {
    throw new Error(
      "Adocs override and restore are disabled while linked Git worktrees exist because .git/info/exclude is shared. Remove or prune the linked worktrees first.",
    );
  }
}

export function resolveGitPath(repositoryRoot: string, gitPath: string): string {
  return path.resolve(repositoryRoot, runGit(["rev-parse", "--git-path", gitPath], { cwd: repositoryRoot }));
}

export function getScopePath(repositoryRoot: string, root: string): string {
  const relativePath = path.relative(repositoryRoot, root);
  if (relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new Error(`Target directory must be inside the Git repository: ${root}`);
  }
  return toPosixPath(relativePath || ".");
}

export function listTrackedInstructionFiles(repositoryRoot: string, scopePath = ".", includeExcluded = true): string[] {
  return listTrackedPaths(repositoryRoot, TRACKED_INSTRUCTION_PATHSPECS)
    .filter(isInstructionFilePath)
    .filter((filePath) => isWithinScope(filePath, scopePath))
    .filter((filePath) => includeExcluded || !hasExcludedDirectory(filePath))
}

export function listTrackedOverrideDirectoryFiles(
  repositoryRoot: string,
  scopePath: string,
  directoryName: string,
): string[] {
  return listTrackedPaths(repositoryRoot, [getOverrideDirectoryPathspec(scopePath, directoryName)]);
}

export function listTrackedArtifactFiles(
  repositoryRoot: string,
  scopePath: string,
  artifacts: readonly ManagedArtifact[],
): string[] {
  const pathspecs = artifacts.map((artifact) => {
    const artifactPath = scopedArtifactPath(scopePath, artifact.path);
    return artifact.kind === "directory" ? `:(glob)${artifactPath}/**` : artifactPath;
  });
  return listTrackedPaths(repositoryRoot, pathspecs);
}

export function listTrackedFiles(repositoryRoot: string, filePaths: string[]): string[] {
  return listTrackedPaths(repositoryRoot, filePaths.map((filePath) => `:(literal)${filePath}`));
}

export function listSkipWorktreeFiles(repositoryRoot: string, filePaths: string[]): string[] {
  if (filePaths.length === 0) {
    return [];
  }

  const output = runGitRaw(["ls-files", "-v", "-z", "--", ...filePaths.map((filePath) => `:(literal)${filePath}`)], {
    cwd: repositoryRoot,
  });
  return output
    .split("\0")
    .filter((entry) => entry.slice(0, 1).toUpperCase() === "S" && entry.slice(1, 2) === " ")
    .map((entry) => toPosixPath(entry.slice(2)))
    .sort();
}

export function listAssumeUnchangedFiles(repositoryRoot: string, filePaths: string[]): string[] {
  if (filePaths.length === 0) {
    return [];
  }
  const output = runGitRaw(["ls-files", "-v", "-z", "--", ...filePaths.map((filePath) => `:(literal)${filePath}`)], {
    cwd: repositoryRoot,
  });
  return output
    .split("\0")
    .filter((entry) => /^[a-z] /.test(entry))
    .map((entry) => toPosixPath(entry.slice(2)))
    .sort();
}

export function listModifiedFiles(repositoryRoot: string, filePaths: string[]): string[] {
  if (filePaths.length === 0) {
    return [];
  }
  const output = runGitRaw([
    "diff",
    "--name-only",
    "-z",
    "HEAD",
    "--",
    ...filePaths.map((filePath) => `:(literal)${filePath}`),
  ], { cwd: repositoryRoot });
  return output.split("\0").filter(Boolean).map(toPosixPath).sort();
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

  runGit(["restore", "--source=HEAD", "--worktree", "--", ...filePaths], { cwd: repositoryRoot });
}

export async function removePaths(repositoryRoot: string, filePaths: string[]): Promise<void> {
  await Promise.all(
    filePaths.map((filePath) => fs.rm(path.join(repositoryRoot, filePath), { force: true, recursive: true })),
  );
}

export async function setManagedLocalExcludeEntries(repositoryRoot: string, entries: string[]): Promise<void> {
  const excludePath = resolveGitPath(repositoryRoot, "info/exclude");
  let currentContents = "";

  try {
    currentContents = await fs.readFile(excludePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const retainedContents = stripManagedExcludeBlock(currentContents);
  const uniqueEntries = [...new Set(entries)];
  const managedBlock = uniqueEntries.length > 0 ? renderManagedExcludeBlock(uniqueEntries) : "";
  const nextContents = retainedContents && managedBlock
    ? `${retainedContents}\n\n${managedBlock}\n`
    : retainedContents
      ? `${retainedContents}\n`
      : managedBlock
        ? `${managedBlock}\n`
        : "";

  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  await fs.writeFile(excludePath, nextContents, "utf8");
}
