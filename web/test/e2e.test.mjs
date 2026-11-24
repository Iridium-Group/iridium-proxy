// End-to-end: a real browser loads the client, submits a URL, and sees the page through
// Scramjet, the Wisp endpoint and a TCP connection to a local site.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '@iridium-group/config';
import { chromium } from 'playwright';
import { createProxyServer } from '../../src/index.ts';

const staticDir = fileURLToPath(new URL('../public/', import.meta.url));
const chrome = '/opt/pw-browsers/chromium';

describe('browser client', { skip: !existsSync(staticDir + 'scramjet') }, () => {
  let site, proxy, browser, base;
  before(async () => {
    site = createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      if (req.url.startsWith('/cookie')) {
        // Like a login page: sets a cookie on the first visit and shows what it gets back later.
        const sent = /(?:^|; )sid=([^;]*)/.exec(req.headers.cookie ?? '')?.[1];
        if (!sent) res.setHeader('set-cookie', 'sid=hello-123; Path=/');
        return res.end(`<title>cookie</title><p id="seen">${sent ? `sid=${sent}` : 'none'}</p>`);
      }
      res.end(
        `<title>site</title><h1 id="hi">hello from the target</h1><script>document.title='js ran'</script>`,
      );
    });
    await new Promise((r) => site.listen(0, '127.0.0.1', r));
    const config = resolveConfig(
      {
        server: { host: '127.0.0.1', staticDir },
        security: { blockPrivateAddresses: false },
        logging: { level: 'silent' },
      },
      { env: false },
    );
    proxy = createProxyServer(config);
    const { port } = await proxy.listen(0);
    base = `http://127.0.0.1:${port}/`;
    browser = await chromium.launch({
      executablePath: existsSync(chrome) ? chrome : undefined,
      args: ['--no-sandbox'],
    });
  });
  after(async () => {
    await browser?.close();
    await proxy?.close();
    site?.close();
  });

  it('keeps the cookies a site sets, also after the client page itself is reloaded', async () => {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(base);
    const visit = async () => {
      await page.fill('#address', `http://127.0.0.1:${site.address().port}/cookie`);
      await page.click('button');
    };
    const seen = () =>
      page.waitForFunction(
        () =>
          document.querySelector('#frame')?.contentDocument?.getElementById('seen')?.textContent,
        undefined,
        { timeout: 60_000 },
      );
    const text = async () => (await (await seen()).jsonValue()).toString();

    await visit();
    assert.equal(await text(), 'none', 'the first visit has no cookie yet');

    await visit(); // a second visit in the same page sends the cookie back
    await page.waitForFunction(
      () =>
        document.querySelector('#frame')?.contentDocument?.getElementById('seen')?.textContent ===
        'sid=hello-123',
      undefined,
      { timeout: 60_000 },
    );

    // reload the whole client: a login has to survive that
    await page.reload();
    await visit();
    await page.waitForFunction(
      () =>
        document.querySelector('#frame')?.contentDocument?.getElementById('seen')?.textContent ===
        'sid=hello-123',
      undefined,
      { timeout: 60_000 },
    );
    assert.deepEqual(errors, []);
    await page.close();
  });

  it('uses the Wisp server named in config.js when it is on another address, as on Vercel', async () => {
    // a second server that only acts as the relay
    const relay = createProxyServer(
      resolveConfig(
        {
          server: { host: '127.0.0.1', staticDir },
          security: { blockPrivateAddresses: false },
          logging: { level: 'silent' },
        },
        { env: false },
      ),
    );
    const { port: relayPort } = await relay.listen(0);
    try {
      const page = await browser.newPage();
      const errors = [];
      const sockets = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('websocket', (ws) => sockets.push(ws.url()));
      // what the build writes into config.js when WISP_URL is set
      await page.route('**/config.js', (route) =>
        route.fulfill({
          contentType: 'text/javascript',
          body: `window.IRIDIUM_WISP = "ws://127.0.0.1:${relayPort}/wisp/";`,
        }),
      );
      await page.goto(base);
      await page.fill('#address', `http://127.0.0.1:${site.address().port}/`);
      await page.click('button');
      const frame = page.frameLocator('#frame');
      await frame.locator('#hi').waitFor({ timeout: 60_000 });
      assert.equal(await frame.locator('#hi').textContent(), 'hello from the target');
      assert.ok(
        sockets.some((u) => u.startsWith(`ws://127.0.0.1:${relayPort}/wisp/`)),
        `the relay on another address was used (sockets: ${sockets.join(', ')})`,
      );
      assert.ok(
        !sockets.some((u) => u.startsWith(base.replace('http', 'ws') + 'wisp')),
        'the page did not use its own address for Wisp',
      );
      assert.deepEqual(errors, []);
      await page.close();
    } finally {
      await relay.close();
    }
  });

  it('loads a page through the proxy', async () => {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(base);
    await page.fill('#address', `http://127.0.0.1:${site.address().port}/`);
    await page.click('button');
    const frame = page.frameLocator('#frame');
    await frame.locator('#hi').waitFor({ timeout: 60_000 });
    assert.equal(await frame.locator('#hi').textContent(), 'hello from the target');
    assert.deepEqual(errors, []);
  });
});
