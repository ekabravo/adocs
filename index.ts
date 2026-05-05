#!/usr/bin/env node

import { main } from "./src/cli";

main(process.argv).catch((error) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
});
