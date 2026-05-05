type TreeNode = {
  children: Map<string, TreeNode>;
  isFile: boolean;
};

function createNode(isFile = false): TreeNode {
  return { children: new Map(), isFile };
}

function sortEntries(entries: Array<[string, TreeNode]>): Array<[string, TreeNode]> {
  return entries.sort(([leftName, leftNode], [rightName, rightNode]) => {
    if (leftNode.isFile !== rightNode.isFile) {
      return leftNode.isFile ? -1 : 1;
    }

    return leftName.localeCompare(rightName);
  });
}

export function renderPrunedTree(rootLabel: string, relativePaths: string[]): string {
  const root = createNode();

  for (const relativePath of relativePaths) {
    const parts = relativePath.split("/").filter(Boolean);
    let cursor = root;

    for (const [index, part] of parts.entries()) {
      const isFile = index === parts.length - 1;
      const next = cursor.children.get(part) ?? createNode(isFile);
      if (isFile) {
        next.isFile = true;
      }
      cursor.children.set(part, next);
      cursor = next;
    }
  }

  const lines = [rootLabel];

  function visit(node: TreeNode, prefix: string): void {
    const entries = sortEntries([...node.children.entries()]);

    entries.forEach(([name, child], index) => {
      const isLast = index === entries.length - 1;
      const branch = isLast ? "└─ " : "├─ ";
      lines.push(`${prefix}${branch}${name}`);
      visit(child, `${prefix}${isLast ? "   " : "│  "}`);
    });
  }

  visit(root, "");

  return lines.join("\n");
}
