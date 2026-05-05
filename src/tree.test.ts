import { describe, expect, test } from "bun:test";
import { renderPrunedTree } from "./tree";

describe("renderPrunedTree", () => {
  test("renders only the required branches", () => {
    expect(
      renderPrunedTree("repo", [
        "AGENTS.md",
        "packages/api/CLAUDE.md",
        "packages/web/AGENTS.md",
      ]),
    ).toBe(
      ["repo", "├─ AGENTS.md", "└─ packages", "   ├─ api", "   │  └─ CLAUDE.md", "   └─ web", "      └─ AGENTS.md"].join(
        "\n",
      ),
    );
  });
});
