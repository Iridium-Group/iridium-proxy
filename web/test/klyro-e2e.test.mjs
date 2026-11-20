// End-to-end in real Chromium: Klyro's native mode with a page whose JavaScript builds URLs at
// runtime. Checks that the injected runtime sends fetch, XHR and WebSocket through the proxy.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { applyDefaults } from '@iridium-group/config';
import { chromium } from 'playwright';
import { createLogger, createProxyServer } from '../../src/index.ts';
import { startOrigin } from '../../test/fixtures/origin.ts';

const chrome = '/opt/pw-browsers/chromium';

describe('klyro native mode in a browser', () => {
  let origin, proxy, browser, base;
  before(async () => {
    origin = await startOrigin();
    proxy = createProxyServer(
      applyDefaults({
        server: {
          host: '127.0.0.1',
          staticDir: fileURLToPath(new URL('../../ui/', import.meta.url)),
        },
        security: { blockPrivateAddresses: false },
      }),
      { logger: createLogger('silent', 'json'), klyro: { ratePerMinute: 0 } },
    );
    const { port } = await proxy.listen(0);
    base = `http://127.0.0.1:${port}`;
    browser = await chromium.launch({
      executablePath: existsSync(chrome) ? chrome : undefined,
      args: ['--no-sandbox'],
    });
  });
  after(async () => {
    await browser?.close();
    await proxy?.close();
    await origin?.close();
  });

  const open = async (path) => {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(
      `${base}/klyro/go?u=${encodeURIComponent(`http://127.0.0.1:${origin.port}${path}`)}`,
    );
    return { page, errors };
  };

  it('runs page JavaScript whose fetch, XHR and WebSocket URLs are built at runtime', async () => {
    const { page, errors } = await open(`/app.html?ws=${origin.wsPort}`);
    await page.waitForFunction(
      () => document.getElementById('out')?.textContent !== 'pending',
      undefined,
      { timeout: 20_000 },
    );
    const result = JSON.parse(await page.textContent('#out'));
    assert.deepEqual(result, {
      fetchRoot: true,
      fetchRelative: true,
      fetchAbsolute: true,
      xhr: true,
      websocket: 'hello-ws',
    });
    assert.deepEqual(errors, []);
    await page.close();
  });

  it('keeps navigating inside the proxy when a link is clicked', async () => {
    const { page } = await open('/app.html?ws=1');
    await page.click('#next');
    await page.waitForURL(/static\.html$/);
    assert.match(page.url(), /\/k\/[\w-]{22}\/http\/127\.0\.0\.1:\d+\/static\.html$/);
    await page.close();
  });

  it('loads the page assets (stylesheet and script) through the proxy', async () => {
    const { page } = await open('/static.html');
    await page.waitForFunction(() => document.title === 'js ran', undefined, { timeout: 20_000 }); // /app.js ran
    assert.ok((origin.hits.get('/style.css') ?? 0) >= 1);
    await page.close();
  });

  it('shows the home page', async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/`);
    assert.equal(await page.textContent('h1'), 'KLYRO');
    await page.close();
  });
});
