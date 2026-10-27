import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
};
export async function serveFile(req, res, root) {
  let name;
  try {
    name = decodeURIComponent(new URL(req.url, 'http://local').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (name.includes('\\') || name.includes('\0')) {
    res.writeHead(403).end();
    return;
  }
  if (name === '/') name = '/index.html';
  if (
    !['/index.html', '/shared/', '/Exercises/', '/Assets/', '/vendor/'].some((p) =>
      p.endsWith('/') ? name.startsWith(p) : name === p,
    )
  ) {
    res.writeHead(404).end('Not found');
    return;
  }
  const file = path.resolve(root, '.' + name);
  if (
    !file.startsWith(path.resolve(root) + path.sep) ||
    name.split('/').some((p) => p.startsWith('.'))
  ) {
    res.writeHead(403).end();
    return;
  }
  let info;
  try {
    info = await stat(file);
  } catch {
    res.writeHead(404).end('Not found');
    return;
  }
  if (!info.isFile()) {
    res.writeHead(404).end('Not found');
    return;
  }
  const headers = {
    'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m) {
      res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end();
      return;
    }
    let start = m[1] ? Number(m[1]) : Math.max(0, info.size - Number(m[2]));
    let end = m[1] ? (m[2] ? Number(m[2]) : info.size - 1) : info.size - 1;
    end = Math.min(end, info.size - 1);
    if (start > end || start >= info.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end();
      return;
    }
    res.writeHead(206, {
      ...headers,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${info.size}`,
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': info.size });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).pipe(res);
  }
}
