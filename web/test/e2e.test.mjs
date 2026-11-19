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

describe('browser client', { skip: !existsSync(staticDir + 'scram') }, () => {
  let site, proxy, browser, base;
  before(async () => {
    site = createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
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
