# yt-remote: ideas

Goal: control YouTube playing on the laptop (Windows) from the phone in bed.
Must-haves: play/pause, volume, seek, next/prev video, change video (search or paste link), sleep timer.

---

## Option 0: no code (try this first, 5 minutes)

YouTube's TV interface (`youtube.com/tv`) can pair with the YouTube phone app the way a smart TV does.
Desktop browsers get redirected away from it, so you need a "TV" user agent:

1. Install a user-agent switcher extension and set a smart-TV UA for `youtube.com/tv`.
2. Open `youtube.com/tv`, go to Settings, then "Link with TV code".
3. In the phone app, tap Cast, then "Link with TV code", and enter the code.

Pros: native YouTube remote with search and queue. Cons: hacky, can break at any time, no sleep timer,
and the TV UI looks different. It's worth trying because it may already cover 80% of what you need.

---

## Option A (recommended): Chrome extension + small local server + phone web page

```
 Phone browser (PWA)  <--WiFi/WebSocket-->  Local server (Node, on laptop)  <--WebSocket-->  Chrome extension
   big buttons UI                            serves the phone page,                          content script on
   search, timer                             relays commands, runs the                        youtube.com controls
                                             sleep timer, OS actions                          the <video> + player
```

- **Extension (content script):** controls the actual YouTube tab. It handles play/pause, volume
  (YouTube's own volume), seek ±10s, next/prev, speed, captions and fullscreen, and it loads a video by URL
  or search result. It also reports the title, thumbnail, position and duration back so the phone can show
  "now playing".
- **Server (Node, ~100 lines):** serves the remote page on `http://<laptop-ip>:8080` and relays messages
  over WebSockets. Because it runs on the laptop, it can also:
  - run the **sleep timer** (pause, fade out the volume, then optionally sleep the PC or turn off the monitor)
  - change the **Windows system volume**
  - start automatically with Windows
- **Phone page:** a mobile-first dark UI with large buttons, a now-playing card, a volume slider,
  a search box with results, and timer presets (15/30/45/60 min, "end of video"). You can add it to the
  home screen as a PWA so it feels like an app. It needs no app store and works on Android and iOS.
- **Pairing/security:** a short PIN or QR code shown on the laptop, so other people on the Wi-Fi can't control it.

Pros: full control, a real sleep timer that can sleep the PC, and works with your normal logged-in YouTube
(recommendations and history stay intact). Cons: two pieces to run (an extension and a server).

## Option B: server only, no extension

A Node or Python server that sends OS media keys (play/pause/next) and sets the system volume, controlled
from the same phone page.
Pros: simplest to build, and works with any media (Netflix, Spotify, etc.). Cons: no search, no
"now playing", no seeking, and media keys sometimes go to the wrong app.

## Option C: extension only + cloud relay

The extension talks to a free realtime backend (Firebase, Supabase, or similar), and the phone uses a hosted page.
Pros: nothing to run locally, and works off the home Wi-Fi. Cons: needs an account/backend, adds latency,
and can't sleep the PC.

## Option D: Tampermonkey userscript instead of extension

This is the same as A, but the YouTube-side code is a userscript. It's slightly easier to install, but less capable.

---

## Nice-to-haves (later)
- Sleep timer that fades the volume out gradually instead of cutting off
- "Stop after this video" mode
- Dim screen / monitor off when the timer ends
- Queue builder from search results
- Swipe gestures on the phone page (swipe for ±10s, two-finger for volume)
- Phone lock-screen controls via the Media Session API
- QR code on the laptop to open the remote instantly
