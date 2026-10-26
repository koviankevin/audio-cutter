import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

export const publicFiles = ['index.html','bootstrap.js','preferences.js','support.mjs','version.mjs','join-fades.mjs','CHANGELOG.md','LICENSE','source-identity.mjs','fingerprint-worker.mjs','project.mjs','project-session.mjs','draft-store.mjs','storage-check.mjs','style.css','favicon.svg','app.mjs','core.mjs','audio.mjs','waveform.mjs','pcm.mjs','export-worker.js','export-store.mjs','mp3-encoder.mjs','export-progress.mjs','media-window.mjs','chunk-source.mjs','stream-core.mjs','decode-worker.js','vendor/WasmMediaEncoder-0.7.0.min.js','vendor/lame-0.7.0.wasm','vendor/wasm-media-encoders-LICENSE.txt','vendor/lame-wasm-LICENSE.txt','vendor/mpg123-decoder.min.js','vendor/mpg123-decoder-LICENSE.txt','vendor/mpg123-LICENSE.txt','vendor/lame.min.js','vendor/lamejs-LICENSE.txt','vendor/README.md','.nojekyll'];
const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
export async function startServer({ port = 4173, base = '/', publicRoot = process.env.PUBLIC_ROOT } = {}) {
  const servedRoot = publicRoot ? path.resolve(root, publicRoot) : root;
  const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.wasm':'application/wasm', '.svg':'image/svg+xml', '.txt':'text/plain; charset=utf-8', '.md':'text/plain; charset=utf-8' };
  const server = http.createServer(async (req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { res.writeHead(400).end(); return; }
    if (!pathname.startsWith(base)) { res.writeHead(404).end('Not found'); return; }
    const name = pathname.slice(base.length) || 'index.html';
    if (!publicFiles.includes(name) && name !== 'manifest.json') { res.writeHead(404).end('Not found'); return; }
    try {
      const bytes = await readFile(path.join(servedRoot, name));
      res.writeHead(200, { 'Content-Type': mime[path.extname(name)] || 'text/plain', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch { res.writeHead(404).end('Not found'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, url: `http://127.0.0.1:${server.address().port}${base}` };
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const { url } = await startServer({ port: Number(process.env.PORT) || 4173 });
  console.log(`音剪 Local: ${url}`);
}
