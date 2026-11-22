// Copy the browser-side files of Scramjet, bare-mux and the libcurl transport into public/.
// Usage: node scripts/build.mjs
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = (name) => join(root, 'node_modules', name);

const targets = [
  ['@mercuryworkshop/scramjet', 'dist', 'scram'],
  ['@mercuryworkshop/bare-mux', 'dist', 'baremux'],
  ['@mercuryworkshop/libcurl-transport', 'dist', 'libcurl'],
];

for (const [name, from, to] of targets) {
  const dest = join(root, 'public', to);
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  await cp(join(pkgDir(name), from), dest, {
    recursive: true,
    filter: (src) => !src.endsWith('.map') && !src.includes(`${from}/types`),
  });
  console.log(`copied ${name} -> public/${to}`);
}

// WISP_URL (for example wss://proxy.example.com/wisp/) points the client at a separate Wisp server.
// Leave it unset when the same server serves the page and Wisp.
const wisp = process.env.WISP_URL?.trim() ?? '';
if (wisp && !/^wss?:\/\/[^\s"'<>\\]+$/.test(wisp)) {
  throw new Error('WISP_URL must be a ws:// or wss:// address');
}
await writeFile(
  join(root, 'public', 'config.js'),
  `window.IRIDIUM_WISP = ${JSON.stringify(wisp)};\n`,
);
console.log(`wrote public/config.js (${wisp || 'same-host Wisp'})`);
