// yt-remote server
// - Serves the phone remote page (../remote) on http://<laptop-ip>:8787
// - Relays commands phone <-> Chrome extension over WebSockets
// - Runs the sleep timer and Windows actions (monitor off / sleep)

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { WebSocketServer } = require('ws');
const qrcode = require('qrcode-terminal');

const PORT = Number(process.env.PORT) || 8787;
const CONFIG_PATH = path.join(__dirname, 'config.json');
const PUBLIC_DIR = path.join(__dirname, '..', 'remote');

// ---------- config / PIN ----------
function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* first run */ }
  if (!cfg.pin || !/^\d{6}$/.test(cfg.pin)) {
    cfg.pin = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  }
  return cfg;
}
const config = loadConfig();

function pinOk(pin) {
  const a = Buffer.from(String(pin || ''));
  const b = Buffer.from(config.pin);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Simple brute-force guard: 10 wrong PINs per IP -> locked for 5 minutes
const failures = new Map(); // ip -> { count, until }
function isLocked(ip) {
  const f = failures.get(ip);
  return f && f.until > Date.now();
}
function recordFailure(ip) {
  const f = failures.get(ip) || { count: 0, until: 0 };
  f.count += 1;
  if (f.count >= 10) { f.until = Date.now() + 5 * 60_000; f.count = 0; }
  failures.set(ip, f);
}

// ---------- static files ----------
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const entry = STATIC[url.pathname];
  if (!entry || req.method !== 'GET') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  fs.readFile(path.join(PUBLIC_DIR, entry[0]), (err, data) => {
    if (err) { res.writeHead(500); return res.end('Missing file'); }
    res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---------- WebSockets ----------
const wss = new WebSocketServer({ noServer: true });
let ext = null;              // the Chrome extension socket
const remotes = new Set();   // phone sockets
let lastStatus = null;       // latest player status from the extension

function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}
function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of remotes) if (ws.readyState === 1) ws.send(data);
}
function toast(ws, text) { send(ws, { type: 'toast', text }); }

function sendExt(msg, replyTo) {
  if (!ext || ext.readyState !== 1) {
    if (replyTo) toast(replyTo, 'Laptop not connected: is Chrome open with the extension?');
    return false;
  }
  ext.send(JSON.stringify(msg));
  return true;
}

// Ask the extension to stream status only when someone needs it
function updateWatch() {
  sendExt({ type: 'watch', on: remotes.size > 0 || !!timer });
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const ip = req.socket.remoteAddress;

  if (url.pathname === '/ext') {
    const origin = req.headers.origin || '';
    // Only the extension, only from this machine (web pages can't fake the Origin header)
    if (!isLoopback(ip) || !origin.startsWith('chrome-extension://')) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return socket.destroy();
    }
    return wss.handleUpgrade(req, socket, head, (ws) => onExt(ws));
  }

  if (url.pathname === '/remote') {
    return wss.handleUpgrade(req, socket, head, (ws) => {
      if (isLocked(ip)) {
        send(ws, { type: 'auth', ok: false, reason: 'Too many wrong PINs. Try again in a few minutes.' });
        return ws.close(4001);
      }
      if (!pinOk(url.searchParams.get('pin'))) {
        recordFailure(ip);
        send(ws, { type: 'auth', ok: false, reason: 'Wrong PIN' });
        return ws.close(4001);
      }
      failures.delete(ip);
      onRemote(ws);
    });
  }

  socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
  socket.destroy();
});

function onExt(ws) {
  if (ext && ext !== ws) ext.terminate();
  ext = ws;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  console.log('[ext] connected');
  broadcast({ type: 'ext', connected: true });
  updateWatch();

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'status') {
      lastStatus = msg.status;
      broadcast({ type: 'status', status: lastStatus });
      onStatusForTimer(lastStatus);
    } else if (msg.type === 'toast') {
      broadcast({ type: 'toast', text: String(msg.text).slice(0, 200) });
    }
  });
  ws.on('close', () => {
    if (ext !== ws) return;
    ext = null;
    lastStatus = null;
    console.log('[ext] disconnected');
    broadcast({ type: 'ext', connected: false });
  });
}

