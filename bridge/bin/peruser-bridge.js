#!/usr/bin/env node
import { main } from '../src/cli.js';

main().catch((e) => {
  console.error(`peruser-bridge: ${e.message}`);
  process.exit(1);
});
