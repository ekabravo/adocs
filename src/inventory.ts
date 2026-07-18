import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { DEFAULT_EXCLUDED_DIRECTORIES, INSTRUCTION_FILES } from "./constants";

export type InventoryEntry = {
  name: string;
  path: string;
  detail?: string;
};

export type ProviderInventory = {
  settings: InventoryEntry[];
  skills: InventoryEntry[];
  commands: InventoryEntry[];
  agents: InventoryEntry[];
  rules: InventoryEntry[];
  hooks: InventoryEntry[];
  mcpServers: InventoryEntry[];
  plugins: InventoryEntry[];
  apps: InventoryEntry[];
  workflows: InventoryEntry[];
  outputStyles: InventoryEntry[];
  agentMemory: InventoryEntry[];
};

export type ProjectInventory = {
  claude: ProviderInventory;
  codex: ProviderInventory;
  localOnly: InventoryEntry[];
  warnings: string[];
};

export type ProjectDiscovery = {
  files: string[];
  contextPaths: string[];
  inventory: ProjectInventory;
};

const CONTEXT_PATTERNS = [
  "**/.claude/settings.json",
  "**/.claude/settings.local.json",
  "**/.claude/skills/*/SKILL.md",
  "**/.claude/commands/**/*.md",
  "**/.claude/agents/**/*.md",
  "**/.claude/rules/**/*.md",
  "**/.claude/workflows/**/*.js",
  "**/.claude/output-styles/**/*.md",
  "**/.claude/agent-memory/*/MEMORY.md",
  "**/.mcp.json",
  "**/CLAUDE.local.md",
  "**/.codex/config.toml",
  "**/.codex/agents/*.toml",
  "**/.codex/skills/*/SKILL.md",
  "**/.codex/rules/*.rules",
  "**/.codex/hooks.json",
  "**/.agents/skills/*/SKILL.md",
  "**/.agents/plugins/marketplace.json",
  "**/.claude-plugin/marketplace.json",
] as const;

const GLOB_PATTERNS = [
  ...INSTRUCTION_FILES.flatMap((name) => [name, `**/${name}`]),
  ...CONTEXT_PATTERNS,
];

const FRONTMATTER_READ_LIMIT = 64 * 1024;
const INSPECTION_CONCURRENCY = 16;

function emptyProviderInventory(): ProviderInventory {
  return {
    settings: [],
    skills: [],
    commands: [],
    agents: [],
    rules: [],
    hooks: [],
    mcpServers: [],
    plugins: [],
    apps: [],
    workflows: [],
    outputStyles: [],
    agentMemory: [],
  };
}

function normalize(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function baseNameWithoutExtension(filePath: string): string {
  return path.posix.basename(filePath, path.posix.extname(filePath));
}

function getFrontmatter(contents: string): string | undefined {
  return contents.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
}

function frontmatterName(contents: string): string | undefined {
  return getFrontmatter(contents)?.match(/^name:\s*["']?([^\r\n"']+)["']?\s*$/m)?.[1]?.trim();
}

function cleanConfigName(value: string): string {
  return value.trim().replace(/^[-\s]+/, "").replace(/^name:\s*/, "").replace(/^["']|["']$/g, "");
}

function yamlListValues(frontmatter: string, key: string): string[] {
  const lines = frontmatter.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^${key}:`).test(line));
  if (start === -1) return [];
  const remainder = lines[start]!.slice(lines[start]!.indexOf(":") + 1).trim();
  if (remainder.startsWith("[") && remainder.endsWith("]")) {
    return remainder.slice(1, -1).split(",").map(cleanConfigName).filter(Boolean);
  }
  if (remainder && !remainder.startsWith("{") && remainder !== "|") {
    return [cleanConfigName(remainder)].filter(Boolean);
  }

  const values: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const item = line.match(/^\s+-\s+(.+)$/)?.[1];
    if (!item) continue;
    const inlineName = item.match(/^\{?\s*name:\s*["']?([^,"'}]+)["']?/)?.[1];
    const value = cleanConfigName(inlineName ?? item);
    if (value && !value.includes(":")) values.push(value);
  }
  return values;
}

function yamlChildKeys(frontmatter: string, key: string): string[] {
  const lines = frontmatter.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^${key}:\\s*$`).test(line));
  if (start === -1) return [];
  const candidates: Array<{ indent: number; name: string }> = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const match = line.match(/^(\s+)(?:-\s+)?([A-Za-z][A-Za-z0-9_-]*):/);
    if (match) candidates.push({ indent: match[1]!.length, name: match[2]! });
  }
  const minimumIndent = Math.min(...candidates.map(({ indent }) => indent));
  return candidates.filter(({ indent }) => indent === minimumIndent).map(({ name }) => name);
}

