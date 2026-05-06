import fs from "node:fs/promises";
import path from "node:path";
import { OVERRIDE_DIRECTORY_NAMES, OVERRIDE_FILE_NAMES } from "./constants";
import {
  clearSkipWorktree,
  getScopePath,
  getTrackedRootInstructionNames,
  listTrackedInstructionFiles,
  listTrackedOverrideDirectoryFiles,
  resolveRepositoryRoot,
  restoreTrackedFiles,
  setManagedLocalExcludeEntries,
} from "./git";

export type RestoreOptions = {
  root: string;
};

export type RestoreResult = {
  repositoryRoot: string;
  restoredTargets: string[];
  removedOverridePaths: string[];
};

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function restoreOverride(options: RestoreOptions): Promise<RestoreResult> {
  const root = path.resolve(options.root);
  const repositoryRoot = resolveRepositoryRoot(root);
  const scopePath = getScopePath(repositoryRoot, root);
  const instructionTargets = listTrackedInstructionFiles(repositoryRoot, scopePath, true);

  if (instructionTargets.length === 0) {
    throw new Error(`No tracked instruction files found under ${root}`);
  }

  const directoryTargets = OVERRIDE_DIRECTORY_NAMES.flatMap((directoryName) =>
    listTrackedOverrideDirectoryFiles(repositoryRoot, scopePath, directoryName),
  );
  const restoredTargets = [...new Set([...instructionTargets, ...directoryTargets])].sort();

  clearSkipWorktree(repositoryRoot, restoredTargets);
  restoreTrackedFiles(repositoryRoot, restoredTargets);

  const trackedRootNames = new Set(getTrackedRootInstructionNames(instructionTargets, scopePath));
  const removedOverridePaths: string[] = [];

  for (const fileName of OVERRIDE_FILE_NAMES) {
    if (!trackedRootNames.has(fileName)) {
      const overridePath = path.join(root, fileName);
      if (await pathExists(overridePath)) {
        await fs.rm(overridePath);
        removedOverridePaths.push(overridePath);
      }
    }
  }

  for (const directoryName of OVERRIDE_DIRECTORY_NAMES) {
    const trackedDirectoryTargets = listTrackedOverrideDirectoryFiles(repositoryRoot, scopePath, directoryName);
    if (trackedDirectoryTargets.length === 0) {
      const overridePath = path.join(root, directoryName);
      if (await pathExists(overridePath)) {
        await fs.rm(overridePath, { force: true, recursive: true });
        removedOverridePaths.push(overridePath);
      }
    }
  }

  await setManagedLocalExcludeEntries(repositoryRoot, []);

  return {
    repositoryRoot,
    restoredTargets,
    removedOverridePaths,
  };
}