const ALLOWED_CMDS = new Set([
  'toggle', 'play', 'pause', 'seekBy', 'seekTo', 'setVolume', 'volumeBy', 'mute',
  'next', 'prev', 'speed', 'captions', 'theater', 'skipAd',
]);

function onRemote(ws) {
  remotes.add(ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  send(ws, { type: 'auth', ok: true });
  send(ws, { type: 'ext', connected: !!ext });
  if (lastStatus) send(ws, { type: 'status', status: lastStatus });
  send(ws, { type: 'timer', timer: timerPublic() });
  updateWatch();

  ws.on('message', async (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.type) {
      case 'cmd':
        if (ALLOWED_CMDS.has(msg.cmd)) {
          sendExt({ type: 'cmd', cmd: msg.cmd, value: typeof msg.value === 'number' ? msg.value : undefined }, ws);
        }
        break;
      case 'load':
        if (/^[\w-]{11}$/.test(msg.videoId || '')) sendExt({ type: 'load', videoId: msg.videoId }, ws);
        else toast(ws, 'Not a valid video');
        break;
      case 'search':
        try {
          const q = String(msg.q || '').trim().slice(0, 200);
          if (!q) break;
          const id = extractVideoId(q);
          if (id) { sendExt({ type: 'load', videoId: id }, ws); break; }
          send(ws, { type: 'results', kind: 'search', results: await ytSearch(q) });
        } catch (e) {
          console.error('[search]', e.message);
          toast(ws, 'Search failed');
        }
        break;
      case 'related':
        try {
          const vid = lastStatus && lastStatus.videoId;
          if (!vid) { toast(ws, 'Nothing playing'); break; }
          send(ws, { type: 'results', kind: 'related', results: await ytRelated(vid) });
        } catch (e) {
          console.error('[related]', e.message);
          toast(ws, 'Could not load Up next');
        }
        break;
      case 'timer':
        startTimer(msg, ws);
        break;
      case 'timerAdd':
        addToTimer(Number(msg.minutes) || 0, ws);
        break;
      case 'timerCancel':
        cancelTimer();
        break;
      case 'os':
        if (msg.action === 'monitor') monitorOff();
        else if (msg.action === 'sleep') { sendExt({ type: 'cmd', cmd: 'pause' }); setTimeout(sleepPC, 1500); }
        break;
    }
  });
  ws.on('close', () => { remotes.delete(ws); updateWatch(); });
}

// heartbeat: drop dead sockets (phone went to sleep etc.)
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

// ---------- sleep timer ----------
// timer = { mode: 'minutes'|'end', endsAt, action: 'pause'|'monitor'|'sleep', fade, videoId, handles }
let timer = null;
const FADE_MS = 60_000;

function timerPublic() {
  if (!timer) return null;
  return { mode: timer.mode, endsAt: timer.endsAt, action: timer.action, fade: timer.fade, fading: !!timer.fadeFrom };
}
function clearTimerHandles() {
  if (!timer) return;
  clearTimeout(timer.fireHandle);
  clearTimeout(timer.fadeHandle);
  clearInterval(timer.fadeInterval);
}
function cancelTimer() {
  if (!timer) return;
  clearTimerHandles();
  // put volume back if we were mid-fade
  if (timer.fadeFrom != null) sendExt({ type: 'cmd', cmd: 'setVolume', value: timer.fadeFrom });
  timer = null;
  broadcast({ type: 'timer', timer: null });
  updateWatch();
}

function startTimer(msg, ws) {
  const action = ['pause', 'monitor', 'sleep'].includes(msg.action) ? msg.action : 'pause';
  const fade = msg.fade !== false;
  if (timer) cancelTimer();

  if (msg.mode === 'end') {
    if (!lastStatus || !lastStatus.videoId || !lastStatus.duration) return toast(ws, 'Nothing playing');
    timer = { mode: 'end', action, fade: false, videoId: lastStatus.videoId, endsAt: estimateEnd(lastStatus) };
  } else {
    const minutes = Math.min(Math.max(Number(msg.minutes) || 0, 1), 600);
    timer = { mode: 'minutes', action, fade, endsAt: Date.now() + minutes * 60_000 };
    scheduleMinutesTimer();
  }
  broadcast({ type: 'timer', timer: timerPublic() });
  updateWatch();
}

