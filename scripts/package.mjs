import { mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicFiles } from './serve.mjs';
const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
for (const file of publicFiles) {
  const target = path.join(root, 'dist', file);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(root, file), target);
}
console.log(`Packaged ${publicFiles.length} public files into dist/.`);
