#!/usr/bin/env node
import { cli } from '../dist/cli.js';

const code = await cli(process.argv.slice(2), process.env);
if (code !== 0) process.exit(code);
