import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { APP_VERSION } from '../version.mjs';
import { publicFiles } from '../scripts/serve.mjs';
const root = path.resolve(process.env.PUBLIC_ROOT || 'dist');
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
assert.equal(manifest.version, APP_VERSION);
async function walk(dir, prefix = '') {
  const items = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = prefix + entry.name;
    if (entry.isDirectory()) items.push(...(await walk(path.join(dir, entry.name), file + '/')));
    else items.push(file);
  }
  return items;
}
assert.deepEqual(
  (await walk(root)).sort(),
  [...publicFiles, 'manifest.json'].sort(),
  'artifact contains only declared public resources',
);
for (const file of publicFiles) {
  const bytes = await readFile(path.join(root, file));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.files[file], `manifest matches ${file}`);
  if (file.startsWith('vendor/'))
    assert.deepEqual(bytes, await readFile(file), `third-party asset remains unmodified: ${file}`);
  else if (/\.(m?js|html|css)$/.test(file)) {
    for (const match of bytes.toString('utf8').matchAll(/(['"])(\.\/[^\s'"<>]+)\1/g)) {
      const resource = new URL(match[2], 'https://example.test/audio-cutter/');
      if (/\.(m?js|css|wasm|svg)$/.test(resource.pathname)) {
        assert.equal(resource.searchParams.get('v'), APP_VERSION, `cache version on ${file}: ${match[2]}`);
        assert.ok(publicFiles.includes(resource.pathname.replace('/audio-cutter/', '')));
      }
    }
  }
}
console.log(
  `PASS artifact: ${publicFiles.length} declared resources, matching hashes, versioned module/worker URLs, unchanged vendor files and no obsolete assets`,
);
