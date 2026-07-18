import { Command } from "commander";
import path from "node:path";
import process from "node:process";
import { discoverProjectContext, renderInventory, sanitizeDisplayValue } from "./inventory";
import { applyOverride } from "./override";
import { restoreOverride } from "./restore";
import { renderPrunedTree } from "./tree";

function resolveRoot(root?: string): string {
  return path.resolve(root ?? process.cwd());
}

function printJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

export async function main(argv: string[]): Promise<void> {
  const program = new Command();

  program
    .name("adocs")
    .description("Manage repository-local AGENTS.md and CLAUDE.md files.")
    .argument("[root]", "Directory to inspect", ".")
    .option("--excluded", "Include excluded directories such as node_modules")
    .option("--json", "Output machine-readable results")
    .action(async (...args: unknown[]) => {
      const rootArg = args[0] as string;
      const command = args.at(-1) as Command;
      const options = command.opts<{ excluded?: boolean; json?: boolean }>();
      const root = resolveRoot(rootArg);
      const discovery = await discoverProjectContext(root, { includeExcluded: options.excluded });

      if (options.json) {
        printJson({ root, files: discovery.files, context: discovery.inventory });
        return;
      }

      const treePaths = [...new Set([...discovery.files, ...discovery.contextPaths])]
        .map(sanitizeDisplayValue)
        .sort();
      const inventory = renderInventory(discovery.inventory);
      const rootLabel = sanitizeDisplayValue(path.basename(root) || root);
      process.stdout.write(`${renderPrunedTree(rootLabel, treePaths)}${inventory ? `\n\n${inventory}` : ""}\n`);
    });

  program
    .command("override")
    .description("Apply a local override to tracked instruction files.")
    .argument("[root]", "Directory to target", ".")
    .requiredOption("--source <path>", "Directory whose known instruction and agent configuration artifacts will be copied")
    .option("--excluded", "Include tracked targets inside excluded directories")
    .option("--dry-run", "Show the exact changes without modifying files or Git state")
    .action(async (...args: unknown[]) => {
      const rootArg = args[0] as string;
      const command = args.at(-1) as Command;
      const options = command.optsWithGlobals<{ source: string; excluded?: boolean; dryRun?: boolean }>();
      const result = await applyOverride({
        root: resolveRoot(rootArg),
        source: options.source,
        includeExcluded: options.excluded,
        dryRun: options.dryRun,
      });

      printJson(result);
    });

  program
    .command("restore")
    .description("Restore tracked instruction files from Git.")
    .argument("[root]", "Directory to target", ".")
    .option("--dry-run", "Show the exact changes without modifying files or Git state")
    .action(async (...args: unknown[]) => {
      const rootArg = args[0] as string;
      const command = args.at(-1) as Command;
      const options = command.optsWithGlobals<{ dryRun?: boolean }>();
      const result = await restoreOverride({ root: resolveRoot(rootArg), dryRun: options.dryRun });
      printJson(result);
    });

  try {
    await program.parseAsync(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
