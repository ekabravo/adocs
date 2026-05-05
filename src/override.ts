import fs from "node:fs/promises";
import path from "node:path";
import { OVERRIDE_FILE_NAME } from "./constants";
import {
  getScopePath,
  listTrackedInstructionFiles,
  markSkipWorktree,
  removeFiles,
  resolveRepositoryRoot,
} from "./git";

export type OverrideOptions = {
  root: string;
  source: string;
  includeExcluded?: boolean;
};

export type OverrideResult = {
  repositoryRoot: string;
  targets: string[];
  writtenFiles: string[];
};

export async function applyOverride(options: OverrideOptions): Promise<OverrideResult> {
  const root = path.resolve(options.root);
  const repositoryRoot = resolveRepositoryRoot(root);
  const scopePath = getScopePath(repositoryRoot, root);
  const targets = listTrackedInstructionFiles(repositoryRoot, scopePath, options.includeExcluded ?? false);

  if (targets.length === 0) {
    throw new Error(`No tracked instruction files found under ${root}`);
  }

  const sourcePath = path.resolve(options.source);
  const contents = await fs.readFile(sourcePath, "utf8");

  await removeFiles(repositoryRoot, targets);
  markSkipWorktree(repositoryRoot, targets);

  const destination = path.join(root, OVERRIDE_FILE_NAME);
  await fs.writeFile(destination, contents, "utf8");

  return {
    repositoryRoot,
    targets,
    writtenFiles: [destination],
  };
}