function tomlSkillNames(contents: string): string[] {
  const names = new Set<string>();
  const blocks = contents.split(/^\s*\[\[skills\.config\]\]\s*$/m).slice(1);
  for (const block of blocks) {
    const currentBlock = block.split(/^\s*\[\[?/m)[0] ?? "";
    const configuredPath = currentBlock.match(/^\s*path\s*=\s*["']([^"']+)["']\s*$/m)?.[1];
    if (!configuredPath) continue;
    const normalized = configuredPath.replace(/[\\/]+$/, "");
    const name = path.basename(normalized).toLowerCase() === "skill.md"
      ? path.basename(path.dirname(normalized))
      : path.basename(normalized);
    if (name) names.add(name);
  }
  return [...names];
}

function sortInventory(inventory: ProjectInventory): void {
  for (const provider of [inventory.claude, inventory.codex]) {
    for (const entries of Object.values(provider)) {
      entries.sort((left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path));
    }
  }
  inventory.localOnly.sort((left, right) => left.path.localeCompare(right.path));
  inventory.warnings.sort();
}

async function readText(root: string, relativePath: string): Promise<string> {
  return fs.readFile(path.join(root, relativePath), "utf8");
}

async function readPrefix(root: string, relativePath: string): Promise<string> {
  const handle = await fs.open(path.join(root, relativePath), "r");
  try {
    const buffer = Buffer.allocUnsafe(FRONTMATTER_READ_LIMIT);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function inspectWithBoundedConcurrency(
  paths: string[],
  inspect: (relativePath: string) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(INSPECTION_CONCURRENCY, paths.length) },
    async () => {
      while (nextIndex < paths.length) {
        const relativePath = paths[nextIndex++]!;
        await inspect(relativePath);
      }
    },
  );
  await Promise.all(workers);
}

export function sanitizeDisplayValue(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function sanitizeInventory(inventory: ProjectInventory): void {
  for (const provider of [inventory.claude, inventory.codex]) {
    for (const entries of Object.values(provider)) {
      for (const entry of entries) {
        entry.name = sanitizeDisplayValue(entry.name);
        entry.path = sanitizeDisplayValue(entry.path);
        if (entry.detail) entry.detail = sanitizeDisplayValue(entry.detail);
      }
    }
  }
  for (const entry of inventory.localOnly) {
    entry.name = sanitizeDisplayValue(entry.name);
    entry.path = sanitizeDisplayValue(entry.path);
    if (entry.detail) entry.detail = sanitizeDisplayValue(entry.detail);
  }
  inventory.warnings = inventory.warnings.map(sanitizeDisplayValue);
}

function pushJsonWarning(inventory: ProjectInventory, relativePath: string, _error: unknown): void {
  // JSON parser errors can echo nearby source text. Keep output useful without
  // risking disclosure of tokens or environment values from malformed config.
  inventory.warnings.push(`${relativePath}: unable to parse JSON configuration`);
}

async function inspectClaudeSettings(
  root: string,
  relativePath: string,
  inventory: ProjectInventory,
  scopeDetail?: string,
): Promise<void> {
  inventory.claude.settings.push({ name: scopeDetail ? `${scopeDetail} settings` : "settings", path: relativePath });
  try {
    const settings = JSON.parse(await readText(root, relativePath)) as {
      enabledPlugins?: Record<string, boolean>;
      extraKnownMarketplaces?: Record<string, unknown>;
      hooks?: Record<string, unknown[]>;
    };
    for (const [name, enabled] of Object.entries(settings.enabledPlugins ?? {})) {
      const state = enabled ? "enabled" : "disabled";
      inventory.claude.plugins.push({ name, path: relativePath, detail: scopeDetail ? `${scopeDetail}, ${state}` : state });
    }
    for (const name of Object.keys(settings.extraKnownMarketplaces ?? {})) {
      inventory.claude.plugins.push({ name, path: relativePath, detail: scopeDetail ? `${scopeDetail} marketplace` : "marketplace" });
    }
    for (const [name, handlers] of Object.entries(settings.hooks ?? {})) {
      const count = Array.isArray(handlers) ? handlers.length : 0;
      const countDetail = `${count} matcher${count === 1 ? "" : "s"}`;
      inventory.claude.hooks.push({ name, path: relativePath, detail: scopeDetail ? `${scopeDetail}, ${countDetail}` : countDetail });
    }
  } catch (error) {
    pushJsonWarning(inventory, relativePath, error);
  }
}

async function inspectClaudeMcp(root: string, relativePath: string, inventory: ProjectInventory): Promise<void> {
  try {
    const config = JSON.parse(await readText(root, relativePath)) as { mcpServers?: Record<string, unknown> };
    for (const name of Object.keys(config.mcpServers ?? {})) {
      inventory.claude.mcpServers.push({ name, path: relativePath });
    }
  } catch (error) {
    pushJsonWarning(inventory, relativePath, error);
  }
}

function tomlSectionNames(contents: string, prefix: string): string[] {
  const names = new Set<string>();
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\s*\\[\\[?${escapedPrefix}\\.([^\\]]+)\\]\\]?\\s*$`, "gm");
  for (const match of contents.matchAll(pattern)) {
    const remainder = match[1]?.trim() ?? "";
    const quoted = remainder.match(/^(["'])(.*?)\1(?:\.|$)/)?.[2];
    const firstSegment = quoted ?? remainder.split(".")[0]?.trim();
    if (firstSegment) {
      names.add(firstSegment);
    }
  }
  return [...names];
}

async function inspectCodexConfig(root: string, relativePath: string, inventory: ProjectInventory): Promise<void> {
  inventory.codex.settings.push({ name: "config", path: relativePath });
  try {
    const contents = await readText(root, relativePath);
    for (const name of tomlSectionNames(contents, "mcp_servers")) {
      inventory.codex.mcpServers.push({ name, path: relativePath });
    }
    for (const name of tomlSectionNames(contents, "hooks")) {
      inventory.codex.hooks.push({ name, path: relativePath, detail: "inline" });
    }
    for (const name of tomlSectionNames(contents, "agents")) {
      inventory.codex.agents.push({ name, path: relativePath, detail: "inline" });
    }
    for (const name of tomlSectionNames(contents, "apps")) {
      inventory.codex.apps.push({ name, path: relativePath });
    }
    for (const name of tomlSectionNames(contents, "plugins")) {
      inventory.codex.plugins.push({ name, path: relativePath, detail: "configuration" });
    }
  } catch (error) {
    inventory.warnings.push(`${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function inspectCodexHooks(root: string, relativePath: string, inventory: ProjectInventory): Promise<void> {
  try {
    const config = JSON.parse(await readText(root, relativePath)) as { hooks?: Record<string, unknown[]> };
    for (const [name, handlers] of Object.entries(config.hooks ?? {})) {
      const count = Array.isArray(handlers) ? handlers.length : 0;
      inventory.codex.hooks.push({ name, path: relativePath, detail: `${count} matcher${count === 1 ? "" : "s"}` });
    }
  } catch (error) {
    pushJsonWarning(inventory, relativePath, error);
  }
}

async function inspectMarketplace(root: string, relativePath: string, inventory: ProjectInventory): Promise<void> {
  try {
    const marketplace = JSON.parse(await readText(root, relativePath)) as {
      name?: string;
      plugins?: Array<{ name?: string }>;
    };
    for (const plugin of marketplace.plugins ?? []) {
      if (!plugin.name) continue;
      inventory.codex.plugins.push({
        name: plugin.name,
        path: relativePath,
        detail: "available",
      });
    }
    if ((marketplace.plugins?.length ?? 0) === 0 && marketplace.name) {
      inventory.codex.plugins.push({ name: marketplace.name, path: relativePath, detail: "marketplace" });
    }
  } catch (error) {
    pushJsonWarning(inventory, relativePath, error);
  }
}

export async function discoverProjectContext(
  root: string,
  options: { includeExcluded?: boolean } = {},
): Promise<ProjectDiscovery> {
  const matches = (await fg(GLOB_PATTERNS, {
    cwd: root,
    dot: true,
    followSymbolicLinks: false,
    onlyFiles: true,
    unique: true,
    ignore: options.includeExcluded ? [] : DEFAULT_EXCLUDED_DIRECTORIES.map((name) => `**/${name}/**`),
  })).map(normalize).sort();

  const files = matches.filter((match) => INSTRUCTION_FILES.includes(path.posix.basename(match) as (typeof INSTRUCTION_FILES)[number]));
  const contextPaths = matches.filter((match) => !files.includes(match));
  const inventory: ProjectInventory = {
    claude: emptyProviderInventory(),
    codex: emptyProviderInventory(),
    localOnly: [],
    warnings: [],
  };

  await inspectWithBoundedConcurrency(contextPaths, async (relativePath) => {
    if (relativePath.endsWith("/CLAUDE.local.md") || relativePath === "CLAUDE.local.md") {
      inventory.localOnly.push({ name: "local instructions", path: relativePath });
    } else if (relativePath.endsWith("/.claude/settings.local.json") || relativePath === ".claude/settings.local.json") {
      inventory.localOnly.push({ name: "local settings", path: relativePath });
      await inspectClaudeSettings(root, relativePath, inventory, "local");
    } else if (relativePath.endsWith("/.claude/settings.json") || relativePath === ".claude/settings.json") {
      await inspectClaudeSettings(root, relativePath, inventory);
    } else if (relativePath.endsWith("/.mcp.json") || relativePath === ".mcp.json") {
      await inspectClaudeMcp(root, relativePath, inventory);
    } else if (/\.claude\/skills\/[^/]+\/SKILL\.md$/.test(relativePath)) {
      const contents = await readPrefix(root, relativePath);
      inventory.claude.skills.push({ name: frontmatterName(contents) ?? relativePath.split("/").at(-2)!, path: relativePath });
    } else if (/\.claude\/commands\/.+\.md$/.test(relativePath)) {
      inventory.claude.commands.push({ name: baseNameWithoutExtension(relativePath), path: relativePath });
    } else if (/\.claude\/agents\/.+\.md$/.test(relativePath)) {
      const contents = await readPrefix(root, relativePath);
      const agentName = frontmatterName(contents) ?? baseNameWithoutExtension(relativePath);
      inventory.claude.agents.push({ name: agentName, path: relativePath });
      const frontmatter = getFrontmatter(contents) ?? "";
      for (const name of yamlListValues(frontmatter, "skills")) {
        inventory.claude.skills.push({ name, path: relativePath, detail: `used by agent ${agentName}` });
      }
      const agentMcpServers = new Set([
        ...yamlListValues(frontmatter, "mcpServers"),
        ...yamlChildKeys(frontmatter, "mcpServers"),
      ]);
      for (const name of agentMcpServers) {
        inventory.claude.mcpServers.push({ name, path: relativePath, detail: `agent ${agentName}` });
      }
      for (const name of yamlChildKeys(frontmatter, "hooks")) {
        inventory.claude.hooks.push({ name, path: relativePath, detail: `agent ${agentName}` });
      }
    } else if (/\.claude\/rules\/.+\.md$/.test(relativePath)) {
      inventory.claude.rules.push({ name: baseNameWithoutExtension(relativePath), path: relativePath });
    } else if (/\.claude\/workflows\/.+\.js$/.test(relativePath)) {
      inventory.claude.workflows.push({ name: baseNameWithoutExtension(relativePath), path: relativePath });
    } else if (/\.claude\/output-styles\/.+\.md$/.test(relativePath)) {
      const contents = await readPrefix(root, relativePath);
      inventory.claude.outputStyles.push({ name: frontmatterName(contents) ?? baseNameWithoutExtension(relativePath), path: relativePath });
    } else if (/\.claude\/agent-memory\/[^/]+\/MEMORY\.md$/.test(relativePath)) {
      inventory.claude.agentMemory.push({ name: relativePath.split("/").at(-2)!, path: relativePath });
    } else if (relativePath.endsWith("/.codex/config.toml") || relativePath === ".codex/config.toml") {
      await inspectCodexConfig(root, relativePath, inventory);
    } else if (/\.codex\/agents\/[^/]+\.toml$/.test(relativePath)) {
      const contents = await readPrefix(root, relativePath);
      const agentName = contents.match(/^\s*name\s*=\s*["']([^"']+)["']\s*$/m)?.[1]
        ?? baseNameWithoutExtension(relativePath);
      inventory.codex.agents.push({ name: agentName, path: relativePath });
      for (const name of tomlSectionNames(contents, "mcp_servers")) {
        inventory.codex.mcpServers.push({ name, path: relativePath, detail: `agent ${agentName}` });
      }
      for (const name of tomlSectionNames(contents, "hooks")) {
        inventory.codex.hooks.push({ name, path: relativePath, detail: `agent ${agentName}` });
      }
      for (const name of tomlSkillNames(contents)) {
        inventory.codex.skills.push({ name, path: relativePath, detail: `configured by agent ${agentName}` });
      }
    } else if (/(?:\.codex|\.agents)\/skills\/[^/]+\/SKILL\.md$/.test(relativePath)) {
      const contents = await readPrefix(root, relativePath);
      const detail = relativePath.includes("/.codex/skills/") || relativePath.startsWith(".codex/skills/")
        ? "runtime-compatible location"
        : undefined;
      inventory.codex.skills.push({ name: frontmatterName(contents) ?? relativePath.split("/").at(-2)!, path: relativePath, detail });
    } else if (/\.codex\/rules\/[^/]+\.rules$/.test(relativePath)) {
      inventory.codex.rules.push({ name: baseNameWithoutExtension(relativePath), path: relativePath });
    } else if (relativePath.endsWith("/.codex/hooks.json") || relativePath === ".codex/hooks.json") {
      await inspectCodexHooks(root, relativePath, inventory);
    } else if (relativePath.endsWith("/.agents/plugins/marketplace.json")
      || relativePath === ".agents/plugins/marketplace.json"
      || relativePath.endsWith("/.claude-plugin/marketplace.json")
      || relativePath === ".claude-plugin/marketplace.json") {
      await inspectMarketplace(root, relativePath, inventory);
    }
  });

  sanitizeInventory(inventory);
  sortInventory(inventory);
  return { files, contextPaths, inventory };
}

const GROUP_LABELS: Array<[keyof ProviderInventory, string]> = [
  ["settings", "settings"],
  ["skills", "skills"],
  ["commands", "commands"],
  ["agents", "agents"],
  ["rules", "rules"],
  ["hooks", "hooks"],
  ["mcpServers", "MCP servers"],
  ["plugins", "plugins / marketplaces"],
  ["apps", "apps / connectors"],
  ["workflows", "workflows"],
  ["outputStyles", "output styles"],
  ["agentMemory", "agent memory"],
];

export function renderInventory(inventory: ProjectInventory): string {
  const lines: string[] = [];
  for (const [providerName, provider] of [["Claude", inventory.claude], ["Codex", inventory.codex]] as const) {
    const populated = GROUP_LABELS.filter(([key]) => provider[key].length > 0);
    if (populated.length === 0) continue;
    lines.push(`${providerName}:`);
    for (const [key, label] of populated) {
      const rendered = provider[key]
        .map((entry) => `${entry.name}${entry.detail ? ` [${entry.detail}]` : ""} (${entry.path})`)
        .join(", ");
      lines.push(`  ${label}: ${rendered}`);
    }
  }
  if (inventory.localOnly.length > 0) {
    lines.push(`Local-only (preserved): ${inventory.localOnly.map((entry) => entry.path).join(", ")}`);
  }
  if (inventory.warnings.length > 0) {
    lines.push(`Warnings: ${inventory.warnings.join("; ")}`);
  }
  return lines.join("\n");
}
