#!/usr/bin/env node
import { runCliShell } from '../dist/cli/main.js';

const code = await runCliShell(process.argv.slice(2));
process.exitCode = code;
