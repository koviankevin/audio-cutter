import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { startServer } from '../scripts/serve.mjs';
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright'
);
const { server, url } = process.env.SITE_URL
  ? { server: null, url: process.env.SITE_URL }
  : await startServer({ port: 0, base: '/audio-cutter/' });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
const context = await browser.newContext({ acceptDownloads: true }),
  page = await context.newPage(),
  errors = [];
page.on('dialog', (d) => d.accept());
page.on('pageerror', (e) => errors.push(e.message));
const files = () =>
  page.evaluate(async () => {
    try {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('yin-jian-export-cache');
      const list = [];
      for await (const name of dir.keys()) list.push(name);
      return list.sort();
    } catch {
      return [];
    }
  });
async function waitFiles(count) {
  await page.waitForFunction(async (count) => {
    try {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('yin-jian-export-cache');
      let n = 0;
      for await (const name of dir.keys()) if (!name.endsWith('.done')) n++;
      return n === count;
    } catch {
      return count === 0;
    }
  }, count);
}
async function assertProgressCleared() {
  assert.equal(await page.locator('#export-progress').isVisible(), false);
  for (const id of ['export-elapsed', 'export-speed', 'export-eta'])
    assert.equal(await page.locator(`#${id}`).textContent(), '');
}
async function exportWav(target = page) {
  const pending = target.waitForEvent('download');
  await target.locator('[name="format"][value="wav"]').check();
  await target.locator('#export-button').click();
  const download = await pending;
  assert.equal(await download.failure(), null);
  return download;
}
try {
  await page.goto(url);
  await page.locator('#load-demo').click();
  await page.locator('#workspace').waitFor({ state: 'visible' });
  await page.evaluate(() => {
    const Native = window.Worker;
    window.Worker = class extends Native {
      constructor(...args) {
        super(...args);
        if (String(args[0]).endsWith('/export-worker.js'))
          this.addEventListener('message', ({ data }) => {
            if (window.cancelNextExport && data.type === 'progress') {
              window.cancelNextExport = false;
              document.getElementById('cancel-export').click();
            }
          });
      }
    };
    window.cancelNextExport = true;
  });
  await page.locator('#export-button').click();
  await page.waitForFunction(() => document.getElementById('notice').textContent.includes('已取消匯出'));
  await waitFiles(0);
  await assertProgressCleared();
  assert.equal(await page.locator('#original-duration').textContent(), '00:18.000');
  // Inject a real storage failure into the Worker boundary after its first disk write.
  const original = await readFile('export-worker.js', 'utf8');
  await context.route('**/export-worker.js', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `const originalWrite=FileSystemSyncAccessHandle.prototype.write;let writes=0;FileSystemSyncAccessHandle.prototype.write=function(...args){if(++writes===2)throw new DOMException('test quota','QuotaExceededError');return originalWrite.apply(this,args);};\n${original}`,
    }),
  );
  await page.locator('[name="format"][value="wav"]').check();
  await page.locator('#export-button').click();
  await page.waitForFunction(() => document.getElementById('notice').textContent.includes('暫存空間不足'));
  await waitFiles(0);
  await assertProgressCleared();
  assert.equal(await page.locator('#export-button').isEnabled(), true);
  await context.unroute('**/export-worker.js');
  const first = await exportWav();
  await assertProgressCleared();
  await waitFiles(1);
  const active = (await files()).find((n) => !n.endsWith('.done'));
  const again = page.waitForEvent('download');
  await page.locator('#download-link').click();
  assert.equal(await (await again).failure(), null);
  // Another tab's sweep must preserve an active completed download.
  const other = await context.newPage();
  other.on('dialog', (d) => d.accept());
  await other.goto(url);
  await other.locator('#load-demo').click();
  await other.locator('#workspace').waitFor({ state: 'visible' });
  await exportWav(other);
  await waitFiles(2);
  assert.ok((await files()).includes(active));
  await other.close();
  // Retiring a completed result frees its Worker but preserves only disk data during grace.
  await page.locator('#selection-start').fill('1');
  await page.locator('#selection-end').fill('2');
  await page.locator('#selection-end').press('Enter');
  await page.locator('#add-deletion').click();
  await page.waitForFunction(async () => {
    const { held } = await navigator.locks.query();
    return !held.some((l) => l.name.startsWith('yin-jian-export-'));
  });
  assert.ok((await files()).includes(active));
  // Expire only these test-owned completion markers, then exercise the real sweep.
  await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('yin-jian-export-cache');
    for await (const name of dir.keys())
      if (name.endsWith('.done')) {
        const writer = await (await dir.getFileHandle(name)).createWritable();
        await writer.write('0');
        await writer.close();
      }
  });
  await exportWav();
  await waitFiles(1);
  assert.ok(!(await files()).includes(active));
  // A partial file left by a killed tab has no marker and must be swept immediately.
  const stale = await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('yin-jian-export-cache');
    const name = `out-${crypto.randomUUID()}.wav`;
    await dir.getFileHandle(name, { create: true });
    return name;
  });
  await exportWav();
  assert.ok(!(await files()).includes(stale));
  assert.deepEqual(errors, []);
  console.log(
    `PASS export lifecycle ${process.env.BROWSER_CHANNEL || 'chrome'}: cancel, quota failure, repeated download, cross-tab locks, grace expiry and stale partial cleanup; ${first.suggestedFilename()}`,
  );
} finally {
  await context.close();
  await browser.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}
