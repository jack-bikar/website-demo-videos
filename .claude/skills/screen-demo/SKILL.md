---
name: screen-demo
description: Record an automated, polished screen-demo video of a website. Use when the user says "Record a demo of [URL] showing: [actions]" or otherwise asks to produce a screen recording / product demo video of a web app. Drives a Steel Dev cloud browser, captures the footage, trims dead air, adds smooth camera zooms, and renders a final MP4 with Remotion.
---

# Screen Demo Pipeline

Produce a clean, fast-paced product demo video from a URL and a plain-English list of actions.
The pipeline runs in six stages. Each stage writes a real file on disk so stages are independently
re-runnable and debuggable.

## When to use

Trigger this skill whenever the user asks for a recorded demo of a website, for example:

> **Record a demo of https://app.example.com showing: user signs up, creates a new workspace, adds a task and marks it complete**

The general shape is: **Record a demo of `[URL]` showing: `[comma-separated actions]`**.

If the user gives only a URL with no actions, ask them for the ordered list of things the demo should show.

## Invocation format

```
Record a demo of <URL> showing: <action 1>, <action 2>, <action 3>, ...
```

Example:

```
Record a demo of https://linear.app showing: open the inbox, create a new issue titled "Fix login bug", assign it to me, mark it done
```

## Secrets

`STEEL_API_KEY` is read from the environment (loaded from `.env.local`, falling back to `.env`) by
`scripts/record.js`. **Never** hardcode it, print it, or write it into any committed file. The Steel
SDK (`new Steel()`) reads `process.env.STEEL_API_KEY` automatically.

---

## The six stages

### Stage 1 — Browse plan

Convert the user's plain-English actions into an ordered, structured plan and write
`scripts/browse-plan.json`. **This one file is the entire configuration** — recording mode, caption
track, playback speed, and steps all live here and drive both the recording and the final video.
(The only thing outside it is the `STEEL_API_KEY` secret in `.env.local`.) Schema:

```jsonc
{
  "url": "https://app.example.com",          // first page to open
  "viewport": { "width": 1280, "height": 800 },
  "recording": {                             // how to drive the browser (env vars override these)
    "mode": "cloud",                         // "cloud" (Steel) | "local" (launch Chrome) | "connect" (attach)
    "connectUrl": "http://127.0.0.1:9222",   // connect mode: the debug-port Chrome to attach to
    "headful": false,                        // local mode: show the window
    "userDataDir": null,                     // local mode: reuse a Chrome profile (start logged in)
    "chromePath": null                       // local mode: explicit Chrome/Chromium path
  },
  "meta": {                                  // drives the caption track + speed (Stage 5)
    "title": "Project Selector",             // intro title card (omit meta.title to skip it)
    "subtitle": "Share work with a single code",
    "outro": { "title": "Try it free", "subtitle": "app.example.com" }, // outro CTA card
    "playbackSpeed": 4,                      // global speed-up default (per-step `speed` overrides)
    "captions": true,                        // set false to disable all on-screen text
    "zoom": true                             // set false for a steady shot (no per-action zoom in/out)
  },
  "steps": [
    {
      "type": "navigate",                      // navigate | click | type | scroll | wait | capture
      "target": "https://app.example.com/signup", // URL (navigate) or CSS/text selector (others)
      "text": null,                            // text to type (type steps); supports {{var}} templating
      "deltaY": null,                          // scroll amount in px (scroll steps only)
      "ms": null,                              // wait duration (wait steps only)
      "speed": null,                           // optional per-section playback speed (e.g. 2 for form-fills)
      "as": null,                              // capture steps only: variable name to store the value under
      "caption": "Land on signup",             // optional authored lower-third subtitle for this step
      "why": "Viewers see where the flow starts" // one-line debug/narrative note (caption falls back to this)
    }
  ]
}
```

Rules for building the plan:
- The **first** step is almost always a `navigate` to the URL the user gave.
- **Selectors:** prefer stable hooks — `[data-tour="…"]` and `[data-testid="…"]` survive copy and
  layout changes far better than nth-child/text. Fall back to other CSS, or a Puppeteer text selector
  like `::-p-text(Sign up)` / `text/Sign up` when no stable hook exists. One selector per interaction.
  (`record.js` already retries `waitForSelector` a few times before failing, so a brief re-render won't
  break a step.)
- Add a short `wait` after navigations or actions that trigger async UI (e.g. `{ "type": "wait", "ms": 1200 }`),
  so the recording captures the result, not a spinner.