function addToTimer(minutes, ws) {
  if (!timer) return toast(ws, 'No timer running');
  if (timer.mode === 'end') {
    // convert "end of video" into a fixed timer counting from the estimated end
    timer.mode = 'minutes';
    timer.fade = true;
  }
  clearTimerHandles();
  if (timer.fadeFrom != null) { sendExt({ type: 'cmd', cmd: 'setVolume', value: timer.fadeFrom }); timer.fadeFrom = null; }
  timer.endsAt = Math.max(timer.endsAt, Date.now()) + minutes * 60_000;
  scheduleMinutesTimer();
  broadcast({ type: 'timer', timer: timerPublic() });
}

function scheduleMinutesTimer() {
  const t = timer;
  const msLeft = t.endsAt - Date.now();
  t.fireHandle = setTimeout(() => fireTimer(), Math.max(msLeft, 0));
  if (t.fade) {
    t.fadeHandle = setTimeout(() => startFade(), Math.max(msLeft - FADE_MS, 0));
  }
}

function startFade() {
  if (!timer || !lastStatus || lastStatus.volume == null) return;
  const t = timer;
  t.fadeFrom = lastStatus.volume;
  const from = t.fadeFrom;
  const to = Math.min(from, Math.round(from * 0.15));
  broadcast({ type: 'timer', timer: timerPublic() });
  t.fadeInterval = setInterval(() => {
    if (timer !== t) return clearInterval(t.fadeInterval);
    const left = Math.max(t.endsAt - Date.now(), 0);
    const frac = Math.min(left / FADE_MS, 1); // 1 -> 0
    const vol = Math.round(to + (from - to) * frac);
    sendExt({ type: 'cmd', cmd: 'setVolume', value: vol });
  }, 2000);
}

function estimateEnd(s) {
  const rate = s.rate || 1;
  return Date.now() + Math.max(s.duration - s.currentTime, 0) / rate * 1000;
}

// "end of video" mode is driven by live status
function onStatusForTimer(s) {
  if (!timer || timer.mode !== 'end' || !s) return;
  if (s.videoId && s.videoId !== timer.videoId) return fireTimer(); // autoplay already moved on
  if (s.videoId === timer.videoId && s.duration) {
    if (s.ended || s.duration - s.currentTime < 1.2) return fireTimer();
    if (s.state === 'playing') {
      const est = estimateEnd(s);
      if (Math.abs(est - timer.endsAt) > 2000) {
        timer.endsAt = est;
        broadcast({ type: 'timer', timer: timerPublic() });
      }
    }
  }
}

function fireTimer() {
  if (!timer) return;
  const t = timer;
  clearTimerHandles();
  timer = null;
  console.log(`[timer] fired (${t.action})`);
  sendExt({ type: 'cmd', cmd: 'pause' });
  // restore the volume after pausing so tomorrow isn't silent
  if (t.fadeFrom != null) setTimeout(() => sendExt({ type: 'cmd', cmd: 'setVolume', value: t.fadeFrom }), 1500);
  broadcast({ type: 'timer', timer: null });
  broadcast({ type: 'toast', text: 'Sleep timer finished. Good night!' });
  updateWatch();
  if (t.action === 'monitor') setTimeout(monitorOff, 2500);
  if (t.action === 'sleep') setTimeout(sleepPC, 3000);
}

// ---------- Windows actions ----------
function runPowerShell(script) {
  if (process.platform !== 'win32') return console.log('[os] skipped (not Windows)');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true },
    (err) => { if (err) console.error('[os]', err.message); });
}
function monitorOff() {
  console.log('[os] monitor off');
  runPowerShell(`
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices;
public static class Mon { [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l); }'
[Mon]::PostMessage([IntPtr]0xFFFF, 0x0112, [IntPtr]0xF170, [IntPtr]2) | Out-Null`);
}
function sleepPC() {
  console.log('[os] sleep');
  runPowerShell(`
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::SetSuspendState([System.Windows.Forms.PowerState]::Suspend, $false, $false) | Out-Null`);
}

