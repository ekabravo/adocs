import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverProjectContext, renderInventory } from "./inventory";

const tempRoots: string[] = [];

async function makeRoot(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "adocs-inventory-"));
  tempRoots.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await fs.writeFile(path.join(root, relativePath), contents, "utf8");
  }
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("project context inventory", () => {
  test("discovers semantic Claude and Codex project configuration", async () => {
    const root = await makeRoot({
      "AGENTS.md": "instructions\n",
      ".claude/settings.json": JSON.stringify({
        enabledPlugins: { "formatter@team": true, "legacy@team": false },
        hooks: { PreToolUse: [{ matcher: "Bash" }] },
      }),
      ".claude/settings.local.json": "{}",
      ".claude/skills/release/SKILL.md": "---\nname: ship-it\ndescription: release\n---\n",
      ".claude/agents/reviewer.md": [
        "---",
        "name: strict-reviewer",
        "skills: [security-check]",
        "mcpServers:",
        "  - agent-db",
        "  - inline-browser:",
        "      type: http",
        "hooks:",
        "  Stop:",
        "    - matcher: Bash",
        "---",
      ].join("\n"),
      ".mcp.json": JSON.stringify({ mcpServers: { github: {}, browser: {} } }),
      ".codex/config.toml": [
        "[mcp_servers.context7]",
        "command = \"npx\"",
        "[[hooks.PreToolUse]]",
        "matcher = \"Bash\"",
        "[apps.linear]",
        "enabled = true",
        "[plugins.security.mcp_servers.scanner]",
      ].join("\n"),
      ".codex/agents/explorer.toml": [
        "name = \"codex-reviewer\"",
        "[mcp_servers.agent_docs]",
        "command = \"SECRET_COMMAND\"",
        "[[skills.config]]",
        "path = \"/private/secrets/private-skill/SKILL.md\"",
        "[[skills.config]]",
        "[environment]",
        "path = \"/private/not-a-skill/SKILL.md\"",
        "[[hooks.Stop]]",
        "command = \"SECRET_HOOK\"",
      ].join("\n"),
      ".codex/skills/compat/SKILL.md": "---\nname: compat-skill\n---\n",
      ".agents/skills/docs/SKILL.md": "---\nname: docs-editor\n---\n",
      ".agents/plugins/marketplace.json": JSON.stringify({
        name: "team",
        plugins: [
          { name: "security", source: { source: "local", path: "/private/plugins/security" } },
          { name: "escaped\u001b[31m", source: "https://token@example.com/private.git" },
        ],
      }),
      "node_modules/pkg/.claude/skills/noisy/SKILL.md": "---\nname: noisy\n---\n",
    });

    const discovery = await discoverProjectContext(root);

    expect(discovery.files).toEqual(["AGENTS.md"]);
    expect(discovery.inventory.claude.skills.map(({ name }) => name)).toEqual(["security-check", "ship-it"]);
    expect(discovery.inventory.claude.agents.map(({ name }) => name)).toEqual(["strict-reviewer"]);
    expect(discovery.inventory.claude.mcpServers.map(({ name }) => name)).toEqual(["agent-db", "browser", "github", "inline-browser"]);
    expect(discovery.inventory.claude.plugins.map(({ name, detail }) => [name, detail])).toEqual([
      ["formatter@team", "enabled"],
      ["legacy@team", "disabled"],
    ]);
    expect(discovery.inventory.claude.hooks.map(({ name }) => name)).toEqual(["PreToolUse", "Stop"]);
    expect(discovery.inventory.codex.skills.map(({ name }) => name)).toEqual(["compat-skill", "docs-editor", "private-skill"]);
    expect(discovery.inventory.codex.agents.map(({ name }) => name)).toEqual(["codex-reviewer"]);
    expect(discovery.inventory.codex.mcpServers.map(({ name }) => name)).toEqual(["agent_docs", "context7"]);
    expect(discovery.inventory.codex.hooks.map(({ name }) => name)).toEqual(["PreToolUse", "Stop"]);
    expect(discovery.inventory.codex.apps.map(({ name }) => name)).toEqual(["linear"]);
    expect(discovery.inventory.codex.plugins.map(({ name }) => name)).toEqual(["escaped\\u001b[31m", "security", "security"]);
    expect(discovery.inventory.localOnly.map(({ path: entryPath }) => entryPath)).toEqual([".claude/settings.local.json"]);
    const rendered = renderInventory(discovery.inventory);
    expect(rendered).toContain("browser (.mcp.json)");
    expect(rendered).toContain("github (.mcp.json)");
    expect(rendered).not.toContain("noisy");
    expect(rendered).not.toContain("token@example.com");
    expect(rendered).not.toContain("/private/");
    expect(rendered).not.toContain("SECRET_");
    expect(rendered).not.toContain("\u001b");
    expect(rendered).toContain("escaped\\u001b[31m");
  });

  test("reports malformed config without hiding the file", async () => {
    const root = await makeRoot({
      ".claude/settings.json": "{not-json",
      ".mcp.json": "{also-not-json",
    });

    const discovery = await discoverProjectContext(root);

    expect(discovery.contextPaths).toEqual([".claude/settings.json", ".mcp.json"]);
    expect(discovery.inventory.claude.settings).toEqual([{ name: "settings", path: ".claude/settings.json" }]);
    expect(discovery.inventory.warnings).toHaveLength(2);
  });
});
