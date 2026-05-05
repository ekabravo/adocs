import { Command } from "commander";
import path from "node:path";
import process from "node:process";
import { discoverInstructionFiles } from "./discovery";
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
      const files = await discoverInstructionFiles(root, { includeExcluded: options.excluded });

      if (options.json) {
        printJson({ root, files });
        return;
      }

      process.stdout.write(`${renderPrunedTree(path.basename(root) || root, files)}\n`);
    });

  program
    .command("override")
    .description("Apply a local override to tracked instruction files.")
    .argument("[root]", "Directory to target", ".")
    .requiredOption("--source <path>", "File whose contents will be copied into the target root")
    .option("--excluded", "Include tracked targets inside excluded directories")
    .action(async (...args: unknown[]) => {
      const rootArg = args[0] as string;
      const command = args.at(-1) as Command;
      const options = command.optsWithGlobals<{ source: string; excluded?: boolean }>();
      const result = await applyOverride({
        root: resolveRoot(rootArg),
        source: options.source,
        includeExcluded: options.excluded,
      });

      printJson(result);
    });

  program
    .command("restore")
    .description("Restore tracked instruction files from Git.")
    .argument("[root]", "Directory to target", ".")
    .action(async (...args: unknown[]) => {
      const rootArg = args[0] as string;
      const result = await restoreOverride({ root: resolveRoot(rootArg) });
      printJson(result);
    });

  try {
    await program.parseAsync(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
