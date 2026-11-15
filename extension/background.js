// YT Remote extension: connects to the local yt-remote server and drives the YouTube tab.
const SERVER_URL = 'ws://127.0.0.1:8787/ext';

let ws = null;
let watching = false;      // server wants live status updates
let statusLoop = null;
let reconnectTimer = null;
let lastTabId = null;

// ---------- connection ----------
function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  try {
    ws = new WebSocket(SERVER_URL);
  } catch {
    return scheduleReconnect();
  }
  ws.onopen = () => setBadge(true);
  ws.onmessage = (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    handle(msg).catch((err) => console.warn('[yt-remote]', err));
  };
  ws.onclose = () => {
    ws = null;
    setBadge(false);
    setWatching(false);
    scheduleReconnect();
  };
  ws.onerror = () => { /* onclose follows */ };
}
function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 3000);
}
function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function setBadge(on) {
  chrome.action.setBadgeText({ text: on ? '' : 'off' });
  chrome.action.setBadgeBackgroundColor({ color: '#666' });
}

// Keep the service worker alive: WebSocket traffic every <30s keeps it running (Chrome 116+),
// and the alarm revives it and reconnects if Chrome stopped it anyway.
setInterval(() => send({ type: 'ping' }), 20_000);
chrome.alarms.create('yt-remote-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();

// ---------- popup ----------
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.q === 'state') {
    reply({ connected: !!(ws && ws.readyState === WebSocket.OPEN), server: SERVER_URL });
  }
});

// ---------- finding the YouTube tab ----------
async function findTab() {
  const tabs = await chrome.tabs.query({ url: '*://www.youtube.com/*' });
  if (!tabs.length) return null;
  const score = (t) =>
    (t.audible ? 8 : 0) + (/\/watch/.test(t.url || '') ? 4 : 0) + (t.id === lastTabId ? 2 : 0) + (t.active ? 1 : 0);
  tabs.sort((a, b) => score(b) - score(a));
  lastTabId = tabs[0].id;
  return tabs[0];
}

async function runInTab(cmd, value) {
  const tab = await findTab();
  if (!tab) return { page: 'none' };
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: ytPlayer,
      args: [cmd, value ?? null],
    });
    return res ? res.result : null;
  } catch (e) {
    return { page: 'loading', error: String(e) };
  }
}

// ---------- messages from server ----------
async function handle(msg) {
  if (msg.type === 'watch') {
    setWatching(!!msg.on);
  } else if (msg.type === 'cmd') {
    const res = await runInTab(msg.cmd, msg.value);
    if (res && res.toast) send({ type: 'toast', text: res.toast });
    if (res && res.page === 'none') send({ type: 'toast', text: 'No YouTube tab open on the laptop' });
    setTimeout(pushStatus, 150);
  } else if (msg.type === 'load') {
    const url = `https://www.youtube.com/watch?v=${encodeURIComponent(msg.videoId)}`;
    const tab = await findTab();
    if (tab) await chrome.tabs.update(tab.id, { url });
    else lastTabId = (await chrome.tabs.create({ url })).id;
  }
}

function setWatching(on) {
  watching = on;
  clearTimeout(statusLoop);
  if (on) pushStatusLoop();
}
async function pushStatus() {
  const status = await runInTab('status');
  send({ type: 'status', status: status || { page: 'loading' } });
}
async function pushStatusLoop() {
  if (!watching) return;
  await pushStatus();
  if (watching) statusLoop = setTimeout(pushStatusLoop, 1000);
}

// ---------- runs INSIDE the YouTube page (main world) ----------
// Must be self-contained: Chrome serializes this function into the page.
function ytPlayer(cmd, value) {
  const p = document.getElementById('movie_player');
  const onWatch = location.pathname === '/watch';
  if (!p || typeof p.getPlayerState !== 'function' || !onWatch) {
    return cmd === 'status'
      ? { page: onWatch ? 'loading' : 'other' }
      : { toast: 'Open a video on the laptop first' };
  }
  const click = (sel) => {
    const el = document.querySelector(sel);
    if (el) el.click();
    return !!el;
  };
  const state = p.getPlayerState();

  switch (cmd) {
    case 'status': {
      const d = p.getVideoData() || {};
      const names = { '-1': 'unstarted', 0: 'ended', 1: 'playing', 2: 'paused', 3: 'buffering', 5: 'cued' };
      return {
        page: 'watch',
        videoId: d.video_id,
        title: d.title,
        channel: d.author,
        isLive: !!d.isLive,
        state: names[state] || 'unknown',
        ended: state === 0,
        currentTime: p.getCurrentTime(),
        duration: p.getDuration(),
        volume: p.getVolume(),
        muted: p.isMuted(),
        rate: p.getPlaybackRate(),
        ad: p.classList.contains('ad-showing'),
        captions: !!document.querySelector('.ytp-subtitles-button[aria-pressed="true"]'),
        theater: !!document.querySelector('ytd-watch-flexy[theater], .ytp-size-button[aria-label^="Default"]'),
      };
    }
    case 'toggle': state === 1 || state === 3 ? p.pauseVideo() : p.playVideo(); break;
    case 'play': p.playVideo(); break;
    case 'pause': p.pauseVideo(); break;
    case 'seekBy': p.seekTo(Math.max(0, p.getCurrentTime() + (value || 0)), true); break;
    case 'seekTo': p.seekTo(Math.max(0, value || 0), true); break;
    case 'setVolume': {
      const v = Math.round(Math.min(100, Math.max(0, value || 0)));
      if (v > 0 && p.isMuted()) p.unMute();
      p.setVolume(v);
      break;
    }
    case 'volumeBy': {
      const v = Math.round(Math.min(100, Math.max(0, p.getVolume() + (value || 0))));
      if (v > 0 && p.isMuted()) p.unMute();
      p.setVolume(v);
      break;
    }
    case 'mute': p.isMuted() ? p.unMute() : p.mute(); break;
    case 'next': p.nextVideo(); break;
    case 'prev': {
      const inPlaylist = typeof p.getPlaylist === 'function' && (p.getPlaylist() || []).length > 0;
      if (p.getCurrentTime() > 5) p.seekTo(0, true);
      else if (inPlaylist) p.previousVideo();
      else history.back();
      break;
    }
    case 'speed': if (value) p.setPlaybackRate(value); break;
    case 'captions':
      if (!click('.ytp-subtitles-button')) return { toast: 'No captions for this video' };
      break;
    case 'theater': click('.ytp-size-button'); break;
    case 'skipAd':
      if (!click('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern')) {
        return { toast: "Can't skip this ad yet" };
      }
      break;
  }
  return { ok: true };
}
