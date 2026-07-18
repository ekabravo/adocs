import fs from "node:fs/promises";
import path from "node:path";
import {
  assertSingleWorktree,
  clearSkipWorktree,
  getManagedLocalExcludeEntries,
  getScopePath,
  listTrackedFiles,
  listTrackedInstructionFiles,
  listTrackedOverrideDirectoryFiles,
  listSkipWorktreeFiles,
  markSkipWorktree,
  resolveRepositoryRoot,
  restoreTrackedFiles,
  setManagedLocalExcludeEntries,
} from "./git";
import {
  combineExcludeEntries,
  listOverrideStates,
  readOverrideState,
  removeOverrideState,
  type OverrideState,
} from "./state";
import { assertNoSymlinkParents, assertPathInside } from "./path-safety";

export type RestoreOptions = {
  root: string;
  dryRun?: boolean;
};

export type RestoreResult = {
  dryRun: boolean;
  legacy: boolean;
  repositoryRoot: string;
  restoredTargets: string[];
  removedOverridePaths: string[];
  preservedSkipWorktreeTargets: string[];
  excludeEntries: string[];
};

type RestorePlan = RestoreResult & {
  root: string;
  scopePath: string;
  state?: OverrideState;
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

async function existingPaths(paths: string[]): Promise<string[]> {
  const results = await Promise.all(paths.map(async (candidate) => (await pathExists(candidate)) ? candidate : undefined));
  return results.filter((candidate): candidate is string => candidate !== undefined).sort();
}

async function planStateRestore(
  root: string,
  repositoryRoot: string,
  scopePath: string,
  state: OverrideState,
  dryRun: boolean,
): Promise<RestorePlan> {
  const currentlyTracked = listTrackedFiles(repositoryRoot, state.trackedTargets);
  const restoredTargets = [...new Set(currentlyTracked)].sort();
  const writtenPaths = state.writtenPaths.map((writtenPath) => path.resolve(repositoryRoot, writtenPath));
  for (const writtenPath of writtenPaths) {
    assertPathInside(root, writtenPath);
    await assertNoSymlinkParents(root, writtenPath);
  }
  const removedOverridePaths = await existingPaths(writtenPaths);
  const remainingStates = (await listOverrideStates(repositoryRoot)).filter((candidate) => candidate.scopePath !== scopePath);

  return {
    dryRun,
    legacy: false,
    root,
    scopePath,
    state,
    repositoryRoot,
    restoredTargets,
    removedOverridePaths,
    preservedSkipWorktreeTargets: state.preexistingSkipWorktreeTargets.filter((target) => restoredTargets.includes(target)),
    excludeEntries: combineExcludeEntries(remainingStates),
  };
}

async function planLegacyRestore(
  root: string,
  repositoryRoot: string,
  scopePath: string,
  dryRun: boolean,
): Promise<RestorePlan> {
  const prefix = scopePath && scopePath !== "." ? `${scopePath}/` : "";
  const managedEntries = new Set(await getManagedLocalExcludeEntries(repositoryRoot));
  const hasLegacyMarker = managedEntries.has(`${prefix}.claude/`)
    && managedEntries.has(`${prefix}.codex/`)
    && managedEntries.has(`${prefix}AGENTS.md`)
    && managedEntries.has(`${prefix}CLAUDE.md`);
  if (!hasLegacyMarker) {
    throw new Error(`No active adocs override found under ${root}`);
  }

  const instructionTargets = listTrackedInstructionFiles(repositoryRoot, scopePath, true);
  if (instructionTargets.length === 0) {
    throw new Error(`No tracked instruction files found under ${root}`);
  }

  const directoryTargets = [".claude", ".codex"].flatMap((directoryName) =>
    listTrackedOverrideDirectoryFiles(repositoryRoot, scopePath, directoryName),
  );
  const restoredTargets = [...new Set([...instructionTargets, ...directoryTargets])].sort();
  const legacySkipWorktreeTargets = new Set(listSkipWorktreeFiles(repositoryRoot, restoredTargets));
  if (!restoredTargets.every((target) => legacySkipWorktreeTargets.has(target))) {
    throw new Error(
      "Legacy adocs markers were found, but the current Git index does not identify a complete legacy override. Refusing destructive restore.",
    );
  }
  const removalCandidates = ["AGENTS.md", "CLAUDE.md", ".claude", ".codex"]
    .map((name) => path.join(root, name));
  const states = await listOverrideStates(repositoryRoot);

  return {
    dryRun,
    legacy: true,
    root,
    scopePath,
    repositoryRoot,
    restoredTargets,
    removedOverridePaths: await existingPaths(removalCandidates),
    preservedSkipWorktreeTargets: [],
    excludeEntries: combineExcludeEntries(states),
  };
}

export async function planRestore(options: RestoreOptions): Promise<RestorePlan> {
  const root = await fs.realpath(path.resolve(options.root));
  const repositoryRoot = resolveRepositoryRoot(root);
  assertSingleWorktree(repositoryRoot);
  const scopePath = getScopePath(repositoryRoot, root);
  const state = await readOverrideState(repositoryRoot, scopePath);
  return state
    ? planStateRestore(root, repositoryRoot, scopePath, state, options.dryRun ?? false)
    : planLegacyRestore(root, repositoryRoot, scopePath, options.dryRun ?? false);
}

function publicResult(plan: RestorePlan): RestoreResult {
  const { root: _root, scopePath: _scopePath, state: _state, ...result } = plan;
  return result;
}

export async function restoreOverride(options: RestoreOptions): Promise<RestoreResult> {
  const plan = await planRestore(options);
  if (plan.dryRun) {
    return publicResult(plan);
  }

  clearSkipWorktree(plan.repositoryRoot, plan.restoredTargets);
  for (const overridePath of plan.removedOverridePaths) {
    await fs.rm(overridePath, { force: true, recursive: true });
  }
  restoreTrackedFiles(plan.repositoryRoot, plan.restoredTargets);
  markSkipWorktree(plan.repositoryRoot, plan.preservedSkipWorktreeTargets);

  if (plan.state) {
    await removeOverrideState(plan.repositoryRoot, plan.scopePath);
  }
  await setManagedLocalExcludeEntries(plan.repositoryRoot, plan.excludeEntries);

  return publicResult(plan);
}
