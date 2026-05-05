export const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
export const OVERRIDE_FILE_NAME = "AGENTS.md" as const;

export const DEFAULT_EXCLUDED_DIRECTORIES = [".git", "node_modules"] as const;

export type InstructionFileName = (typeof INSTRUCTION_FILES)[number];