// ---------- YouTube search / related (no API key) ----------
const YT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cookie': 'SOCS=CAI; CONSENT=YES+1',
};

function extractVideoId(text) {
  const m = text.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}

async function fetchInitialData(url) {
  const res = await fetch(url, { headers: YT_HEADERS });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const html = await res.text();
  const m = html.match(/var ytInitialData\s*=\s*(\{.*?\});\s*<\/script>/s);
  if (!m) throw new Error('ytInitialData not found');
  return JSON.parse(m[1]);
}

function textOf(t) {
  if (!t) return '';
  if (typeof t === 'string') return t;
  if (t.simpleText) return t.simpleText;
  if (t.runs) return t.runs.map((r) => r.text).join('');
  if (t.content) return t.content;
  return '';
}

function collectVideos(data, limit) {
  const out = [];
  const seen = new Set();
  const add = (v) => {
    if (!v.videoId || seen.has(v.videoId) || out.length >= limit) return;
    seen.add(v.videoId);
    v.thumb = `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`;
    out.push(v);
  };
  (function walk(node) {
    if (!node || typeof node !== 'object' || out.length >= limit) return;
    if (Array.isArray(node)) { for (const n of node) walk(n); return; }
    const r = node.videoRenderer || node.compactVideoRenderer;
    if (r && r.videoId) {
      add({
        videoId: r.videoId,
        title: textOf(r.title),
        channel: textOf(r.ownerText || r.longBylineText || r.shortBylineText),
        length: textOf(r.lengthText) || 'LIVE',
        views: textOf(r.shortViewCountText || r.viewCountText),
      });
      return;
    }
    const l = node.lockupViewModel;
    if (l && l.contentId && (l.contentType || '').includes('VIDEO')) {
      const meta = l.metadata && l.metadata.lockupMetadataViewModel;
      const rows = meta?.metadata?.contentMetadataViewModel?.metadataRows || [];
      const parts = rows.flatMap((row) => (row.metadataParts || []).map((p) => textOf(p.text)));
      let length = '';
      (function findBadge(n) {
        if (!n || typeof n !== 'object' || length) return;
        if (n.thumbnailBadgeViewModel) { length = n.thumbnailBadgeViewModel.text || ''; return; }
        for (const k in n) findBadge(n[k]);
      })(l.contentImage);
      add({ videoId: l.contentId, title: textOf(meta?.title), channel: parts[0] || '', length, views: parts[1] || '' });
      return;
    }
    for (const k in node) walk(node[k]);
  })(data);
  return out;
}

async function ytSearch(q) {
  // sp=EgIQAQ%3D%3D -> filter: videos only
  const data = await fetchInitialData('https://www.youtube.com/results?sp=EgIQAQ%253D%253D&search_query=' + encodeURIComponent(q));
  return collectVideos(data.contents || data, 20);
}

async function ytRelated(videoId) {
  const data = await fetchInitialData('https://www.youtube.com/watch?v=' + videoId);
  const secondary = data?.contents?.twoColumnWatchNextResults?.secondaryResults || data;
  return collectVideos(secondary, 20).filter((v) => v.videoId !== videoId);
}

// ---------- start ----------
function lanAddresses() {
  const skip = /vethernet|virtualbox|vmware|wsl|hyper-v|docker|loopback|bluetooth/i;
  const list = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (skip.test(name)) continue;
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) list.push(a.address);
  }
  // prefer typical home-LAN ranges
  return list.sort((a, b) => (/^192\.168\./.test(b) - /^192\.168\./.test(a)));
}

server.listen(PORT, '0.0.0.0', () => {
  const ips = lanAddresses();
  const main = ips[0] || 'localhost';
  const url = `http://${main}:${PORT}/?pin=${config.pin}`;
  console.log('\n  yt-remote is running\n');
  console.log(`  Phone URL : ${url}`);
  for (const ip of ips.slice(1)) console.log(`  (or)      : http://${ip}:${PORT}/?pin=${config.pin}`);
  console.log(`  PIN       : ${config.pin}\n`);
  console.log('  Scan with your phone camera (same Wi-Fi):\n');
  qrcode.generate(url, { small: true });
});
