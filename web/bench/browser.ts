// @ts-nocheck: runs in plain Node with Playwright from web/node_modules; browser globals are used inside page.waitForFunction
/**
 * Browser page-load benchmark: Klyro native mode against the Scramjet client bundled in web/
 * (served by the same server with KLYRO_UI=compat), and against loading the page directly.
 * Controlled fixture pages on 127.0.0.1 only, in headless Chromium.
 *
 *   npm run build && npm run build:web && node web/bench/browser.ts [--runs=8]
 *
 * "Loaded" means every image on the page has finished loading (the fixture images are filler bytes, so only completion is checked, not decoding), in all three cases.
 * Cold = a fresh browser context (for Scramjet this includes service worker and WebAssembly
 * start-up, which a real user pays once). Warm = a second navigation in the same context.
 * Ultraviolet is not included: it is not installed in this repository.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { startOrigin } from '../../test/fixtures/origin.ts';
import { summarize } from '../../src/klyro/loadgen.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const runs = Number(process.argv.find((a) => a.startsWith('--runs='))?.slice(7) ?? 8);

async function start(port: number, env: Record<string, string>): Promise<ChildProcess> {
  const proc = spawn(process.execPath, [`${root}bin/klyro.js`], {
    env: {
      ...process.env,
      PORT: String(port),
      IRIDIUM_SERVER__HOST: '127.0.0.1',
      IRIDIUM_SECURITY__BLOCK_PRIVATE_ADDRESSES: 'false',
      IRIDIUM_LOGGING__LEVEL: 'silent',
      RATE_LIMIT: '0',
      ...env,
    },
    stdio: 'ignore',
    cwd: '/tmp',
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return proc;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error('server did not start');
}

const allImagesLoaded = (count) =>
  document.images.length >= count && [...document.images].every((i) => i.complete);

async function main() {
  if (!existsSync(`${root}web/public/scram/scramjet.wasm.wasm`))
    throw new Error('run npm run build:web first');
  const origin = await startOrigin();
  const kPort = 19100 + Math.floor(Math.random() * 400);
  const k = await start(kPort, {});
  const s = await start(kPort + 1, { KLYRO_UI: 'compat' });
  const browser = await chromium.launch({
    executablePath: existsSync('/opt/pw-browsers/chromium')
      ? '/opt/pw-browsers/chromium'
      : undefined,
    args: ['--no-sandbox'],
  });
  const target = (path: string) => `http://127.0.0.1:${origin.port}${path}`;
  const pages = [{ name: '100 small images', path: '/many.html', images: 100 }];
  const results: {
    page: string;
    mode: string;
    phase: string;
    p50: number;
    mean: number;
    min: number;
    max: number;
    n: number;
  }[] = [];

  const timed = async (fn: () => Promise<void>) => {
    const t = performance.now();
    await fn();
    return performance.now() - t;
  };

  for (const p of pages) {
    const cold: Record<string, number[]> = { direct: [], 'klyro-native': [], scramjet: [] };
    const warm: Record<string, number[]> = { direct: [], 'klyro-native': [], scramjet: [] };
    for (let i = 0; i < runs; i++) {
      // Direct
      {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        cold.direct!.push(
          await timed(async () => {
            await page.goto(target(p.path));
            await page.waitForFunction(allImagesLoaded, p.images);
          }),
        );
        warm.direct!.push(
          await timed(async () => {
            await page.goto(target(p.path));
            await page.waitForFunction(allImagesLoaded, p.images);
          }),
        );
        await ctx.close();
      }
      // Klyro native: the address bar redirects into a session, then the page loads in the tab.
      {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        const go = `http://127.0.0.1:${kPort}/klyro/go?u=${encodeURIComponent(target(p.path))}`;
        cold['klyro-native']!.push(
          await timed(async () => {
            await page.goto(go);
            await page.waitForFunction(allImagesLoaded, p.images);
          }),
        );
        warm['klyro-native']!.push(
          await timed(async () => {
            await page.goto(go);
            await page.waitForFunction(allImagesLoaded, p.images);
          }),
        );
        await ctx.close();
      }
      // Scramjet client
      {
        const ctx = await browser.newContext();
        const page: Page = await ctx.newPage();
        await page.goto(`http://127.0.0.1:${kPort + 1}/`);
        // Each navigation gets a unique query so we can wait for the NEW document in the frame.
        // Without that, the previous page's finished images would satisfy the check at once.
        let nav = 0;
        const open = async () => {
          const tag = `n${i}x${nav++}`;
          await page.fill('#address', target(`${p.path}?${tag}`));
          await page.click('button');
          // The frame's URL changes once the navigation starts; poll for the new document.
          let frame;
          for (let waited = 0; !frame && waited < 90_000; waited += 5) {
            frame = page.frames().find((f) => f.url().includes(tag));
            if (!frame) await new Promise((r) => setTimeout(r, 5));
          }
          if (!frame) throw new Error('the proxied frame never navigated');
          await frame.waitForFunction(allImagesLoaded, p.images, { timeout: 90_000 });
        };
        cold.scramjet!.push(await timed(open));
        warm.scramjet!.push(await timed(open));
        await ctx.close();
      }
      process.stderr.write(`run ${i + 1}/${runs}\n`);
    }
    for (const [phase, set] of [
      ['cold', cold],
      ['warm', warm],
    ] as const) {
      for (const mode of Object.keys(set)) {
        const sm = summarize(set[mode]!);
        results.push({
          page: p.name,
          mode,
          phase,
          p50: sm.p50,
          mean: sm.mean,
          min: sm.min,
          max: sm.max,
          n: set[mode]!.length,
        });
      }
    }
  }
  await browser.close();
  k.kill();
  s.kill();
  await origin.close();

  const f = (x: number) => x.toFixed(0);
  const out = [
    '| Page | Phase | Mode | p50 ms | mean ms | min ms | max ms | runs |',
    '|---|---|---|---:|---:|---:|---:|---:|',
  ];
  for (const r of results)
    out.push(
      `| ${r.page} | ${r.phase} | ${r.mode} | ${f(r.p50)} | ${f(r.mean)} | ${f(r.min)} | ${f(r.max)} | ${r.n} |`,
    );
  mkdirSync(`${root}bench/results`, { recursive: true });
  writeFileSync(
    `${root}bench/results/browser.json`,
    JSON.stringify({ date: new Date().toISOString(), runs, results }, null, 2),
  );
  process.stdout.write(`${out.join('\n')}\n`);
}
await main();
