import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveGitPath } from "./git";

export const OVERRIDE_STATE_VERSION = 1 as const;

export type OverrideState = {
  version: typeof OVERRIDE_STATE_VERSION;
  scopePath: string;
  trackedTargets: string[];
  preexistingSkipWorktreeTargets: string[];
  writtenPaths: string[];
  excludeEntries: string[];
};

function getStateDirectory(repositoryRoot: string): string {
  return resolveGitPath(repositoryRoot, "adocs");
}

function getStateFileName(scopePath: string): string {
  const digest = createHash("sha256").update(scopePath).digest("hex").slice(0, 16);
  return `${digest}.json`;
}

export function getOverrideStatePath(repositoryRoot: string, scopePath: string): string {
  return path.join(getStateDirectory(repositoryRoot), getStateFileName(scopePath));
}

function isOverrideState(value: unknown): value is OverrideState {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<OverrideState>;
  const validStrings = (entries: unknown): entries is string[] => Array.isArray(entries)
    && entries.every((entry) => typeof entry === "string" && !/[\r\n]/.test(entry));
  return candidate.version === OVERRIDE_STATE_VERSION
    && typeof candidate.scopePath === "string"
    && !/[\r\n]/.test(candidate.scopePath)
    && validStrings(candidate.trackedTargets)
    && validStrings(candidate.preexistingSkipWorktreeTargets)
    && validStrings(candidate.writtenPaths)
    && validStrings(candidate.excludeEntries);
}

async function readStateFile(filePath: string): Promise<OverrideState | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (!isOverrideState(parsed)) {
      throw new Error(`Unsupported adocs override state: ${filePath}`);
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function readOverrideState(repositoryRoot: string, scopePath: string): Promise<OverrideState | undefined> {
  const state = await readStateFile(getOverrideStatePath(repositoryRoot, scopePath));
  if (state && state.scopePath !== scopePath) {
    throw new Error(`Adocs override state scope mismatch: expected ${scopePath}, found ${state.scopePath}`);
  }
  return state;
}

export async function listOverrideStates(repositoryRoot: string): Promise<OverrideState[]> {
  const directory = getStateDirectory(repositoryRoot);
  let names: string[];

  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const states = await Promise.all(
    names.filter((name) => name.endsWith(".json")).map((name) => readStateFile(path.join(directory, name))),
  );
  return states.filter((state): state is OverrideState => state !== undefined);
}

export async function writeOverrideState(repositoryRoot: string, state: OverrideState): Promise<void> {
  const filePath = getOverrideStatePath(repositoryRoot, state.scopePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}

export async function removeOverrideState(repositoryRoot: string, scopePath: string): Promise<void> {
  const filePath = getOverrideStatePath(repositoryRoot, scopePath);
  await fs.rm(filePath, { force: true });

  try {
    await fs.rmdir(path.dirname(filePath));
  } catch (error) {
    if (!(["ENOENT", "ENOTEMPTY"] as string[]).includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw error;
    }
  }
}

export function combineExcludeEntries(states: OverrideState[]): string[] {
  return [...new Set(states.flatMap((state) => state.excludeEntries))].sort();
}
