import fs from "node:fs/promises";
import path from "node:path";
import { MANAGED_ARTIFACTS, type ManagedArtifact } from "./artifacts";
import {
  OVERRIDE_FILE_NAMES,
  SOURCE_OVERRIDE_FILE_NAME,
} from "./constants";
import {
  assertSingleWorktree,
  getManagedLocalExcludeEntries,
  getScopePath,
  listAssumeUnchangedFiles,
  listModifiedFiles,
  listSkipWorktreeFiles,
  listTrackedArtifactFiles,
  listTrackedFiles,
  listTrackedInstructionFiles,
  markSkipWorktree,
  removePaths,
  resolveRepositoryRoot,
  setManagedLocalExcludeEntries,
} from "./git";
import {
  OVERRIDE_STATE_VERSION,
  combineExcludeEntries,
  getOverrideStatePath,
  listOverrideStates,
  readOverrideState,
  writeOverrideState,
  type OverrideState,
} from "./state";
import { assertNoSymlinkParents } from "./path-safety";

export type OverrideOptions = {
  root: string;
  source: string;
  includeExcluded?: boolean;
  dryRun?: boolean;
};

export type OverrideResult = {
  dryRun: boolean;
  repositoryRoot: string;
  targets: string[];
  skippedTargets: string[];
  removedPaths: string[];
  writtenPaths: string[];
  preservedPaths: string[];
  conflictingSkipWorktreeTargets: string[];
  conflictingAssumeUnchangedTargets: string[];
  modifiedTargets: string[];
  excludeEntries: string[];
  statePath: string;
};

type SourceArtifact = {
  artifact: ManagedArtifact;
  sourcePath: string;
  destinationPath: string;
};

type OverridePlan = OverrideResult & {
  root: string;
  scopePath: string;
  sourceRoot: string;
  sourceInstructionContents?: string;
  sourceArtifacts: SourceArtifact[];
  preexistingSkipWorktreeTargets: string[];
  managedRemovalPaths: string[];
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
  return fs.realpath(sourcePath);
}

