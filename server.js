import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { handleApi } from './src/api.js';
import { store } from './src/store.js';
import { runner } from './src/runner.js';
import { PUBLIC_DIR } from './src/util.js';

const PORT = Number(process.env.PORT || 4399);
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const data = await fsp.readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  return serveStatic(req, res, url);
});

server.on('clientError', (_err, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));

await store.init();

server.listen(PORT, HOST, () => {
  const banner = [
    '',
    '  TestBench · Web 测试平台',
    `  ➜  本地地址: http://${HOST}:${PORT}`,
    `  ➜  数据目录: ${store.runsDir.replace(/\/runs$/, '')}`,
    '',
  ].join('\n');
  console.log(banner);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log('\n正在停止任务并退出…');
    await runner.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  });
}
