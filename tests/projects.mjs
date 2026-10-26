import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer } from '../scripts/serve.mjs';
import { wavHeader } from '../pcm.mjs';

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright'
);
const channel = process.env.BROWSER_CHANNEL || 'chrome';
const output = path.resolve('test-results', `projects-${channel}`);
await mkdir(output, { recursive: true });
const frames = 12 * 44100,
  pcm = Buffer.alloc(frames * 4);
for (let i = 0; i < frames; i++)
  for (let c = 0; c < 2; c++)
    pcm.writeInt16LE(
      Math.round(8000 * Math.sin((i / 44100) * Math.PI * 2 * (220 + c * 110 + Math.floor(i / 44100) * 55))),
      i * 4 + c * 2,
    );
const wav = Buffer.concat([Buffer.from(wavHeader(frames, 2, 44100)), pcm]);
const source = { name: 'tones.wav', mimeType: 'audio/wav', buffer: wav };
const { server, url } = process.env.SITE_URL
  ? { server: null, url: process.env.SITE_URL }
  : await startServer({ port: 0, base: '/audio-cutter/' });
const browser = await chromium.launch({ channel, headless: true });
const errors = [];
try {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto(url);
  await page.locator('#file-input').setInputFiles(source);
  await page.locator('#workspace').waitFor({ state: 'visible' });
  async function queue(start, end) {
    await page.locator('#selection-start').fill(String(start));
    await page.locator('#selection-end').fill(String(end));
    await page.locator('#selection-end').press('Enter');
    await page.locator('#add-deletion').click();
  }
  await queue(2, 4);
  await queue(6, 8);
  await page.locator('#export-name').fill('我的訪談');
  await page.locator('[name="format"][value="wav"]').check();
  await page.locator('#zoom').fill('2');
  await page.locator('#zoom').dispatchEvent('input');
  await page.waitForFunction(() => document.getElementById('project-status').textContent.startsWith('已自動保存'));
  const download = page.waitForEvent('download');
  await page.locator('#save-project').click();
  const projectPath = path.join(output, 'interview.yin-jian.json');
  await (await download).saveAs(projectPath);
  const project = JSON.parse(await readFile(projectPath, 'utf8'));
  assert.deepEqual(project.state.pending, [
    [2 * 44100, 4 * 44100],
    [6 * 44100, 8 * 44100],
  ]);
  assert.equal(project.history.states.length, 3);
  assert.equal(project.preferences.name, '我的訪談');
  assert.equal(project.source.kind, 'file');
  assert.equal(project.source.fingerprint.length, 64);

  // New page boot: persistent metadata is enough to offer recovery, with no audio stored.
  await page.reload();
  await page.locator('#draft-panel').waitFor({ state: 'visible' });
  await page.locator('#draft-panel summary').click();
  await page.locator('#draft-list .button').first().click();
  await page.locator('#restore-request').waitFor({ state: 'visible' });
  const wrong = Buffer.from(wav);
  wrong[wrong.length - 10] ^= 1;
  await page.locator('#file-input').setInputFiles({ ...source, buffer: wrong });
  await page.waitForFunction(() => document.getElementById('notice').textContent.includes('檔案內容與專案不同'));
  assert.equal(
    await page.locator('#workspace').isVisible(),
    false,
    'same-name/same-size wrong audio cannot apply edits',
  );
  await page.locator('#file-input').setInputFiles(source);
  await page.locator('#workspace').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#pending-count').textContent(), '2');
  assert.equal(await page.locator('#export-name').inputValue(), '我的訪談');
  assert.equal(await page.locator('#zoom').inputValue(), '2');
  assert.equal(await page.locator('[name="format"][value="wav"]').isChecked(), true);
  assert.equal(await page.locator('#selection-start').inputValue(), '00:06.000');
  await page.locator('#undo').click();
  assert.equal(await page.locator('#pending-count').textContent(), '1');
  await page.locator('#redo').click();
  assert.equal(await page.locator('#pending-count').textContent(), '2');

  // Capacity failure preserves the pending queue, then normal retry produces exact PCM.
  await page.evaluate(() => {
    const estimate = navigator.storage.estimate.bind(navigator.storage);
    navigator.storage.estimate = () => (window.testLowQuota ? Promise.resolve({ quota: 1000, usage: 0 }) : estimate());
    window.testLowQuota = true;
  });
  await page.locator('#export-button').click();
  await page.waitForFunction(() => document.getElementById('notice').textContent.includes('空間不足'));
  assert.equal(await page.locator('#pending-count').textContent(), '2');
  assert.equal(await page.locator('#export-result').isVisible(), false);
  await page.evaluate(() => (window.testLowQuota = false));
  await page.locator('#export-button').click();
  await page.locator('#export-result').waitFor({ state: 'visible' });
  const audioDownload = page.waitForEvent('download');
  await page.locator('#download-link').click();
  const audioPath = path.join(output, 'restored.wav');
  await (await audioDownload).saveAs(audioPath);
  const actual = await readFile(audioPath);
  const expected = Buffer.concat([
    pcm.subarray(0, 2 * 44100 * 4),
    pcm.subarray(4 * 44100 * 4, 6 * 44100 * 4),
    pcm.subarray(8 * 44100 * 4),
  ]);
  assert.equal(actual.readUInt32LE(40), expected.length);
  assert.deepEqual(actual.subarray(44), expected);

  // Failed replacement keeps the existing editor, even if the new file has no usable audio.
  await page
    .locator('#file-input')
    .setInputFiles({ name: 'broken.wav', mimeType: 'audio/wav', buffer: Buffer.from('invalid audio bytes') });
  await page.waitForFunction(() => document.getElementById('notice').textContent.includes('無法讀取'));
  assert.equal(await page.locator('#workspace').isVisible(), true);
  assert.equal(await page.locator('#file-name').textContent(), 'tones.wav');
  assert.equal(await page.locator('#output-duration').textContent(), '00:08.000');
  await page.locator('#undo').click();
  assert.equal(await page.locator('#pending-count').textContent(), '2');
  await page.locator('#redo').click();
  assert.equal(await page.locator('#output-duration').textContent(), '00:08.000');
  await page.evaluate(() => {
    const read = Blob.prototype.arrayBuffer;
    window.slowFileRead = true;
    Blob.prototype.arrayBuffer = async function () {
      if (window.slowFileRead) await new Promise((resolve) => setTimeout(resolve, 400));
      return read.call(this);
    };
  });
  await page.locator('#file-input').setInputFiles(source);
  await page.locator('#loading').waitFor({ state: 'visible' });
  await page.locator('#cancel-load').click();
  await page.evaluate(() => (window.slowFileRead = false));
  await page.waitForTimeout(500);
  assert.equal(await page.locator('#workspace').isVisible(), true, 'cancelled replacement retains original workspace');
  assert.equal(
    await page.locator('#output-duration').textContent(),
    '00:08.000',
    'late identity reads cannot replace restored state',
  );
  await page.setViewportSize({ width: 390, height: 900 });
  await page.locator('[name="font-size"][value="extra-large"]').check();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(output, 'recovered-mobile.png'), fullPage: true });

  // A separate browser profile can restore a downloaded project by reselecting the original.
  const portableContext = await browser.newContext();
  const portable = await portableContext.newPage();
  portable.on('pageerror', (error) => errors.push(error.message));
  await portable.goto(url);
  await portable.locator('#project-input').setInputFiles(projectPath);
  await portable.locator('#restore-request').waitFor({ state: 'visible' });
  await portable.locator('#file-input').setInputFiles(source);
  await portable.locator('#workspace').waitFor({ state: 'visible' });
  assert.equal(await portable.locator('#pending-count').textContent(), '2');
  const before = await portable.locator('#pending-summary').textContent();
  await portable.locator('#project-input').setInputFiles({
    name: 'bad.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ ...project, version: 9 })),
  });
  await portable.waitForFunction(() => document.getElementById('notice').textContent.includes('專案內容不完整'));
  assert.equal(await portable.locator('#pending-summary').textContent(), before);

  const sibling = await portableContext.newPage();
  await sibling.goto(url);
  await sibling.locator('#file-input').setInputFiles(source);
  await sibling.locator('#workspace').waitFor({ state: 'visible' });
  await sibling.locator('#selection-start').fill('1');
  await sibling.locator('#selection-end').fill('2');
  await sibling.locator('#selection-end').press('Enter');
  await sibling.locator('#add-deletion').click();
  await sibling.waitForFunction(() => document.getElementById('project-status').textContent.startsWith('已自動保存'));
  const documents = await sibling.evaluate(async () => {
    const { DraftStore } = await import('./draft-store.mjs'),
      store = new DraftStore();
    return Promise.all((await store.list()).map(async (item) => (await store.get(item.id)).project.state.pending));
  });
  assert.equal(documents.length, 2, 'two tabs keep independent documents for the same source');
  assert.ok(documents.some((parts) => parts.length === 2));
  assert.ok(documents.some((parts) => parts.length === 1 && parts[0][0] === 44100));

  const blockedContext = await browser.newContext({ acceptDownloads: true });
  await blockedContext.addInitScript(() =>
    Object.defineProperty(window, 'indexedDB', {
      get() {
        throw new DOMException('Blocked', 'SecurityError');
      },
    }),
  );
  const blocked = await blockedContext.newPage();
  blocked.on('pageerror', (error) => errors.push(error.message));
  await blocked.goto(url);
  await blocked.locator('#load-demo').click();
  await blocked.locator('#workspace').waitFor({ state: 'visible' });
  await blocked.waitForFunction(() => document.getElementById('project-status').textContent.includes('保存失敗'));
  const fallbackDownload = blocked.waitForEvent('download');
  await blocked.locator('#save-project').click();
  const fallbackPath = path.join(output, 'fallback.json');
  await (await fallbackDownload).saveAs(fallbackPath);
  assert.equal(JSON.parse(await readFile(fallbackPath, 'utf8')).source.kind, 'demo');
  const quotaContext = await browser.newContext();
  await quotaContext.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    window.failDraftWrites = true;
    IDBObjectStore.prototype.put = function (...args) {
      if (window.failDraftWrites && this.transaction.db.name === 'yin-jian-projects')
        throw new DOMException('Full', 'QuotaExceededError');
      return put.apply(this, args);
    };
  });
  const quota = await quotaContext.newPage();
  quota.on('pageerror', (error) => errors.push(error.message));
  await quota.goto(url);
  await quota.locator('#load-demo').click();
  await quota.locator('#workspace').waitFor({ state: 'visible' });
  await quota.waitForFunction(() => document.getElementById('project-status').textContent.includes('保存失敗'));
  await quota.evaluate(() => (window.failDraftWrites = false));
  await quota.locator('#export-name').fill('儲存已恢復');
  await quota.waitForFunction(() => document.getElementById('project-status').textContent.startsWith('已自動保存'));
  assert.equal(await quota.locator('#file-name').textContent(), '午後練習曲.wav');
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(
      {
        browser: channel,
        passed: true,
        sha: process.env.GITHUB_SHA || null,
        checks: [
          'draft reload',
          'all-byte identity',
          'portable project',
          'history',
          'quota retry',
          'PCM samples',
          'failed replacement recovery',
          'blocked storage',
          'mobile',
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    `PASS ${channel}: project recovery, original-file identity, portable backups, undo/redo, capacity checks, exact WAV output, failed replacements, blocked storage and mobile layout`,
  );
} finally {
  await browser.close();
  server?.close();
}
