export type ArtifactKind = "file" | "directory";
export type ArtifactProvider = "claude" | "codex";

export type ManagedArtifact = {
  path: string;
  kind: ArtifactKind;
  provider: ArtifactProvider;
  category: string;
};

// Keep this list deliberately narrow. These are documented, repository-shared
// agent artifacts. Local-only files (for example settings.local.json) and
// unknown siblings must survive override and restore.
export const MANAGED_ARTIFACTS: readonly ManagedArtifact[] = [
  { path: ".claude/CLAUDE.md", kind: "file", provider: "claude", category: "instructions" },
  { path: ".claude/settings.json", kind: "file", provider: "claude", category: "settings" },
  { path: ".claude/skills", kind: "directory", provider: "claude", category: "skills" },
  { path: ".claude/commands", kind: "directory", provider: "claude", category: "commands" },
  { path: ".claude/agents", kind: "directory", provider: "claude", category: "agents" },
  { path: ".claude/rules", kind: "directory", provider: "claude", category: "rules" },
  { path: ".claude/workflows", kind: "directory", provider: "claude", category: "workflows" },
  { path: ".claude/output-styles", kind: "directory", provider: "claude", category: "output styles" },
  { path: ".claude/agent-memory", kind: "directory", provider: "claude", category: "agent memory" },
  // Hook declarations live in settings.json, but official examples commonly
  // keep the scripts they reference here.
  { path: ".claude/hooks", kind: "directory", provider: "claude", category: "hook scripts" },
  { path: ".mcp.json", kind: "file", provider: "claude", category: "MCP servers" },

  { path: ".codex/config.toml", kind: "file", provider: "codex", category: "settings and MCP servers" },
  { path: ".codex/agents", kind: "directory", provider: "codex", category: "agents" },
  { path: ".codex/skills", kind: "directory", provider: "codex", category: "skills (compatible)" },
  { path: ".codex/rules", kind: "directory", provider: "codex", category: "rules" },
  { path: ".codex/hooks.json", kind: "file", provider: "codex", category: "hooks" },
  { path: ".codex/hooks", kind: "directory", provider: "codex", category: "hook scripts" },
  // Codex repository skills and plugin marketplaces are documented under
  // .agents rather than .codex.
  { path: ".agents/skills", kind: "directory", provider: "codex", category: "skills" },
  { path: ".agents/plugins/marketplace.json", kind: "file", provider: "codex", category: "plugins" },
  { path: ".claude-plugin/marketplace.json", kind: "file", provider: "codex", category: "plugins (legacy)" },
] as const;

export function scopedArtifactPath(scopePath: string, artifactPath: string): string {
  return scopePath && scopePath !== "." ? `${scopePath}/${artifactPath}` : artifactPath;
}