- **`capture` + `{{var}}` templating** lets a value generated at runtime flow into a later step. Use a
  `capture` step to read on-screen text into a named variable, then reference it with `{{name}}` in a
  later step's `text` or `target`. This is what makes a teacher→student story possible — the teacher
  generates an access code, and the student types that exact code:
  ```jsonc
  { "type": "capture", "target": "[data-testid=\"access-code\"]", "as": "accessCode", "caption": "Code created" },
  { "type": "type",    "target": "[data-testid=\"join-code-input\"]", "text": "{{accessCode}}" }
  ```
- **`caption`** is the authored, on-screen scene description (the subtitle viewers read). **`why`** is the
  debug note. Every step needs a `why`; add a `caption` whenever you want tighter narration than the `why`.
  Captions fall back to `why` when omitted, so a plain plan still gets a sensible subtitle track.
- The committed `scripts/browse-plan.json` is a working starter template; `README.md` documents every
  field and includes the full authed teacher→student (capture + templating) example.

### Stage 2 — Record

Run:

```bash
npm run record
```

**Recording modes** — set `recording.mode` in `browse-plan.json` (env vars override for one-offs):

| `recording.mode` | When to use | Env override |
| --- | --- | --- |
| `"cloud"` (default) | Public URLs reachable from a cloud browser. Needs `STEEL_API_KEY`. | — |
| `"local"` | localhost / dev servers. Launches a fresh Chrome. | `DEMO_LOCAL=1` (or `npm run record:local`) |
| `"connect"` | **Authed apps (Clerk/OAuth).** Attaches to an already-running, already-logged-in Chrome. | `DEMO_CONNECT_URL=…` (or `npm run record:connect`) |

For **connect mode**, start Chrome with a debug port and log in first, then run the recorder. Set
`recording.mode: "connect"` (and `recording.connectUrl`) in the plan, or use the env override:

```bash
# Start a debuggable Chrome (dedicated profile dir), log into the app in it, then:
DEMO_CONNECT_URL=http://127.0.0.1:9222 npm run record   # or just: npm run record:connect
```

`record.js` connects to that browser (it does **not** close it on teardown) and reuses its session, so
Clerk/OAuth-gated pages record logged in. All connections use a 180s CDP `protocolTimeout` so a busy SPA
doesn't trip `Runtime.callFunctionOn timed out`.

`scripts/record.js` will:
1. Load `STEEL_API_KEY` and start a Steel cloud browser session (`client.sessions.create`) — or, in
   connect/local mode, attach to / launch the browser described above.
2. Connect to the session's CDP endpoint with `puppeteer-core` (`puppeteer.connect`).
3. Start a CDP screencast (`Page.startScreencast`) — this is how we get real video frames, because
   Steel's native recording is RRWeb events, not an MP4.
4. Execute every step in `browse-plan.json` with randomized 300–800 ms human-like pauses, typing
   character-by-character.
5. After each step, push a moment `{ time, action, type, x, y, speed? }` where `time` is ms from the
   start of the screencast, `x`/`y` are the element's center (when a coordinate exists), `action` is the
   step's `caption` (falling back to `why`), and `speed` is the optional per-step override. `capture`
   steps additionally read the target's text into a named variable for `{{var}}` substitution.