function isSameOrNested(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function getSourceArtifacts(sourceRoot: string, root: string): Promise<SourceArtifact[]> {
  const artifacts: SourceArtifact[] = [];

  for (const artifact of MANAGED_ARTIFACTS) {
    const sourcePath = path.join(sourceRoot, artifact.path);
    if (!(await pathExists(sourcePath))) {
      continue;
    }

    const stats = await fs.stat(sourcePath);
    if (artifact.kind === "file" && !stats.isFile()) {
      throw new Error(`Expected a file at ${sourcePath}`);
    }
    if (artifact.kind === "directory" && !stats.isDirectory()) {
      throw new Error(`Expected a directory at ${sourcePath}`);
    }

    artifacts.push({ artifact, sourcePath, destinationPath: path.join(root, artifact.path) });
  }
  return artifacts;
}

function getLocalExcludeEntries(scopePath: string): string[] {
  const prefix = scopePath && scopePath !== "." ? `${scopePath}/` : "";
  return [
    ...OVERRIDE_FILE_NAMES.map((name) => `${prefix}${name}`),
    ...MANAGED_ARTIFACTS.map((artifact) => {
      const suffix = artifact.kind === "directory" ? "/" : "";
      return `${prefix}${artifact.path}${suffix}`;
    }),
  ];
}

async function listExistingManagedPaths(root: string): Promise<string[]> {
  const candidates = [
    ...OVERRIDE_FILE_NAMES.map((name) => path.join(root, name)),
    ...MANAGED_ARTIFACTS.map((artifact) => path.join(root, artifact.path)),
  ];
  const existing = await Promise.all(candidates.map(async (candidate) => (await pathExists(candidate)) ? candidate : undefined));
  return [...new Set(existing.filter((candidate): candidate is string => candidate !== undefined))].sort();
}

async function listPreservedContextPaths(root: string): Promise<string[]> {
  const candidates = [
    ".claude/settings.local.json",
    ".claude/agent-memory-local",
    "CLAUDE.local.md",
    ".worktreeinclude",
  ].map((name) => path.join(root, name));
  const existing = await Promise.all(candidates.map(async (candidate) => (await pathExists(candidate)) ? candidate : undefined));
  return existing.filter((candidate): candidate is string => candidate !== undefined).sort();
}

async function assertNoLegacyOverride(repositoryRoot: string): Promise<void> {
  const entries = await getManagedLocalExcludeEntries(repositoryRoot);
  if (entries.some((entry) => /(^|\/)\.(?:claude|codex)\/$/.test(entry))) {
    throw new Error("A legacy adocs override is active. Run `adocs restore` before applying a new override.");
  }
}

function scopesOverlap(left: string, right: string): boolean {
  if (left === "." || right === ".") return true;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export async function planOverride(options: OverrideOptions): Promise<OverridePlan> {
  const root = await fs.realpath(path.resolve(options.root));
  const repositoryRoot = resolveRepositoryRoot(root);
  assertSingleWorktree(repositoryRoot);
  const scopePath = getScopePath(repositoryRoot, root);
  const sourceRoot = await resolveSourceDirectory(options.source);

  if (sourceRoot === root) {
    throw new Error("Source directory must not be the target directory");
  }
  for (const artifact of MANAGED_ARTIFACTS) {
    if (isSameOrNested(sourceRoot, path.join(root, artifact.path))) {
      throw new Error(`Source directory is inside a managed target: ${sourceRoot}`);
    }
    await assertNoSymlinkParents(root, path.join(root, artifact.path));
  }

  await assertNoLegacyOverride(repositoryRoot);
  const activeStates = await listOverrideStates(repositoryRoot);
  const overlappingState = activeStates.find((state) => state.scopePath !== scopePath && scopesOverlap(state.scopePath, scopePath));
  if (overlappingState) {
    throw new Error(
      `Target scope overlaps active adocs override '${overlappingState.scopePath}'. Restore it before overriding '${scopePath}'.`,
    );
  }
  const targets = listTrackedInstructionFiles(repositoryRoot, scopePath, options.includeExcluded ?? false);
  const artifactTargets = listTrackedArtifactFiles(repositoryRoot, scopePath, MANAGED_ARTIFACTS);
  const existingState = await readOverrideState(repositoryRoot, scopePath);
  const skippedCandidates = [...new Set([
    ...targets,
    ...artifactTargets,
    ...(existingState?.trackedTargets ?? []),
  ])].sort();
  const skippedTargets = listTrackedFiles(repositoryRoot, skippedCandidates);

  if (skippedTargets.length === 0) {
    throw new Error(`No tracked project instruction or agent configuration files found under ${root}`);
  }

  const sourceRelativeToRepository = path.relative(repositoryRoot, sourceRoot).split(path.sep).join("/");
  const sourceIsInsideRepository = sourceRelativeToRepository !== ".."
    && !sourceRelativeToRepository.startsWith("../")
    && !path.isAbsolute(sourceRelativeToRepository);
  if (sourceIsInsideRepository && skippedTargets.some((target) =>
    target === sourceRelativeToRepository || target.startsWith(`${sourceRelativeToRepository}/`))) {
    throw new Error(`Source directory contains tracked files that the override would remove: ${sourceRoot}`);
  }

  const sourceInstructionContents = await readOptionalFile(path.join(sourceRoot, SOURCE_OVERRIDE_FILE_NAME));
  const sourceArtifacts = await getSourceArtifacts(sourceRoot, root);
  const managedRemovalPaths = await listExistingManagedPaths(root);
  const removedPaths = [...new Set([
    ...skippedTargets.map((target) => path.join(repositoryRoot, target)),
    ...managedRemovalPaths,
  ])].sort();
  const writtenPaths = [
    ...(sourceInstructionContents === undefined ? [] : OVERRIDE_FILE_NAMES.map((name) => path.join(root, name))),
    ...sourceArtifacts.map(({ destinationPath }) => destinationPath),
  ].sort();
  const excludeEntries = getLocalExcludeEntries(scopePath);
  const detectedSkipWorktreeTargets = listSkipWorktreeFiles(repositoryRoot, skippedTargets);
  const conflictingSkipWorktreeTargets = existingState ? [] : detectedSkipWorktreeTargets;
  const conflictingAssumeUnchangedTargets = existingState ? [] : listAssumeUnchangedFiles(repositoryRoot, skippedTargets);
  const modifiedTargets = existingState ? [] : listModifiedFiles(repositoryRoot, skippedTargets);

  return {
    dryRun: options.dryRun ?? false,
    root,
    scopePath,
    sourceRoot,
    repositoryRoot,
    targets,
    skippedTargets,
    removedPaths,
    writtenPaths,
    preservedPaths: await listPreservedContextPaths(root),
    conflictingSkipWorktreeTargets,
    conflictingAssumeUnchangedTargets,
    modifiedTargets,
    excludeEntries,
    statePath: getOverrideStatePath(repositoryRoot, scopePath),
    sourceInstructionContents,
    sourceArtifacts,
    preexistingSkipWorktreeTargets: existingState?.preexistingSkipWorktreeTargets ?? [],
    managedRemovalPaths,
  };
}

function publicResult(plan: OverridePlan): OverrideResult {
  const {
    root: _root,
    scopePath: _scopePath,
    sourceRoot: _sourceRoot,
    sourceInstructionContents: _contents,
    sourceArtifacts: _artifacts,
    preexistingSkipWorktreeTargets: _preexisting,
    managedRemovalPaths: _managedRemovalPaths,
    ...result
  } = plan;
  return result;
}

export async function applyOverride(options: OverrideOptions): Promise<OverrideResult> {
  const plan = await planOverride(options);
  if (plan.dryRun) {
    return publicResult(plan);
  }
  if (plan.conflictingSkipWorktreeTargets.length > 0) {
    throw new Error(
      `Refusing to overwrite pre-existing skip-worktree files: ${plan.conflictingSkipWorktreeTargets.join(", ")}`,
    );
  }
  if (plan.conflictingAssumeUnchangedTargets.length > 0) {
    throw new Error(
      `Refusing to overwrite assume-unchanged files: ${plan.conflictingAssumeUnchangedTargets.join(", ")}`,
    );
  }
  if (plan.modifiedTargets.length > 0) {
    throw new Error(`Refusing to overwrite modified tracked files: ${plan.modifiedTargets.join(", ")}`);
  }

  const state: OverrideState = {
    version: OVERRIDE_STATE_VERSION,
    scopePath: plan.scopePath,
    trackedTargets: plan.skippedTargets,
    preexistingSkipWorktreeTargets: plan.preexistingSkipWorktreeTargets,
    writtenPaths: [...new Set([
      ...(await readOverrideState(plan.repositoryRoot, plan.scopePath))?.writtenPaths ?? [],
      ...plan.writtenPaths.map((writtenPath) => path.relative(plan.repositoryRoot, writtenPath).split(path.sep).join("/")),
    ])].sort(),
    excludeEntries: plan.excludeEntries,
  };
  await writeOverrideState(plan.repositoryRoot, state);

  await removePaths(plan.repositoryRoot, plan.skippedTargets);
  markSkipWorktree(plan.repositoryRoot, plan.skippedTargets);

  for (const targetPath of plan.managedRemovalPaths) {
    await fs.rm(targetPath, { force: true, recursive: true });
  }

  if (plan.sourceInstructionContents !== undefined) {
    for (const fileName of OVERRIDE_FILE_NAMES) {
      await fs.writeFile(path.join(plan.root, fileName), plan.sourceInstructionContents, "utf8");
    }
  }

  for (const { artifact, sourcePath, destinationPath } of plan.sourceArtifacts) {
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    if (artifact.kind === "directory") {
      await fs.cp(sourcePath, destinationPath, { recursive: true });
    } else {
      await fs.copyFile(sourcePath, destinationPath);
    }
  }

  const states = await listOverrideStates(plan.repositoryRoot);
  await setManagedLocalExcludeEntries(plan.repositoryRoot, combineExcludeEntries(states));
  return publicResult(plan);
}
