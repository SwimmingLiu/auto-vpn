#!/usr/bin/env node
import { main } from '../lib/runner.mjs';

const code = await main(process.argv.slice(2));
process.exitCode = code;
