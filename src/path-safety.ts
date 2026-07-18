import fs from "node:fs/promises";
import path from "node:path";

export function assertPathInside(root: string, targetPath: string): void {
  const relative = path.relative(root, targetPath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Managed path must stay inside the target directory: ${targetPath}`);
  }
}

export async function assertNoSymlinkParents(root: string, targetPath: string): Promise<void> {
  assertPathInside(root, targetPath);
  const relative = path.relative(root, targetPath);
  const parentSegments = relative.split(path.sep).filter(Boolean).slice(0, -1);
  let cursor = root;

  for (const segment of parentSegments) {
    cursor = path.join(cursor, segment);
    try {
      const stats = await fs.lstat(cursor);
      if (stats.isSymbolicLink()) {
        throw new Error(`Refusing to traverse symlinked managed path parent: ${cursor}`);
      }
      if (!stats.isDirectory()) {
        throw new Error(`Expected a directory at managed path parent: ${cursor}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
  }
}
