// Copy the browser-side files of Scramjet, its controller and the libcurl transport into public/.
// Usage: node scripts/build.mjs
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = (name) => join(root, 'node_modules', name);

// [package, folder inside it, files to copy, folder in public/]
const targets = [
  ['@mercuryworkshop/scramjet', 'dist', ['scramjet.js', 'scramjet.wasm'], 'scramjet'],
  [
    '@mercuryworkshop/scramjet-controller',
    'dist',
    ['controller.api.js', 'controller.inject.js', 'controller.sw.js'],
    'controller',
  ],
  ['@mercuryworkshop/libcurl-transport', 'dist', ['index.js'], 'libcurl'],
];

// Folders written by the previous version of this client (Scramjet 1.x and bare-mux).
for (const old of ['scram', 'baremux'])
  await rm(join(root, 'public', old), { recursive: true, force: true });

for (const [name, from, files, to] of targets) {
  const dest = join(root, 'public', to);
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  for (const file of files) await cp(join(pkgDir(name), from, file), join(dest, file));
  console.log(`copied ${name} -> public/${to} (${files.join(', ')})`);
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
