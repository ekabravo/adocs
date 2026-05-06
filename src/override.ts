import fs from "node:fs/promises";
import path from "node:path";
import {
  OVERRIDE_DIRECTORY_NAMES,
  OVERRIDE_FILE_NAMES,
  SOURCE_OVERRIDE_FILE_NAME,
} from "./constants";
import {
  getScopePath,
  listTrackedInstructionFiles,
  listTrackedOverrideDirectoryFiles,
  markSkipWorktree,
  removePaths,
  resolveRepositoryRoot,
  setManagedLocalExcludeEntries,
} from "./git";

export type OverrideOptions = {
  root: string;
  source: string;
  includeExcluded?: boolean;
};

export type OverrideResult = {
  repositoryRoot: string;
  targets: string[];
  skippedTargets: string[];
  removedPaths: string[];
  writtenPaths: string[];
};

type SourceArtifacts = {
  directoryNames: string[];
  instructionContents?: string;
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

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      throw new Error(`Expected a file at ${filePath}`);
    }
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function directoryExists(directoryPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(directoryPath);
    if (!stats.isDirectory()) {
      throw new Error(`Expected a directory at ${directoryPath}`);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function loadSourceArtifacts(sourceRoot: string): Promise<SourceArtifacts> {
  const instructionContents = await readOptionalFile(path.join(sourceRoot, SOURCE_OVERRIDE_FILE_NAME));
  const directoryNames: string[] = [];

  for (const directoryName of OVERRIDE_DIRECTORY_NAMES) {
    if (await directoryExists(path.join(sourceRoot, directoryName))) {
      directoryNames.push(directoryName);
    }
  }

  return {
    directoryNames,
    instructionContents,
  };
}

async function resolveSourceDirectory(source: string): Promise<string> {
  const sourcePath = path.resolve(source);

  let stats;
  try {
    stats = await fs.stat(sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Source directory does not exist: ${sourcePath}`);
    }
    throw error;
  }

  if (!stats.isDirectory()) {
    throw new Error(`Source must be a directory: ${sourcePath}`);
  }

  return sourcePath;
}

async function removeManagedRootArtifacts(root: string): Promise<string[]> {
  const removedPaths: string[] = [];

  for (const name of [...OVERRIDE_FILE_NAMES, ...OVERRIDE_DIRECTORY_NAMES]) {
    const targetPath = path.join(root, name);
    if (await pathExists(targetPath)) {
      await fs.rm(targetPath, { force: true, recursive: true });
      removedPaths.push(targetPath);
    }
  }

  return removedPaths;
}

function getLocalExcludeEntries(scopePath: string): string[] {
  const prefix = scopePath && scopePath !== "." ? `${scopePath}/` : "";
  return [
    ...OVERRIDE_FILE_NAMES.map((name) => `${prefix}${name}`),
    ...OVERRIDE_DIRECTORY_NAMES.map((name) => `${prefix}${name}/`),
  ];
}

export async function applyOverride(options: OverrideOptions): Promise<OverrideResult> {
  const root = path.resolve(options.root);
  const repositoryRoot = resolveRepositoryRoot(root);
  const scopePath = getScopePath(repositoryRoot, root);
  const targets = listTrackedInstructionFiles(repositoryRoot, scopePath, options.includeExcluded ?? false);

  if (targets.length === 0) {
    throw new Error(`No tracked instruction files found under ${root}`);
  }

  const sourceRoot = await resolveSourceDirectory(options.source);
  const sourceArtifacts = await loadSourceArtifacts(sourceRoot);
  const skippedTargets = [...new Set([
    ...targets,
    ...OVERRIDE_DIRECTORY_NAMES.flatMap((directoryName) =>
      listTrackedOverrideDirectoryFiles(repositoryRoot, scopePath, directoryName),
    ),
  ])].sort();

  await removePaths(repositoryRoot, skippedTargets);
  markSkipWorktree(repositoryRoot, skippedTargets);

  const removedPaths = await removeManagedRootArtifacts(root);
  const writtenPaths: string[] = [];

  if (sourceArtifacts.instructionContents !== undefined) {
    for (const fileName of OVERRIDE_FILE_NAMES) {
      const destination = path.join(root, fileName);
      await fs.writeFile(destination, sourceArtifacts.instructionContents, "utf8");
      writtenPaths.push(destination);
    }
  }

  for (const directoryName of sourceArtifacts.directoryNames) {
    const sourceDirectory = path.join(sourceRoot, directoryName);
    const destinationDirectory = path.join(root, directoryName);
    await fs.cp(sourceDirectory, destinationDirectory, { recursive: true });
    writtenPaths.push(destinationDirectory);
  }

  await setManagedLocalExcludeEntries(repositoryRoot, getLocalExcludeEntries(scopePath));

  return {
    repositoryRoot,
    targets,
    skippedTargets,
    removedPaths,
    writtenPaths,
  };
}
