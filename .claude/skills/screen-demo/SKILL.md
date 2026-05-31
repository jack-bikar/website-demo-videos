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
`scripts/browse-plan.json`. Schema:

```jsonc
{
  "url": "https://app.example.com",          // first page to open
  "viewport": { "width": 1280, "height": 800 },
  "steps": [
    {
      "type": "navigate",                      // navigate | click | type | scroll | wait
      "target": "https://app.example.com/signup", // URL (navigate) or CSS/text selector (click/type)
      "text": null,                            // text to type (type steps only)
      "deltaY": null,                          // scroll amount in px (scroll steps only)
      "ms": null,                              // wait duration (wait steps only)
      "why": "Land on the signup page so viewers see where the flow starts"
    }
  ]
}
```

Rules for building the plan:
- The **first** step is almost always a `navigate` to the URL the user gave.
- Selectors: prefer stable CSS selectors. You may use Puppeteer text selectors like `::-p-text(Sign up)`
  or `text/Sign up` if a CSS selector isn't obvious. Record one selector per interaction.
- Add a short `wait` after navigations or actions that trigger async UI (e.g. `{ "type": "wait", "ms": 1200 }`),
  so the recording captures the result, not a spinner.
- Every step needs a one-line `why` — this is the demo narrative and also helps debugging.

### Stage 2 — Record

Run:

```bash
npm run record
```

`scripts/record.js` will:
1. Load `STEEL_API_KEY` and start a Steel cloud browser session (`client.sessions.create`).
2. Connect to the session's CDP endpoint with `puppeteer-core` (`puppeteer.connect`).
3. Start a CDP screencast (`Page.startScreencast`) — this is how we get real video frames, because
   Steel's native recording is RRWeb events, not an MP4.
4. Execute every step in `browse-plan.json` with randomized 300–800 ms human-like pauses, typing
   character-by-character.
5. After each step, push a moment `{ time, action, type, x, y }` where `time` is ms from the start of
   the screencast and `x`/`y` are the element's center (when a coordinate exists).
6. On finish: stop the screencast, encode the frames to `recordings/raw.mp4` with ffmpeg (preserving
   real-time pacing), copy it to `public/raw.mp4` for Remotion, release the Steel session, and write
   `scripts/moments.json`.

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
- output an array of `{ start, end, action, type }`, all times in ms relative to video start.

### Stage 4 — Camera keyframes

```bash
npm run keyframes
```

`scripts/keyframes.js` reads `clips.json` + `moments.json` and writes `scripts/keyframes.json`. For each
action it emits a zoom-in keyframe (scale **1.3**, centered on the action point if coordinates exist,
otherwise screen center) ~**300 ms before** the action, and a zoom-out keyframe (scale **1.0**) ~**600 ms after**.

### Stage 5 — Build composition

`remotion/DemoVideo.tsx` already consumes `clips.json` and `keyframes.json`. It renders at 60fps, plays the
captured footage at **4× speed**, animates zoom with `spring()`/`interpolate()`, draws a dark navy→indigo
gradient background, and centers the footage in a rounded, soft-shadowed browser frame. No text overlays
unless the user asks. Only edit this file if the user requests visual changes.

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

**A selector isn't found.**
- `record.js` logs the failing step, screenshots it, and continues, so the rest of the demo still records.
  Open the screenshot, pick a better selector (try a Puppeteer text selector `::-p-text(Label)`), update the
  step in `browse-plan.json`, and re-run `npm run record`.

**Render fails.**
- "Cannot find module clips.json / keyframes.json": run `npm run trim` and `npm run keyframes` first
  (or `npm run demo`). Placeholder empty files ship with the repo so the studio still opens.
- "OffthreadVideo could not load source": ensure `public/raw.mp4` exists — it's produced by `npm run record`.
- ffmpeg errors during render: confirm `ffmpeg` is on PATH (`which ffmpeg`). Remotion needs it for encoding.

**Want to preview before rendering.**
- `npx remotion studio remotion/index.ts` opens the interactive studio.
