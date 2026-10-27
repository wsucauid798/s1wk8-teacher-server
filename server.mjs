// TEACHER BACKEND: deployed once to the teacher's Render Web Service.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { AccessToken } from 'livekit-server-sdk';
import sharp from 'sharp';
import { serveFile } from './lib/files.mjs';
import { reverseWav } from './lib/wav.mjs';
import { attachRooms } from './lib/rooms.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
try {
  const env = await readFile(new URL('.env', import.meta.url), 'utf8');
  for (const line of env.split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {}
if (
  process.env.NODE_ENV === 'production' &&
  (!process.env.CLASS_CODE || process.env.CLASS_CODE === 'replace-with-your-class-code')
)
  throw new Error('Set your own CLASS_CODE in Render Environment.');
const code = process.env.CLASS_CODE || '';
const cache = new Map();
let processing = 0;
const processingQueue = [];
function processingSlot() {
  return new Promise((resolve, reject) => {
    if (processingQueue.length >= 200) {
      reject(new Error('The processing queue is full. Try again shortly.'));
      return;
    }
    const begin = () => {
      processing++;
      resolve(() => {
        processing--;
        processingQueue.shift()?.();
      });
    };
    if (processing < 1) begin();
    else processingQueue.push(begin);
  });
}
function json(res, status, obj) {
  res
    .writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    .end(JSON.stringify(obj));
}
async function body(req, max = 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > max) throw new Error(`File too large. Maximum ${Math.round(max / 1024 / 1024)} MB.`);
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
async function remote(url, headers = {}) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(18000) });
  if (!r.ok)
    throw new Error(
      `The external service returned ${r.status}. Try again or check the teacher's API configuration.`,
    );
  return r.json();
}
async function cached(key, fn) {
  const old = cache.get(key);
  if (old && old.exp > Date.now()) return old.value;
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  const value = Promise.resolve().then(fn);
  cache.set(key, { value, exp: Date.now() + 300000 });
  try {
    return await value;
  } catch (e) {
    cache.delete(key);
    throw e;
  }
}
async function search(kind, q, limit) {
  return cached(`search:${kind}:${q}:${limit}`, async () => {
    if (kind === 'image') {
      const found = await remote(
        `https://collectionapi.metmuseum.org/public/collection/v1.1/search?hasImages=true&q=${encodeURIComponent(q)}&limit=${limit * 3}`,
      );
      const objects = [];
      const ids = (found.objectIDs || []).slice(0, limit * 3);
      // Sequential requests keep a whole class from flooding the museum API.
      for (const id of ids) {
        try {
          const o = await remote(
            `https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`,
          );
          if (o.isPublicDomain && o.primaryImage)
            objects.push({
              title: o.title,
              creator: o.artistDisplayName || o.culture || 'The Met',
              url: o.primaryImage,
              thumbnail: o.primaryImageSmall || o.primaryImage,
              credit: o.creditLine,
              source: o.objectURL,
              licence: 'Public domain',
            });
        } catch {}
        if (objects.length === limit) break;
      }
      return { provider: 'The Met Collection API', items: objects };
    }
    if (kind === 'sound') {
      if (!process.env.FREESOUND_API_KEY)
        throw new Error(
          'Sound search needs the teacher to configure FREESOUND_API_KEY on Render. Image search does not need a key.',
        );
      const data = await remote(
        `https://freesound.org/apiv2/search/text/?query=${encodeURIComponent(q)}&page_size=${limit}&fields=id,name,username,previews,url,license`,
        { Authorization: `Token ${process.env.FREESOUND_API_KEY}` },
      );
      return {
        provider: 'Freesound API',
        items: data.results.map((s) => ({
          title: s.name,
          creator: s.username,
          url: s.previews['preview-hq-mp3'] || s.previews['preview-lq-mp3'],
          source: s.url,
          licence: s.license,
        })),
      };
    }
    if (kind === 'video') {
      if (!process.env.PEXELS_API_KEY)
        throw new Error('Video search needs the teacher to configure PEXELS_API_KEY on Render.');
      const data = await remote(
        `https://api.pexels.com/v1/videos/search?query=${encodeURIComponent(q)}&per_page=${limit}`,
        { Authorization: process.env.PEXELS_API_KEY },
      );
      return {
        provider: 'Pexels API',
        items: data.videos.flatMap((v) => {
          const file = v.video_files
            .filter((f) => f.file_type === 'video/mp4')
            .sort((a, b) => Math.abs((a.width || 0) - 640) - Math.abs((b.width || 0) - 640))[0];
          return file
            ? [
                {
                  title: `Video ${v.id}`,
                  creator: v.user.name,
                  url: file.link,
                  thumbnail: v.image,
                  source: v.url,
                  licence: 'Pexels licence',
                },
              ]
            : [];
        }),
      };
    }
    throw new Error('Choose image, sound or video.');
  });
}
const requests = new Map();
export const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Class-Code');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  const u = new URL(req.url, 'http://server');
  if (u.pathname === '/health') {
    json(res, 200, { ok: true });
    return;
  }
  if (!u.pathname.startsWith('/api/')) {
    await serveFile(req, res, root);
    return;
  }
  if (code && req.headers['x-class-code'] !== code) {
    json(res, 401, { error: 'Check the class code supplied by your teacher.' });
    return;
  }
  const ip = req.socket.remoteAddress,
    now = Date.now();
  const rate = requests.get(ip) || { time: now, count: 0 };
  if (now - rate.time > 60000) {
    rate.time = now;
    rate.count = 0;
  }
  requests.set(ip, rate);
  // A classroom may share a public IP. This is a guard, not a per-student quota.
  if (++rate.count > 3000) {
    json(res, 429, { error: 'Too many requests. Wait a minute.' });
    return;
  }
  try {
    if (u.pathname === '/api/status' && req.method === 'GET') {
      json(res, 200, {
        ok: true,
        livekit: !!(
          process.env.LIVEKIT_URL &&
          process.env.LIVEKIT_API_KEY &&
          process.env.LIVEKIT_API_SECRET
        ),
        soundSearch: !!process.env.FREESOUND_API_KEY,
        videoSearch: !!process.env.PEXELS_API_KEY,
      });
      return;
    }
    if (u.pathname === '/api/search' && req.method === 'GET') {
      const q = (u.searchParams.get('q') || '').trim().slice(0, 100);
      if (!q) throw new Error('Enter a search term.');
      json(
        res,
        200,
        await search(
          u.searchParams.get('kind'),
          q,
          Math.max(1, Math.min(8, Number(u.searchParams.get('limit')) || 4)),
        ),
      );
      return;
    }
    if (u.pathname === '/api/weather' && req.method === 'GET') {
      const places = {
        Shanghai: [31.23, 121.47],
        London: [51.51, -0.13],
        Cairo: [30.04, 31.24],
        Reykjavik: [64.15, -21.94],
      };
      const place = u.searchParams.get('place');
      if (!places[place]) throw new Error('Choose a listed place.');
      const [lat, lon] = places[place];
      const data = await cached('weather:' + place, () =>
        remote(
          `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,wind_speed_10m&timezone=auto`,
        ),
      );
      json(res, 200, {
        provider: 'Open-Meteo',
        place,
        time: data.current.time,
        temperature: data.current.temperature_2m,
        wind: data.current.wind_speed_10m,
        units: data.current_units,
      });
      return;
    }
    if (u.pathname === '/api/process' && req.method === 'POST') {
      const release = await processingSlot();
      try {
        const input = await body(req, 12 * 1024 * 1024);
        if (u.searchParams.get('kind') === 'sound') {
          const out = reverseWav(input);
          res
            .writeHead(200, {
              'Content-Type': 'audio/wav',
              'Content-Disposition': 'attachment; filename="reversed.wav"',
              'X-Processing': 'Server reversed PCM sample frames',
            })
            .end(out);
          return;
        }
        const width = Math.round(
          Math.max(64, Math.min(1600, Number(u.searchParams.get('width')) || 480)),
        );
        let task = sharp(input, { limitInputPixels: 12000000 })
          .rotate()
          .resize({ width, withoutEnlargement: true });
        if (u.searchParams.get('grey') === 'true') task = task.grayscale();
        const out = await task.png().toBuffer();
        res
          .writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Disposition': 'attachment; filename="processed.png"',
          })
          .end(out);
        return;
      } finally {
        release();
      }
    }
    if (u.pathname === '/api/livekit-token' && req.method === 'POST') {
      if (
        !process.env.LIVEKIT_URL ||
        !process.env.LIVEKIT_API_KEY ||
        !process.env.LIVEKIT_API_SECRET
      )
        throw new Error(
          'The teacher must configure the LiveKit URL, API key and API secret on Render.',
        );
      const data = JSON.parse((await body(req, 4096)).toString());
      const exercise = Number(data.exercise);
      if (![8, 9, 10].includes(exercise)) throw new Error('Invalid exercise.');
      const channel = String(data.room || 'class');
      if (!/^[a-zA-Z0-9_-]{1,48}$/.test(channel))
        throw new Error('Room: use letters, numbers, hyphens or underscores.');
      const token = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
        identity: randomUUID(),
        name: String(data.name || 'Participant').slice(0, 40),
        ttl: '2h',
      });
      token.addGrant({
        roomJoin: true,
        room: `w8-${exercise}-${channel}`,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
      });
      json(res, 200, { url: process.env.LIVEKIT_URL, token: await token.toJwt() });
      return;
    }
    json(res, 404, { error: 'Unknown endpoint.' });
  } catch (e) {
    json(res, 400, { error: e.message || 'The request could not be completed.' });
  }
});
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16384 });
attachRooms(wss, { classCode: code });
server.listen(Number(process.env.PORT || 8081), '0.0.0.0', () =>
  console.log(`Teacher service listening on port ${process.env.PORT || 8081}`),
);
const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [ip, r] of requests) if (now - r.time > 60000) requests.delete(ip);
}, 60000);
cleanup.unref();
process.on('SIGTERM', () => {
  for (const ws of wss.clients) ws.close(1001, 'Service restarting. Rejoin the room.');
  wss.close();
  server.close();
  setTimeout(() => process.exit(0), 5000).unref();
});
