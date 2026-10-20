// Minimal static dev server (no dependencies).
//   node server.mjs [port]
// Serves this folder. POST /__shot?name=foo.png stores a PNG (sent as raw body)
// into ./shots — used for automated visual checks.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || process.env.PORT || 8080);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wgsl': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

// Reject private paths both before and after resolving symlinks. Git ignores
// alone do not keep credentials out of a static server's responses.
function privatePath(root, file) {
  const relative = path.relative(root, file);
  return path.isAbsolute(relative) || relative.split(path.sep).some(part => part.startsWith('.'));
}

export function createDevServer({ directory = root } = {}) {
  const servedRoot = fs.realpathSync(directory);
  return http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch { res.writeHead(400); res.end('bad request'); return; }
  if (req.method === 'POST' && url.pathname === '/__shot') {
    const name = path.basename(url.searchParams.get('name') || 'shot.png');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const dir = path.join(servedRoot, 'shots');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), Buffer.concat(chunks));
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      console.log('saved shot', name);
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/__log') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      console.log('[client]', Buffer.concat(chunks).toString());
      res.end('ok');
    });
    return;
  }
  let p;
  try { p = decodeURIComponent(url.pathname); }
  catch { res.writeHead(400); res.end('bad request'); return; }
  if (p.includes('\0') || p.includes('\\')) { res.writeHead(400); res.end('bad request'); return; }
  if (p.split('/').some(part => part.startsWith('.'))) { res.writeHead(403); res.end(); return; }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.resolve(servedRoot, '.' + p);
  if (privatePath(servedRoot, file)) { res.writeHead(403); res.end(); return; }
  fs.realpath(file, (err, resolved) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    if (privatePath(servedRoot, resolved)) { res.writeHead(403); res.end(); return; }
    fs.readFile(resolved, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, {
        'content-type': types[path.extname(file)] || 'application/octet-stream',
        'content-length': data.length,
        'cache-control': 'no-store',
      });
      res.end(data);
    });
  });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  createDevServer().listen(port, () => console.log(`ocean dev server: http://localhost:${port}/`));
}
