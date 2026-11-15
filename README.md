# yt-remote

Control YouTube on your laptop from your phone while you're in bed: play/pause, volume, seek, next/previous,
search, "Up next", and a sleep timer that can fade out the volume, then turn the screen off or put the PC to sleep.

```
phone browser  ──Wi-Fi──>  server (Node, on laptop)  ──localhost──>  Chrome extension  ──>  YouTube tab
```

| Folder       | What it is |
|--------------|------------|
| `server/`    | Serves the phone page, relays commands, runs the sleep timer and Windows actions |
| `extension/` | Chrome extension that drives the YouTube tab through YouTube's own player API |
| `remote/`    | The phone remote (a single HTML page you can add to your home screen) |

## Setup (one time)

1. **Start the server:** double-click `start.cmd`, or run:
   ```bash
   cd server && npm install && npm start
   ```
   The first time, **Windows Firewall** asks about Node.js. Allow it on **Private networks**, otherwise your
   phone can't reach the laptop.
2. **Load the extension in Chrome** (Edge, Brave and Opera / Opera GX work the same way):
   - Open `chrome://extensions` (in Opera: `opera://extensions`) and turn on **Developer mode**.
   - Opera GX: if you use **GX Control** RAM/CPU limiters or tab snoozing, they can freeze the YouTube tab.
     Leave them off, or exclude YouTube.
   - Click **Load unpacked** and pick the `yt-remote/extension` folder.
   - The extension icon shows an `off` badge while the server isn't running. The badge disappears once it connects.
3. **Pair your phone:** make sure the phone is on the same Wi-Fi, then scan the QR code shown in the server window
   (or type the URL). The PIN is in the link, so you only do this once.
4. **Optional: add the page to your home screen** so it opens like an app.
   On Android Chrome, use ⋮ → *Add to Home screen*. On iPhone Safari, use Share → *Add to Home Screen*.

## Every night

Open a YouTube video on the laptop, get in bed, and open the remote on your phone.

## Auto-start with Windows (optional)

Press `Win + R`, type `shell:startup`, and put a shortcut to `start-hidden.vbs` in that folder.
The server will then run in the background at every login, with no window.

## Sleep timer

- Presets from 15 min to 2 h, or **End of video** (stops before autoplay starts the next one).
- **Afterwards:** *Just pause*, *+ Screen off* (turns off the monitor, while the laptop and audio stay on),
  or *+ Sleep PC*.
- **Fade:** lowers the volume gradually over the last minute, then puts it back after pausing,
  so it isn't silent tomorrow.
- **+15 min** extends a running timer.

## Notes / troubleshooting

- **Phone says "laptop not connected":** Chrome isn't open, the extension is disabled, or the server was restarted
  and the extension hasn't reconnected yet (it retries every few seconds).
- **Phone can't open the page:** check the firewall prompt from step 1, and that both devices are on the same
  network. Some guest or "AP isolation" Wi-Fi networks block device-to-device traffic.
- **New PIN:** delete `server/config.json` and restart the server.
- **Sleep PC hibernates instead of sleeping:** this happens on machines where hibernation replaces sleep. Run
  `powercfg /h off` in an admin terminal if you want plain sleep.
- **Volume:** the slider controls YouTube's own volume, which is capped by the Windows volume. Leave Windows
  volume at a sensible level.
- **Search and Up next** read YouTube's public pages (no API key). If YouTube changes its page format, these may
  break, but the playback controls keep working.
- The port is `8787`. If you change it (`PORT=xxxx`), also change `SERVER_URL` in `extension/background.js`.
