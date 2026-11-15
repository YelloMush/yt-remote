chrome.runtime.sendMessage({ q: 'state' }, (state) => {
  const dot = document.getElementById('dot');
  const label = document.getElementById('label');
  const hint = document.getElementById('hint');
  if (state && state.connected) {
    dot.className = 'dot on';
    label.textContent = 'Connected to server';
    hint.textContent = 'Open the remote on your phone using the URL or QR code printed by the server.';
  } else {
    dot.className = 'dot off';
    label.textContent = 'Server not running';
    hint.innerHTML = 'Start it with <code>npm start</code> in <code>yt-remote/server</code>. The extension reconnects automatically.';
  }
});
