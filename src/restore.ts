import fs from "node:fs/promises";
import path from "node:path";
import { OVERRIDE_FILE_NAME } from "./constants";
import {
  clearSkipWorktree,
  getScopePath,
  getTrackedRootInstructionNames,
  listTrackedInstructionFiles,
  resolveRepositoryRoot,
  restoreTrackedFiles,
} from "./git";

export type RestoreOptions = {
  root: string;
};

export type RestoreResult = {
  repositoryRoot: string;
  restoredTargets: string[];
  removedOverrideFiles: string[];
};

export async function restoreOverride(options: RestoreOptions): Promise<RestoreResult> {
  const root = path.resolve(options.root);
  const repositoryRoot = resolveRepositoryRoot(root);
  const scopePath = getScopePath(repositoryRoot, root);
  const restoredTargets = listTrackedInstructionFiles(repositoryRoot, scopePath, true);

  if (restoredTargets.length === 0) {
    throw new Error(`No tracked instruction files found under ${root}`);
  }

  clearSkipWorktree(repositoryRoot, restoredTargets);
  restoreTrackedFiles(repositoryRoot, restoredTargets);

  const trackedRootNames = new Set(getTrackedRootInstructionNames(restoredTargets, scopePath));
  const removedOverrideFiles: string[] = [];

  if (!trackedRootNames.has(OVERRIDE_FILE_NAME)) {
    const overridePath = path.join(root, OVERRIDE_FILE_NAME);
    try {
      await fs.rm(overridePath);
      removedOverrideFiles.push(overridePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  return {
    repositoryRoot,
    restoredTargets,
    removedOverrideFiles,
  };
}
