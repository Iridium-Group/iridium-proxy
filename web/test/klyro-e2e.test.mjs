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
      {
        logger: createLogger('silent', 'json'),
        klyro: { ratePerMinute: 0 },
        crossOriginIsolated: false,
      },
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

  it('browser shell: opens a page in a tab, follows its address and title, and goes back', async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/`);
    const app = `http://127.0.0.1:${origin.port}/app.html?ws=${origin.wsPort}`;
    await page.fill('#url', app);
    await page.press('#url', 'Enter');
    const view = page.frameLocator('iframe.view');
    await view.locator('#hi').waitFor({ timeout: 20_000 });
    await page.waitForFunction((u) => document.getElementById('address').value === u, app, {
      timeout: 10_000,
    });
    assert.match(await page.locator('.tab[aria-selected=true] .t').textContent(), /app/);
    assert.equal(await page.locator('#back').isDisabled(), false);

    await view.locator('#next').click();
    await page.waitForFunction(
      () => document.getElementById('address').value.endsWith('/static.html'),
      undefined,
      { timeout: 10_000 },
    );

    await page.click('#back');
    await page.waitForFunction(
      () => document.getElementById('address').value.includes('/app.html'),
      undefined,
      { timeout: 10_000 },
    );
    await page.close();
  });

  it('browser shell: new tab, switching and closing tabs', async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/`);
    await page.fill('#url', `http://127.0.0.1:${origin.port}/static.html`);
    await page.press('#url', 'Enter');
    await page.frameLocator('iframe.view').locator('h1').waitFor({ timeout: 20_000 });
    await page.click('#newtab');
    assert.equal(await page.locator('.tab').count(), 2);
    assert.equal(
      await page.locator('#homeview').isVisible(),
      true,
      'a new tab shows the home page',
    );
    assert.equal(await page.inputValue('#address'), '');
    await page.locator('.tab').first().click();
    assert.equal(
      await page.locator('#homeview').isVisible(),
      false,
      'the first tab shows its page again',
    );
    await page.locator('.tab').nth(1).locator('.x').click();
    assert.equal(await page.locator('.tab').count(), 1);
    await page.close();
  });

  it('browser shell: a refused address shows an error inside the frame, with a link back out', async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/`);
    await page.fill('#url', 'http://localhost/');
    await page.press('#url', 'Enter');
    const view = page.frameLocator('iframe.view');
    await view.getByText('Cannot open that address').waitFor({ timeout: 20_000 });
    assert.equal(
      await view.locator('a', { hasText: 'Back to Klyro' }).getAttribute('target'),
      '_top',
    );
    await page.close();
  });

  it('saves tabs and restores them after a reload, loading only the visible one at first', async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/`);
    const one = `http://127.0.0.1:${origin.port}/static.html`;
    const two = `http://127.0.0.1:${origin.port}/app.html?ws=1`;
    await page.fill('#url', one);
    await page.press('#url', 'Enter');
    await page.frameLocator('iframe.view').locator('h1').waitFor({ timeout: 20_000 });
    await page.click('#newtab');
    await page.fill('#url', two);
    await page.press('#url', 'Enter');
    await page.frameLocator('iframe.view >> nth=1').locator('#hi').waitFor({ timeout: 20_000 });
    await page.waitForFunction(
      (u) =>
        (JSON.parse(localStorage.getItem('klyro.tabs') ?? '{}').tabs ?? []).some(
          (t) => t.url === u,
        ),
      two,
      { timeout: 5000 },
    );

    await page.reload();
    assert.equal(await page.locator('.tab').count(), 2, 'both tabs came back');
    await page.frameLocator('iframe.view').locator('#hi').waitFor({ timeout: 20_000 });
    assert.equal(
      await page.locator('iframe.view').count(),
      1,
      'only the visible tab is loaded at first',
    );
    assert.equal(await page.inputValue('#address'), two, 'the address bar shows the real address');
    await page.locator('.tab').first().click();
    await page.frameLocator('iframe.view >> nth=1').locator('h1').waitFor({ timeout: 20_000 });
    assert.equal(
      await page.locator('iframe.view').count(),
      2,
      'the other tab loads when it is opened',
    );

    const saved = await page.evaluate(() => localStorage.getItem('klyro.tabs'));
    assert.ok(!saved.includes('/k/'), 'session paths are never saved');
    await page.close();
  });

  it('reopens a closed tab with Ctrl+Shift+T', async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/`);
    const url = `http://127.0.0.1:${origin.port}/static.html`;
    await page.fill('#url', url);
    await page.press('#url', 'Enter');
    await page.frameLocator('iframe.view').locator('h1').waitFor({ timeout: 20_000 });
    await page.click('.tab[aria-selected=true] .x');
    assert.equal(await page.locator('iframe.view').count(), 0);
    await page.keyboard.press('Control+Shift+T');
    await page.frameLocator('iframe.view').locator('h1').waitFor({ timeout: 20_000 });
    assert.equal(await page.inputValue('#address'), url);
    await page.close();
  });

  it('favorites: the star adds a tile, the tile opens it, and the star removes it', async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/`);
    const url = `http://127.0.0.1:${origin.port}/static.html`;
    await page.fill('#url', url);
    await page.press('#url', 'Enter');
    await page.frameLocator('iframe.view').locator('h1').waitFor({ timeout: 20_000 });
    await page.click('#star');
    assert.match((await page.getAttribute('#star', 'class')) ?? '', /on/);
    await page.click('#home');
    assert.equal(await page.locator('#favorites .fav').count(), 1);
    await page.locator('#favorites .fav').click();
    await page.frameLocator('iframe.view').locator('h1').waitFor({ timeout: 20_000 });
    await page.click('#star');
    assert.doesNotMatch((await page.getAttribute('#star', 'class')) ?? '', /\bon\b/);
    await page.click('#home');
    assert.equal(await page.locator('#favorites .fav').count(), 0);
    await page.close();
  });

  it('has no Recent list, deletes any old recent history, and can clear everything it saved', async () => {
    const page = await browser.newPage();
    await page.addInitScript(() =>
      localStorage.setItem('klyro.recent', JSON.stringify(['https://old.example/'])),
    );
    await page.goto(`${base}/`);
    assert.equal(await page.getByText('Recent', { exact: true }).count(), 0);
    assert.equal(
      await page.evaluate(() => localStorage.getItem('klyro.recent')),
      null,
      'old recent history was deleted',
    );
    await page.fill('#url', `http://127.0.0.1:${origin.port}/static.html`);
    await page.press('#url', 'Enter');
    await page.frameLocator('iframe.view').locator('h1').waitFor({ timeout: 20_000 });
    await page.click('#star');
    await page.click('#clear');
    const left = await page.evaluate(() => [
      localStorage.getItem('klyro.favorites'),
      localStorage.getItem('klyro.closed'),
    ]);
    assert.equal(left[0], '[]');
    await page.close();
  });

  it('browser shell: pin and group tabs, and get them back after a reload', async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/`);
    const url = (n) => `http://127.0.0.1:${origin.port}/static.html?n=${n}`;
    for (const n of [1, 2, 3]) {
      if (n > 1) await page.click('#newtab');
      await page.fill('#url', url(n));
      await page.press('#url', 'Enter');
      await page.frameLocator('iframe.view').last().locator('h1').waitFor({ timeout: 20_000 });
    }
    // group the second and third tab
    await page.locator('#tabs .tab').nth(1).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'New group with this tab' }).click();
    await page.keyboard.type('Reading');
    await page.keyboard.press('Enter');
    await page.locator('#tabs .tab').nth(2).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Reading' }).click();
    // pin the first tab
    await page.locator('#tabs .tab').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Pin tab' }).click();
    assert.equal(await page.locator('#pinned .tab').count(), 1);
    assert.equal(await page.locator('.group .gname').textContent(), 'Reading');
    assert.equal(await page.locator('.group .tab').count(), 2);

    await page.waitForFunction(
      () => JSON.parse(localStorage.getItem('klyro.tabs') ?? '{}').groups?.length === 1,
      undefined,
      { timeout: 5_000 },
    );
    await page.reload();
    assert.equal(await page.locator('#pinned .tab').count(), 1, 'the pinned tab came back');
    assert.equal(await page.locator('.group .gname').textContent(), 'Reading');
    assert.equal(await page.locator('.group .tab').count(), 2, 'the group kept its tabs');

    // collapsing hides the group's tabs except the selected one; ungrouping dissolves it
    await page.locator('.ghead').click();
    assert.equal(await page.locator('.group.collapsed').count(), 1);
    await page.locator('.ghead').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Ungroup' }).click();
    assert.equal(await page.locator('.group').count(), 0);
    await page.close();
  });

  it('shows the home page', async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/`);
    assert.equal(await page.textContent('h1'), 'Klyro');
    await page.close();
  });
});
