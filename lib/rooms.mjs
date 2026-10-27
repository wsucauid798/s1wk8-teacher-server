import { randomUUID } from 'node:crypto';
const clamp = (v, a, b) => Math.max(a, Math.min(b, Number(v) || 0));
const send = (ws, obj) => {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
};
export function attachRooms(wss, { classCode = '' } = {}) {
  const rooms = new Map();
  function broadcast(r, msg) {
    for (const c of r.clients.values()) send(c.ws, msg);
  }
  function presence(r) {
    broadcast(r, {
      type: 'presence',
      peers: [...r.clients.values()].map((c) => ({ id: c.id, name: c.name, allow: c.allow })),
      host: r.host,
    });
  }
  function initial(ex) {
    return ex === 4
      ? { segments: [] }
      : ex === 6
        ? { round: 1, rule: 'majority', votes: {}, clip: 'intro', open: true }
        : ex === 7
          ? {
              grid: Array.from({ length: 4 }, () => Array(8).fill(false)),
              playing: false,
              bpm: 100,
              start: 0,
            }
          : {};
  }
  function state(r) {
    broadcast(r, { type: 'state', state: r.state, serverTime: Date.now() });
  }
  wss.on('connection', (ws) => {
    let client = null,
      room = null,
      tick = Date.now(),
      count = 0;
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('message', (raw) => {
      if (Date.now() - tick > 1000) {
        tick = Date.now();
        count = 0;
      }
      if (++count > 150) {
        ws.close(1008, 'Too many events');
        return;
      }
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      if (!client) {
        if (m.type !== 'join' || (classCode && m.code !== classCode)) {
          send(ws, { type: 'error', message: 'Check the class code.' });
          ws.close(1008);
          return;
        }
        const ex = Number(m.exercise),
          name = String(m.name || 'Participant')
            .trim()
            .slice(0, 40),
          channel = String(m.room || 'class').trim();
        if (![4, 5, 6, 7].includes(ex) || !/^[a-zA-Z0-9_-]{1,48}$/.test(channel)) {
          ws.close(1008, 'Invalid exercise or room');
          return;
        }
        const key = `${ex}:${channel}`;
        if (!rooms.has(key))
          rooms.set(key, { key, ex, clients: new Map(), state: initial(ex), last: Date.now() });
        room = rooms.get(key);
        if (room.clients.size >= 200) {
          ws.close(1013, 'Room full');
          return;
        }
        client = { id: randomUUID(), name, ws, allow: '' };
        room.clients.set(client.id, client);
        room.host ||= client.id;
        send(ws, { type: 'welcome', id: client.id, state: room.state, serverTime: Date.now() });
        presence(room);
        return;
      }
      room.last = Date.now();
      if (m.type === 'ping') {
        send(ws, { type: 'pong', stamp: m.stamp, serverTime: Date.now() });
        return;
      }
      if (room.ex === 4) {
        if (m.type === 'draw') {
          const seg = {
            x: clamp(m.x, 0, 1),
            y: clamp(m.y, 0, 1),
            px: clamp(m.px, 0, 1),
            py: clamp(m.py, 0, 1),
            size: clamp(m.size, 1, 80),
            colour: /^#[0-9a-f]{6}$/i.test(m.colour) ? m.colour : '#2563eb',
            owner: client.id,
          };
          if (room.state.segments.length >= 12000) {
            send(ws, {
              type: 'error',
              message: 'Canvas full. Clear your marks or begin a new room.',
            });
            return;
          }
          room.state.segments.push(seg);
          broadcast(room, { type: 'draw', segment: seg });
        } else if (m.type === 'clear-mine') {
          room.state.segments = room.state.segments.filter((s) => s.owner !== client.id);
          state(room);
        }
      }
      if (room.ex === 5) {
        if (m.type === 'allow') {
          client.allow = room.clients.has(m.controller) ? m.controller : '';
          presence(room);
        } else if (m.type === 'command') {
          const target = room.clients.get(m.target);
          if (!target || target.allow !== client.id) {
            send(ws, { type: 'error', message: 'The receiver must grant you control first.' });
            return;
          }
          const actions = ['play', 'pause', 'seek', 'volume', 'scale', 'mode'];
          if (!actions.includes(m.action)) return;
          const values = {
            seek: clamp(m.value, 0, 30),
            volume: clamp(m.value, 0, 1),
            scale: clamp(m.value, 0.3, 2),
          };
          const value =
            m.action === 'mode'
              ? ['image', 'sound', 'video'].includes(m.value)
                ? m.value
                : 'image'
              : values[m.action];
          send(target.ws, {
            type: 'command',
            from: client.id,
            name: client.name,
            action: m.action,
            value,
          });
        } else if (m.type === 'ack' && m.to === client.allow) {
          const to = room.clients.get(m.to);
          if (to)
            send(to.ws, {
              type: 'ack',
              from: client.name,
              playing: !!m.playing,
              time: clamp(m.time, 0, 3600),
              mode: String(m.mode).slice(0, 10),
            });
        }
      }
      if (room.ex === 6) {
        const s = room.state;
        if (m.type === 'vote' && s.open && ['a', 'b', 'c'].includes(m.choice)) {
          s.votes[client.id] = m.choice;
          state(room);
        }
        if (client.id === room.host) {
          if (m.type === 'rule' && ['majority', 'minority'].includes(m.value) && s.open) {
            s.rule = m.value;
            state(room);
          }
          if (m.type === 'resolve' && s.open) {
            const totals = ['a', 'b', 'c']
              .map((k) => [k, Object.values(s.votes).filter((v) => v === k).length])
              .filter((x) => x[1] > 0);
            if (!totals.length) {
              send(ws, { type: 'error', message: 'Collect a vote first.' });
              return;
            }
            totals.sort(
              (a, b) =>
                (s.rule === 'majority' ? b[1] - a[1] : a[1] - b[1]) || a[0].localeCompare(b[0]),
            );
            s.clip = totals[0][0];
            s.open = false;
            state(room);
          }
          if (m.type === 'new-round') {
            s.round++;
            s.votes = {};
            s.open = true;
            s.clip = 'intro';
            state(room);
          }
        }
      }
      if (room.ex === 7) {
        const s = room.state;
        if (m.type === 'cell') {
          const row = Number(m.row),
            col = Number(m.col);
          if (
            !Number.isInteger(row) ||
            !Number.isInteger(col) ||
            row < 0 ||
            row >= 4 ||
            col < 0 ||
            col >= 8
          )
            return;
          s.grid[row][col] = !s.grid[row][col];
          state(room);
        }
        if (client.id === room.host) {
          if (m.type === 'transport') {
            s.playing = !!m.playing;
            s.start = Date.now() + 1200;
            state(room);
          }
          if (m.type === 'tempo') {
            s.bpm = clamp(m.value, 60, 180);
            if (s.playing) s.start = Date.now() + 1200;
            state(room);
          }
          if (m.type === 'clear-grid') {
            s.grid = initial(7).grid;
            state(room);
          }
        }
      }
    });
    ws.on('close', () => {
      if (!room || !client) return;
      room.clients.delete(client.id);
      room.last = Date.now();
      for (const c of room.clients.values()) if (c.allow === client.id) c.allow = '';
      if (room.ex === 6 && room.state.open) delete room.state.votes[client.id];
      if (room.host === client.id) room.host = room.clients.keys().next().value || '';
      presence(room);
      if (room.ex === 6) state(room);
    });
    ws.on('error', () => {});
  });
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
    for (const [key, r] of rooms)
      if (!r.clients.size && Date.now() - r.last > 3600000) rooms.delete(key);
  }, 30000);
  timer.unref();
  wss.on('close', () => clearInterval(timer));
  return rooms;
}
