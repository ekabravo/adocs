import fg from "fast-glob";
import path from "node:path";
import { DEFAULT_EXCLUDED_DIRECTORIES, INSTRUCTION_FILES, type InstructionFileName } from "./constants";

export type DiscoverOptions = {
  includeExcluded?: boolean;
};

const GLOB_PATTERNS = INSTRUCTION_FILES.flatMap((name) => [name, `**/${name}`]);

export function isInstructionFilePath(filePath: string): boolean {
  return INSTRUCTION_FILES.includes(path.basename(filePath) as InstructionFileName);
}

export function hasExcludedDirectory(filePath: string, excludedDirectories = [...DEFAULT_EXCLUDED_DIRECTORIES]): boolean {
  const normalizedPath = filePath.split(path.sep).join("/");
  const segments = normalizedPath.split("/");
  return segments.some((segment) => excludedDirectories.includes(segment));
}

export async function discoverInstructionFiles(root: string, options: DiscoverOptions = {}): Promise<string[]> {
  const matches = await fg(GLOB_PATTERNS, {
    cwd: root,
    dot: true,
    followSymbolicLinks: false,
    onlyFiles: true,
    unique: true,
  });

  const results = matches
    .map((match) => match.split(path.sep).join("/"))
    .filter((match) => options.includeExcluded || !hasExcludedDirectory(match))
    .sort();

  return results;
}
