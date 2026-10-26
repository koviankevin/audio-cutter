import { mkdir, copyFile, readFile, writeFile, lstat, realpath, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { APP_VERSION } from '../version.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicFiles } from './serve.mjs';
const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
if (JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version !== APP_VERSION)
  throw Error('App and package versions must match.');
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
if (lock.version !== APP_VERSION || lock.packages[''].version !== APP_VERSION)
  throw Error('Lockfile version must match the app version.');
const output = path.join(root, 'dist');
const existing = await lstat(output).catch((error) => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
if (existing) {
  const resolved = await realpath(output);
  if (
    existing.isSymbolicLink() ||
    path.dirname(resolved).toLowerCase() !== root.toLowerCase() ||
    path.basename(resolved).toLowerCase() !== 'dist'
  )
    throw Error('Refusing to replace an unexpected output directory.');
  await rm(output, { recursive: true, maxRetries: 3, retryDelay: 100 });
}
const files = {};
for (const file of publicFiles) {
  const target = path.join(root, 'dist', file);
  await mkdir(path.dirname(target), { recursive: true });
  if (!file.startsWith('vendor/') && /\.(?:m?js|css|html)$/.test(file)) {
    const source = await readFile(path.join(root, file), 'utf8');
    const versioned = source.replace(
      /(['"])(\.\/[\w./-]+\.(?:m?js|css|wasm|svg))\1/g,
      (_, quote, resource) => `${quote}${resource}?v=${APP_VERSION}${quote}`,
    );
    await writeFile(target, versioned);
  } else await copyFile(path.join(root, file), target);
  files[file] = createHash('sha256')
    .update(await readFile(target))
    .digest('hex');
}
await writeFile(
  path.join(root, 'dist', 'manifest.json'),
  JSON.stringify({ version: APP_VERSION, revision: process.env.GITHUB_SHA || null, files }, null, 2),
);
console.log(`Packaged ${publicFiles.length} public files into dist/.`);
