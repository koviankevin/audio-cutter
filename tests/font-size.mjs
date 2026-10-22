import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { startServer } from '../scripts/serve.mjs';

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright'
);
const channel = process.env.BROWSER_CHANNEL || 'chrome';
const { server, url } = process.env.SITE_URL
  ? { server: null, url: process.env.SITE_URL }
  : await startServer({ port: 0, base: '/audio-cutter/' });
const browser = await chromium.launch({ channel, headless: true });
const output = `test-results/font-size-${channel}`;
await mkdir(output, { recursive: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage(),
    errors = [];
  await page.addInitScript(() => {
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
      if (text === 'ORIGINAL TIMELINE') window.timelineFont = this.font;
      return fillText.call(this, text, ...args);
    };
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  const size = () =>
    page.evaluate(() => ({
      mode: document.documentElement.dataset.fontSize,
      body: parseFloat(getComputedStyle(document.body).fontSize),
      field: parseFloat(getComputedStyle(document.querySelector('#selection-start')).fontSize),
      hint: parseFloat(getComputedStyle(document.querySelector('.multi-select-hint')).fontSize),
    }));
  assert.deepEqual(await size(), { mode: 'standard', body: 16, field: 16, hint: 14 });
  const other = await context.newPage();
  await other.goto(url);
  await page.locator('[name="font-size"][value="large"]').check();
  await other.waitForFunction(() => document.documentElement.dataset.fontSize === 'large');
  assert.equal(await other.locator('[name="font-size"][value="large"]').isChecked(), true);
  // Native radios support keyboard navigation without triggering editor shortcuts.
  await page.locator('[name="font-size"][value="large"]').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal((await size()).mode, 'extra-large');
  await page.reload();
  assert.deepEqual(await size(), { mode: 'extra-large', body: 20, field: 20, hint: 17.5 });
  await page.locator('#load-demo').click();
  await page.locator('#workspace').waitFor({ state: 'visible' });
  await page.locator('#selection-start').fill('2');
  await page.locator('#selection-end').fill('4');
  await page.locator('#selection-end').press('Enter');
  await page.locator('#add-deletion').click();
  const summary = await page.locator('#pending-summary').textContent();
  // The completed player is the narrowest and most text-heavy panel.
  await page.locator('#export-button').click();
  await page.locator('#export-result').waitFor({ state: 'visible' });
  const resultURL = await page.locator('#result-audio').getAttribute('src');
  for (const [mode, scale] of [
    ['standard', 1],
    ['large', 1.125],
    ['extra-large', 1.25],
  ]) {
    await page.locator(`[name="font-size"][value="${mode}"]`).check();
    assert.deepEqual(await size(), { mode, body: 16 * scale, field: 16 * scale, hint: 14 * scale });
    assert.equal(
      await page.locator('#result-audio').getAttribute('src'),
      resultURL,
      'font changes preserve exported audio',
    );
    assert.equal(await page.locator('#export-result').isVisible(), true);
    for (const width of [1440, 1280, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false, `${mode} layout fits ${width}px`);
      const timeFits = await page
        .locator('#selection-start')
        .evaluate((input) => input.scrollWidth <= input.clientWidth + 1);
      assert.equal(timeFits, true, `${mode} full millisecond time fits ${width}px`);
      // A correctly scaled timeline label uses the same 14px baseline as hints.
      await page.waitForFunction((expected) => window.timelineFont?.startsWith(`${expected}px`), 14 * scale);
      if ([1440, 390, 320].includes(width))
        await page.screenshot({ path: `${output}/${mode}-${width}.png`, fullPage: true });
    }
  }
  await page.locator('#undo').click();
  assert.equal(await page.locator('#export-result').isVisible(), false, 'font changes do not add undo steps');
  assert.equal(await page.locator('#pending-panel').isVisible(), true);
  assert.equal(await page.locator('#pending-summary').textContent(), summary);
  await page.locator('[name="font-size"][value="standard"]').check();
  await page.reload();
  assert.equal((await size()).mode, 'standard', 'returning to standard persists too');
  await page.evaluate(() => localStorage.setItem('audio-cutter:font-size', 'invalid'));
  await page.reload();
  assert.equal((await size()).mode, 'standard');
  await page.evaluate(() => localStorage.clear());
  await other.waitForFunction(() => document.documentElement.dataset.fontSize === 'standard');
  assert.deepEqual(errors, []);

  const blocked = await browser.newContext();
  await blocked.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new DOMException('Blocked', 'SecurityError');
      },
    });
  });
  const fallback = await blocked.newPage();
  await fallback.goto(url);
  await fallback.locator('[name="font-size"][value="extra-large"]').check();
  assert.equal(await fallback.locator('#font-size-storage-note').isVisible(), true);
  assert.equal(await fallback.evaluate(() => getComputedStyle(document.body).fontSize), '20px');
  await fallback.locator('#load-demo').click();
  await fallback.locator('#workspace').waitFor({ state: 'visible' });
  console.log(
    `PASS ${channel}: three font sizes, canvas scaling, persistent/default/blocked storage, cross-tab sync, keyboard selection, unchanged audio/history, 320–1440px layouts`,
  );
} finally {
  await browser.close();
  server?.close();
}