6. On finish: stop the screencast, encode the frames to `recordings/raw.mp4` with ffmpeg (preserving
   real-time pacing), copy it to `public/raw.mp4` for Remotion, release the Steel session, and write
   `scripts/moments.json`. (The caption track + playback speed aren't re-written here — the composition
   reads them straight from `browse-plan.json`'s `meta`.)

If a selector fails, the script screenshots to `recordings/error-<n>.png`, logs it, and continues.

### Stage 3 — Trim dead time

```bash
npm run trim
```

`scripts/trim.js` reads `scripts/moments.json` and writes `scripts/clips.json` using **exactly** these rules:
- each clip starts **500 ms before** its action timestamp,
- each clip ends **1000 ms after** its action timestamp,
- merge any two adjacent clips **less than 2000 ms apart**,
- where the gap between actions **exceeds 3000 ms**, do **not** bridge it — keep them separate (cuts dead air),
- output an array of `{ start, end, action, type }` (plus `speed` when a step set one), all times in ms
  relative to video start.

### Stage 4 — Camera keyframes

```bash
npm run keyframes
```

`scripts/keyframes.js` reads `clips.json` + `moments.json` and writes `scripts/keyframes.json`. For each
action it emits a zoom-in keyframe (scale **1.3**, centered on the action point if coordinates exist,
otherwise screen center) ~**300 ms before** the action, and a zoom-out keyframe (scale **1.0**) ~**600 ms after**.

### Stage 5 — Build composition

`remotion/DemoVideo.tsx` consumes `clips.json`, `keyframes.json`, and `browse-plan.json`'s `meta`. It
renders at 60fps, animates zoom with `spring()`/`interpolate()`, draws a dark navy→indigo gradient
background, and centers the footage in a rounded, soft-shadowed browser frame.

Driven by the plan's `meta`:
- **Playback speed** defaults to **4×** but is configurable globally (`meta.playbackSpeed`) and per clip
  (a step's `speed`) — e.g. slow form-fills to 2× while clicks stay fast.
- **Camera zoom** is on by default; set `meta.zoom: false` for a steady, un-zoomed shot (Stage 4 then
  emits no keyframes). Omitting `meta.title`/`meta.intro` skips the intro card so the video opens on the site.
- **Caption track:** an intro title card (`meta.title`/`subtitle`), per-clip lower-third subtitles (each
  clip's authored `caption`/`action`), and an outro CTA card (`meta.outro`). Set `meta.captions: false`
  to turn all of it off. With no `meta`, it behaves as before: no cards, and lower-thirds simply show each
  step's `why`.

`Root.tsx` sizes the composition from `totalDurationInFrames(clips)` (intro + sped-up clips + outro), so
duration tracks the config automatically. Only hand-edit `DemoVideo.tsx` for visual changes beyond what
`meta` controls.

### Stage 6 — Render

```bash
npm run render
```

Renders the `DemoVideo` composition to `output/demo.mp4`. Report the **output path** and the **duration**
(durationInFrames ÷ 60 = seconds) back to the user.

### One-shot

`npm run demo` chains record → trim → keyframes → render. Use it once `browse-plan.json` exists and looks right.

---

## Troubleshooting

**Recording is empty / `raw.mp4` is tiny or 0 bytes.**
- The page likely never rendered. Check `recordings/error-*.png`. Add an early `wait` step after the first
  `navigate`. Confirm the URL is reachable from a cloud browser (not a localhost-only app).
- Confirm `STEEL_API_KEY` is set: `node -e "require('dotenv').config({path:'.env.local'}); console.log(!!process.env.STEEL_API_KEY)"`.

**The app shows a login screen instead of the authed UI.**
- Don't try to script the login (Clerk/OAuth flows are brittle and may need a real human/2FA). Use **connect
  mode**: start Chrome with `--remote-debugging-port=9222` and a dedicated profile, log into the app by hand,
  then run `DEMO_CONNECT_URL=http://127.0.0.1:9222 npm run record`. The recorder reuses that logged-in session.

**`Runtime.callFunctionOn timed out` during recording.**
- A heavy SPA can exceed the default CDP timeout. `record.js` already raises `protocolTimeout` to 180s for
  every connection; if you still hit it, add a `wait` step so the page settles before the next interaction.

**A `{{var}}` shows up literally in the video.**
- The referenced variable was never captured — check that an earlier `capture` step ran (it logs `⧉ captured
  …`) and that its `as` name matches the `{{name}}` exactly. A failed capture step leaves the placeholder intact
  so the problem is visible rather than silently blank.

**A selector isn't found.**
- `record.js` retries `waitForSelector` a few times, then logs the failing step, screenshots it, and continues,
  so the rest of the demo still records. Open the screenshot, prefer a stable `[data-tour]`/`[data-testid]` hook
  (or a Puppeteer text selector `::-p-text(Label)`), update the step in `browse-plan.json`, and re-run.

**Render fails.**
- "Cannot find module clips.json / keyframes.json": run `npm run trim` and `npm run keyframes` first
  (or `npm run demo`). Placeholder files ship with the repo so the studio still opens.
- "OffthreadVideo could not load source": ensure `public/raw.mp4` exists — it's produced by `npm run record`.
- ffmpeg errors during render: confirm `ffmpeg` is on PATH (`which ffmpeg`). Remotion needs it for encoding.

**Want to preview before rendering.**
- `npx remotion studio remotion/index.ts` opens the interactive Remotion studio.
- `npm run studio` opens the web studio (project-based: record takes, edit cuts, render and download from the browser at http://localhost:4600).
