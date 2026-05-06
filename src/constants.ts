export const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
export const SOURCE_OVERRIDE_FILE_NAME = "AGENTS.md" as const;
export const OVERRIDE_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;
export const OVERRIDE_DIRECTORY_NAMES = [".claude", ".codex"] as const;
export const LOCAL_EXCLUDE_BEGIN = "# adocs local overrides: begin" as const;
export const LOCAL_EXCLUDE_END = "# adocs local overrides: end" as const;

export const DEFAULT_EXCLUDED_DIRECTORIES = [".git", "node_modules"] as const;

export type InstructionFileName = (typeof INSTRUCTION_FILES)[number];
export type OverrideDirectoryName = (typeof OVERRIDE_DIRECTORY_NAMES)[number];
