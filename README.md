# website-demo-videos

Turn a URL and a list of actions into a **polished product-demo MP4** — automatically. A browser is
driven through your steps, the footage is trimmed of dead air, smooth camera zooms are added, captions
and intro/outro cards are overlaid, and the whole thing is rendered with [Remotion](https://remotion.dev).

You configure **one file** — [`scripts/browse-plan.json`](scripts/browse-plan.json) — and run one command.

```
browse-plan.json ──▶ record ──▶ smooth ──▶ trim ──▶ keyframes ──▶ render ──▶ output/demo.mp4
   (you edit)        capture    60fps      cut       zoom          captions
                     footage    source     dead air  keyframes     + encode
```

---

## Requirements

- **Node.js** 18+
- **ffmpeg** on your `PATH` (`which ffmpeg`) — used to encode frames and the final video
- For **cloud** recording only: a [Steel](https://steel.dev) API key

```bash
npm install
```

If you'll record public URLs in the cloud, put your key in `.env.local` (never commit it):

```bash
echo "STEEL_API_KEY=sk-..." > .env.local
```

> `.env.local` is the **only** thing configured outside `browse-plan.json`, because it's a secret.

---

## Quick start

1. **Edit [`scripts/browse-plan.json`](scripts/browse-plan.json)** — set the `url`, pick a `recording.mode`,
   write your `steps`, and (optionally) a `meta` title/outro. See [Configuration](#configuration-one-file).
2. **Run the pipeline:**

   ```bash
   npm run demo
   ```

   This chains `record → trim → keyframes → render` and writes **`output/demo.mp4`**.

To preview interactively before rendering: `npm run studio`.

---

## Configuration (one file)

Everything lives in `scripts/browse-plan.json`. Here is every field:

```jsonc
{
  "url": "http://localhost:8731",            // first page to open
  "viewport": { "width": 1280, "height": 800 },

  "recording": {                             // how to drive the browser
    "mode": "local",                         // "cloud" | "local" | "connect"  (see Recording modes)
    "connectUrl": "http://127.0.0.1:9222",   // connect mode: the debug-port Chrome to attach to
    "headful": false,                        // local mode: show the window instead of headless
    "userDataDir": null,                     // local mode: reuse a Chrome profile dir (start logged in)
    "chromePath": null,                      // local mode: explicit Chrome/Chromium executable path
    "screencastQuality": 92                  // capture JPEG quality, higher reduces scroll shimmer
  },

  "meta": {                                  // the on-screen polish (all optional)
    "title": "Acme Demo",                    // intro title card  (omit to skip the intro)
    "subtitle": "From email to welcome in two clicks",
    "outro": { "title": "Try it yourself", "subtitle": "localhost:8731" }, // outro CTA card (omit to skip)
    "playbackSpeed": 4,                      // global footage speed-up (per-step `speed` overrides it)
    "captions": true,                        // false = no cards and no lower-third subtitles
    "zoom": true,                            // false = steady shot, no per-action zoom in/out
    "renderQuality": "draft"                 // "draft" | "standard" | "final" — final render encode quality
  },

  "steps": [
    {
      "type": "navigate",                    // navigate | click | type | scroll | wait | capture
      "target": "http://localhost:8731",     // a URL (navigate) or a selector (click/type/capture)
      "text": null,                          // text to type (type steps); supports {{var}} templating
      "deltaY": null,                        // scroll distance in px (scroll steps)
      "ms": null,                            // wait duration in ms (wait steps)
      "speed": null,                         // optional per-step playback speed (e.g. 2 for form-fills)
      "as": null,                            // capture steps: variable name to store the read value
      "caption": "Open the app",             // the subtitle shown on screen for this step (optional)
      "why": "Land on the home screen"       // a debug/narrative note; caption falls back to this
    }
  ]
}
```

### Step types

| `type` | Does | Key fields |
| --- | --- | --- |
| `navigate` | Go to a URL | `target` (URL) |
| `click` | Click an element | `target` (selector) |
| `type` | Click then type text, char-by-char | `target` (selector), `text` |
| `scroll` | Smooth-scroll the page | `deltaY` (px) |
| `wait` | Pause (let async UI settle) | `ms` |
| `capture` | Read an element's on-screen text into a variable | `target` (selector), `as` (name) |

**Selector tips:** prefer stable hooks — `[data-tour="…"]` / `[data-testid="…"]` survive copy and layout
changes far better than nth-child or text matching. You can also use Puppeteer text selectors like
`::-p-text(Sign up)`. The recorder retries `waitForSelector` a few times, so a brief re-render won't break a
step; if one still fails it screenshots `recordings/error-<n>.png`, logs it, and continues.

### `caption` vs `why`

- **`caption`** is the authored scene description viewers read as a lower-third subtitle.
- **`why`** is a one-line debug/narrative note. If a step has no `caption`, its `why` is used as the subtitle.

So a plain plan still gets sensible subtitles, and you tighten the narration by adding `caption`s.

### Speed control

`meta.playbackSpeed` sets the global speed-up (default **4×**). Any step can override it with `speed` — e.g.
slow a form-fill to `2` so the typing is readable while clicks stay snappy.

### Captures & templating (`{{var}}`)

A `capture` step reads on-screen text into a named variable; a later step references it with `{{name}}` in
its `text` or `target`. This carries a runtime-generated value forward — e.g. a teacher generates an access
code and a student types **that exact code**:

```jsonc
{ "type": "capture", "target": "[data-testid=\"access-code\"]", "as": "accessCode", "caption": "Code created" },
{ "type": "type",    "target": "[data-testid=\"join-code-input\"]", "text": "{{accessCode}}", "caption": "Student types the code" }
```

An unknown `{{name}}` is left literal in the output (so a typo is visible, not silently blank).

---

## Recording modes

Set `recording.mode` in the plan. Environment variables override it for one-off runs.

| Mode | When to use | Command / override |
| --- | --- | --- |
| `cloud` *(default)* | Public URLs reachable from a cloud browser. Needs `STEEL_API_KEY`. | `npm run record` |
| `local` | localhost / dev servers. Launches a fresh local Chrome. | `npm run record:local` (`DEMO_LOCAL=1`) |
| `connect` | **Authenticated apps (Clerk/OAuth).** Attaches to a Chrome you're already logged into. | `npm run record:connect` (`DEMO_CONNECT_URL=…`) |

### Recording an authenticated app (connect mode)

Scripting a Clerk/OAuth login is brittle (and may need 2FA). Instead, log in by hand once and let the
recorder reuse that live session:

1. Start Chrome with a remote-debugging port and a dedicated profile:

   ```bash
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
     --remote-debugging-port=9222 \
     --user-data-dir="$HOME/.demo-chrome"
   ```

2. In that window, **log into your app**.
3. Set `"recording": { "mode": "connect", "connectUrl": "http://127.0.0.1:9222" }` in the plan (or just run
   `npm run record:connect`), then run the pipeline.

The recorder attaches to that browser and **does not close it** on teardown, so your session stays intact.
All connections use a 180s CDP timeout, so a busy SPA won't trip `Runtime.callFunctionOn timed out`.

---

## Commands

| Command | What it does |
| --- | --- |
| `npm run demo` | Full pipeline: record → smooth → trim → keyframes → render → `output/demo.mp4` |
| `npm run demo:local` | Same, forcing local-browser recording |
| `npm run record` | Record footage → `recordings/raw.mp4`, `public/raw.mp4`, `scripts/moments.json` |
| `npm run record:local` | Record by launching a local Chrome |
| `npm run record:connect` | Record by attaching to a debug-port Chrome (`DEMO_CONNECT_URL`, default `:9222`) |
| `npm run smooth` | Motion-interpolate the raw capture to 60fps → `public/raw.mp4` |
| `npm run trim` | Cut dead air → `scripts/clips.json` |
| `npm run keyframes` | Generate camera zooms → `scripts/keyframes.json` |
| `npm run render` | Render the composition → `output/demo.mp4` |
| `npm run preview` | Open the interactive preview/editor (cut, retime, set render quality) |
| `npm run studio` | Open the Remotion studio to preview |

Each stage writes a real file, so stages are independently re-runnable and debuggable. After tweaking the
plan's `meta` (captions/speed), you only need to re-run `npm run render`.

### Preview tool (`npm run preview`)

The preview tool is a browser editor for the recorded footage — cut dead air, retime sections, and pick the
render quality before rendering:

- **Render quality** — pick **Draft** (fast `veryfast`/CRF 26 encode, good for testing), **Standard**, or
  **Final** (`slow`/CRF 16, best quality) before rendering. The choice is saved to `meta.renderQuality`, so
  `npm run render` honors it too. Override per-run with `DEMO_RENDER_QUALITY=final npm run render`; explicit
  `DEMO_RENDER_CRF` / `DEMO_RENDER_PRESET` still take precedence.

For scroll-heavy demos, `npm run smooth` is the important quality stage: CDP screencasts often capture at
roughly 15-25fps, so the smoother writes an interpolated 60fps copy to `public/raw.mp4` while leaving
`recordings/raw.mp4` untouched. The default `blend` mode is fast enough for normal iteration. Use
`DEMO_SMOOTH_MODE=mci npm run smooth` for the cleanest motion-compensated final pass when you can wait, or
`DEMO_SMOOTH_MODE=fps npm run smooth` for a plain constant-FPS conversion with no interpolation.

---

## How it works

1. **Record** ([`scripts/record.js`](scripts/record.js)) drives the browser through your steps with
   human-like pacing and captures real video frames over the Chrome DevTools Protocol screencast, encoding
   them to `recordings/raw.mp4` with ffmpeg (real-time paced). It records a `moment` per step with its
   timestamp, click coordinates, caption, and optional speed.
2. **Smooth** ([`scripts/smooth.js`](scripts/smooth.js)) turns the low-frame-rate CDP capture into the
   60fps source Remotion reads from `public/raw.mp4`.
3. **Trim** ([`scripts/trim.js`](scripts/trim.js)) turns moments into clips, padding each action and cutting
   the dead air between far-apart actions.
4. **Keyframes** ([`scripts/keyframes.js`](scripts/keyframes.js)) emits a zoom-in/zoom-out pair per action so
   the camera eases toward each click.
5. **Render** ([`remotion/DemoVideo.tsx`](remotion/DemoVideo.tsx)) composites it all: the footage in a
   rounded browser frame on a gradient background, animated zooms, lower-third captions, and the intro/outro
   cards — reading the caption track and speed straight from `browse-plan.json`'s `meta`.

### Files

| Path | Role |
| --- | --- |
| `scripts/browse-plan.json` | **The single config file you edit** (committed) |
| `.env.local` | `STEEL_API_KEY` secret (cloud mode only; git-ignored) |
| `scripts/moments.json`, `clips.json`, `keyframes.json` | Generated pipeline artifacts |
| `recordings/raw.mp4`, `public/raw.mp4` | Original capture and smoothed Remotion source |
| `output/demo.mp4` | Final video |

---

## Troubleshooting

**Recording is empty / `raw.mp4` is tiny.** The page likely never rendered — check `recordings/error-*.png`,
add an early `wait` step after the first `navigate`, and confirm the URL is reachable from the chosen mode
(a cloud browser can't reach `localhost`).

**Shows a login screen instead of the app.** Use **connect mode** (see above) — don't try to script the
login.

**`Runtime.callFunctionOn timed out`.** A heavy SPA exceeded the CDP timeout; it's already raised to 180s, so
add a `wait` step to let the page settle.

**A `{{var}}` appears literally in the video.** The variable was never captured — confirm an earlier
`capture` step ran (it logs `⧉ captured …`) and that its `as` matches the `{{name}}` exactly.

**A selector isn't found.** The recorder retries, then logs/screenshots and continues. Open the screenshot,
switch to a stable `[data-tour]`/`[data-testid]` hook, and re-run.

**Render: "Cannot find module clips.json / keyframes.json".** Run `npm run trim` and `npm run keyframes`
first (or `npm run demo`).

**Render: "OffthreadVideo could not load source".** Ensure `public/raw.mp4` exists — it's produced by
`npm run record`.
