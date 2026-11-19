#!/usr/bin/env node
import { main } from '../dist/main.js';

const code = await main(process.argv.slice(2), process.env);
if (code !== 0) process.exit(code);
