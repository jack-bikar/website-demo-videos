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
- **pnpm** 10+ — this is a pnpm monorepo (packages use the `workspace:*` protocol, so plain `npm install` won't resolve them)
- **ffmpeg** and **ffprobe** on your `PATH` (`which ffmpeg ffprobe`) — used to capture, smooth, and encode the video
- **Google Chrome / Chromium** installed for `local` recording; for `cloud` recording, a [Steel](https://steel.dev) API key

```bash
pnpm install
```

> The pipeline scripts (`record`, `smooth`, `trim`, `keyframes`, `render`, `demo`) run under either
> `npm run <script>` or `pnpm <script>` — only **installation** must use pnpm.

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
   npm run demo          # uses recording.mode from the plan (cloud needs STEEL_API_KEY)
   npm run demo:local    # force local-Chrome recording, ignore the plan's mode
   ```

   This chains `record → smooth → trim → keyframes → render` and writes **`output/demo.mp4`**.

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
    "screencastQuality": 82,                 // capture JPEG quality (1–100); higher reduces scroll shimmer
    "captureFps": 30                         // constant capture-cadence floor (see Smooth, continuous capture)
  },

  "meta": {                                  // the on-screen polish (all optional)
    "title": "Acme Demo",                    // intro title card  (omit to skip the intro)
    "subtitle": "From email to welcome in two clicks",
    "outro": { "title": "Try it yourself", "subtitle": "localhost:8731" }, // outro CTA card (omit to skip)
    "playbackSpeed": 4,                      // global footage speed-up (per-step `pace`/`speed` overrides it)
    "captions": true,                        // false = no cards and no lower-third subtitles
    "zoom": true,                            // false = steady shot, no per-action zoom in/out
    "smoothMode": "auto",                    // "auto" | "mci" | "blend" | "fps"; use "mci" for long scrolls
    "renderQuality": "draft"                 // "draft" | "standard" | "final" — final render encode quality
  },

  "steps": [
    {
      "type": "navigate",                    // navigate | click | type | scroll | focus | wait | capture
      "target": "http://localhost:8731",     // a URL (navigate) or a selector (click/type/capture)
      "text": null,                          // text to type (type steps); supports {{var}} templating
      "deltaY": null,                        // scroll distance in px (scroll steps)
      "ms": null,                            // wait duration in ms (wait steps)
      "pace": "normal",                      // "very-slow" | "slow" | "normal" | "quick"
      "smoothness": "continuous",            // scroll: denser waypoints + constant motion
      "speed": null,                         // numeric override; wins over `pace`
      "direction": "Slow, continuous homepage pass.",
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
| `scroll` | Smooth-scroll the page | `deltaY` (px), `ms`, `smoothness: "continuous"` |
| `focus` | Scroll a large element into frame and hold a framed shot | `target` (selector), `fitMs`, `ms` |
| `wait` | Pause (let async UI settle) — avoid for a continuous feel | `ms` |
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

`meta.playbackSpeed` sets the global speed-up (default **4×**). Use per-step `pace` for readable creative
direction: `very-slow`, `slow`, `normal`, or `quick`. A numeric `speed` still works and wins over `pace`.

For a homepage pass that feels gradual while the booking transition stays snappy, put `pace: "slow"` on the
homepage scroll, then `pace: "normal"` on the booking click/focus steps. Speed changes become clip
boundaries, so the slow homepage section does not bleed into the next scene.

**For a continuous, no-dead-air feel:** avoid static `wait` steps — keep something moving at all times. A
single slow `scroll` with `"smoothness": "continuous"` (e.g. the whole page over ~12s) starts motion from
the first frame and reads far better than a hold-then-scroll. The cursor keeps moving through `click`/`focus`
transitions, so the only place a still frame creeps in is a long `focus` dwell — keep its `ms` short.

For scroll-heavy videos, set `meta.smoothMode` to `"mci"`. It is slower to process but avoids the repeated
frame/ghosting artifacts that are most visible during long continuous scrolls.

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
| `npm run studio` | Open the interactive Next.js studio (preview, cut/retime, render quality) |
| `npm run studio:remotion` | Open the raw Remotion studio for composition debugging |

Each stage writes a real file, so stages are independently re-runnable and debuggable. After tweaking the
plan's `meta` (captions/speed), you only need to re-run `npm run render`.

### Smoothness: continuous capture + interpolation

A CDP screencast is event-driven — Chrome only emits a frame when it repaints and throttles to ~25fps, so
fast scrolls step and static holds stall. Two stages fix this:

1. **Capture** floors the frame rate at `recording.captureFps` (default **30**): whenever the screencast
   falls behind, the recorder force-captures a screenshot, so motion never drops below a steady cadence.
   Override per-run with `DEMO_CAPTURE_FPS=30 npm run record`. Pair it with `smoothness: "continuous"` on
   long `scroll` steps for a constant-velocity pass.
2. **Smooth** (`npm run smooth`) interpolates that capture up to a 60fps copy in `public/raw.mp4`, leaving
   `recordings/raw.mp4` untouched. Modes, set via `meta.smoothMode` or `DEMO_SMOOTH_MODE`:
   - `blend` — fast, fine for iteration, but **ghosts moving content** (double-images on scroll).
   - `mci` — motion-compensated; the clean, no-ghost pass. **Use this for the final** scroll-heavy render
     (slower — minutes for a ~30s clip).
   - `fps` — plain constant-FPS conversion, no interpolation.
   - `auto` — `mci` for short clips, `blend` for longer ones.

**Render quality** is set with `meta.renderQuality` (`draft` | `standard` | `final`) or per-run with
`DEMO_RENDER_QUALITY=final npm run render`; explicit `DEMO_RENDER_CRF` / `DEMO_RENDER_PRESET` win over both.

---

## How it works

1. **Record** ([`packages/capture`](packages/capture/src/recorder.ts)) drives the browser through your steps
   with human-like pacing and captures real video frames over the Chrome DevTools Protocol screencast (with
   the constant-cadence floor above), encoding them to `recordings/raw.mp4` with ffmpeg. It records a
   `moment` per step with its timestamp, click coordinates, caption, and optional speed.
2. **Smooth** ([`packages/render`](packages/render/src/smooth.ts)) interpolates the capture into the 60fps
   source Remotion reads from `public/raw.mp4`.
3. **Trim** ([`packages/timeline`](packages/timeline/src/trim.ts)) turns moments into clips, padding each
   action and cutting the dead air between far-apart actions.
4. **Keyframes** ([`packages/timeline`](packages/timeline/src/keyframes.ts)) emits a zoom-in/zoom-out pair
   per action so the camera eases toward each click.
5. **Render** ([`packages/compositions`](packages/compositions) + [`remotion/Root.tsx`](remotion/Root.tsx))
   composites it all: the footage in a rounded browser frame on a gradient background, animated zooms,
   lower-third captions, and the intro/outro cards — reading the caption track and speed straight from
   `browse-plan.json`'s `meta`.

The pipeline lives in the [`packages/`](packages/) monorepo (schema, timeline, capture, render,
compositions, engine); [`apps/studio`](apps/studio) is the Next.js studio. The root `npm run` scripts in the
table above are thin wrappers over `packages/cli`.

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
