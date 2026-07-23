# Walkthrough Video Quality Playbook

Use this playbook when creating future website walkthrough videos that should match
the Harbour Taxi Demo result: continuous motion, fluid scroll, no large blank gaps,
stable cursor behavior, and consistent branding.

## Target Result

The canonical output is a polished 16:9 website walkthrough:

- 1920x1080 viewport and output.
- 60fps raw capture, smoothed source, and final render.
- One continuous homepage scroll instead of a static hero hold.
- A visible cursor that stays out of the reading path during scroll, then glides to
  real interaction targets.
- A short branded intro overlay, then immediate site footage.
- No camera zoom unless the specific video needs it.
- No captions/lower-thirds for this style.
- Final render quality set to `final`.

## Source Of Truth

Keep the video behavior in `scripts/browse-plan.json`. For a new site, start by
copying the known-good plan shape and only change the URL, overlay text, hidden
demo notices, and selectors.

Recommended baseline:

```jsonc
{
  "viewport": { "width": 1920, "height": 1080 },
  "recording": {
    "mode": "local",
    "headful": false,
    "stepPauseMs": 0
  },
  "meta": {
    "playbackSpeed": 1,
    "captions": false,
    "zoom": false,
    "preserveStart": true,
    "trimTailMs": 1500,
    "trimMergeMaxGapMs": 6000,
    "trimDeadAirGapMs": 6000,
    "loadingOverlay": true,
    "loadingOverlaySeconds": 1,
    "overlay": {
      "id": "brand-intro",
      "seconds": 1,
      "props": {
        "kicker": "CHANNEL ISLANDS",
        "titleLines": ["BRAND", "DEMO"],
        "footerLeft": "GUERNSEY",
        "footerRight": "DEMO"
      }
    },
    "topCropPx": 0,
    "finalSettleMs": 500,
    "finalHoldSeconds": 0,
    "smoothMode": "mci",
    "renderQuality": "final"
  }
}
```

## Scene Selection

Choose scenes before writing selectors. A good walkthrough is not a full site
recording; it is a guided path through the few surfaces that prove the site is
real, useful, and well designed.

Use this default arc for website/demo UI videos:

1. **Brand and offer signal.** Start on the hero so the viewer immediately sees
   what the site is and what category it belongs to.
2. **Proof of depth.** Move through enough homepage sections to show the design is
   not just a hero: services/features, social proof, FAQ, pricing, integrations,
   or another relevant trust section.
3. **Primary conversion action.** End the homepage pass near the main CTA, then
   move the cursor to it and click.
4. **Functional destination.** Show the page or state behind the CTA: booking
   form, dashboard preview, checkout, contact flow, pricing selection, or support
   request.
5. **Composed ending.** Finish with the important destination surface framed
   cleanly, with no long static hold.

For a SaaS/product marketing surface, prioritize these scenes:

- Hero with product/category clarity.
- Feature cards or workflow section.
- Integrations/logos/social proof if present.
- Pricing/trial/FAQ if the site is selling directly.
- Dashboard or product UI if available.
- Final CTA or form.

For service-business sites, prioritize:

- Hero with place/service signal.
- Core services or packages.
- Trust section: testimonials, availability, process, coverage area, FAQ.
- Booking/contact CTA.
- Booking/contact form or request flow.

Keep the final video short by selecting the minimum path that proves the story.
For this style, the target is usually 12-18 seconds:

- 1 second branded intro.
- 8-12 seconds continuous homepage pass.
- 1-2 seconds CTA glide and click.
- 2-4 seconds destination framing.

Avoid these scene choices:

- Multiple similar sections that repeat the same point.
- Long static hero holds.
- Footer-only endings unless the footer contains the primary CTA.
- Modal/popover states that appear only because of accidental hover.
- Text-heavy sections that cannot be read at scroll speed.
- Extra page transitions when one CTA destination proves the flow.

## Scene Planning Checklist

Before recording, answer these and encode the result in `scripts/browse-plan.json`:

- What is the one-sentence story of the site?
- What is the primary CTA the video should resolve to?
- Which homepage sections prove substance beyond the hero?
- Which sections are visually distinct enough to be worth showing?
- What destination state should the viewer see after the click?
- What should be hidden because it distracts from the demo, such as staging or
  disclaimer text?
- Does every selected scene either increase trust, explain value, or advance the
  CTA path?

If a scene does none of those, cut it. The video should feel like a curated
walkthrough, not a surveillance recording of every pixel on the page.

## Motion Rules

Use one long, linear, continuous scroll for a homepage tour:

```jsonc
{
  "type": "scroll",
  "deltaY": 9000,
  "ms": 12000,
  "pace": "slow",
  "smoothness": "continuous",
  "linear": true,
  "allowFooter": true
}
```

Why:

- `smoothness: "continuous"` makes the recorder emit dense scroll waypoints, so
  trimming keeps the entire movement.
- `linear: true` avoids uneven scroll acceleration that reads as stutter.
- A large `deltaY` is acceptable because the recorder clamps to the actual page
  bounds.
- Avoid `wait` steps during the main tour. If the page is readable but motionless,
  the video feels lower quality even at 60fps.

Use short, purposeful interaction steps after the scroll:

- Cursor glides to the CTA.
- Click the CTA.
- Focus the destination form or product surface.
- Keep the final focus hold short enough to avoid a static ending.

## Capture Decisions

The fluid result depends on capture being deterministic during long scrolls.

- Capture target is 60fps. Do not lower `recording.captureFps` for final videos.
- Long continuous scrolls are rendered frame-by-frame by setting exact scroll
  positions and capturing every frame.
- Live CDP screencast is disabled during deterministic scroll so event-driven
  frames do not create uneven cadence.
- The recorder rejects likely blank fallback screenshots to avoid white sections.
- Page hover targeting is suppressed during deterministic scroll and restored
  before real clicks. This prevents moving page content from briefly reacting to
  the stationary browser pointer under the synthetic cursor.

Do not replace deterministic scroll with a plain live screencast for final
scroll-heavy videos. Live CDP capture can throttle during scroll and will look
less fluid even if the encoded file says 60fps.

## Cursor Rules

The cursor is intentionally synthetic because CDP screencast does not capture the
OS cursor.

- Keep the cursor visible from the first recorded frame.
- During scroll, rest it away from important copy and controls.
- During clicks, glide to the target and dwell briefly so the action reads.
- Do not rely on the page's real hover state during scroll. Hover interactions
  should only matter during intentional click/type/focus steps.
- Keep the click ripple. It makes the click legible, but distinguish it from
  accidental hover flicker during review.

## Render Decisions

For this style, prefer the ffmpeg fast path plus a small Remotion overlay segment.

- Use `meta.captions: false` and `meta.zoom: false` unless the specific project
  requires them.
- Use the branded intro overlay for the first second.
- Use `meta.renderQuality: "final"` for the deliverable.
- Run render with a longer Remotion timeout when the overlay is enabled:

```bash
DEMO_REMOTION_TIMEOUT_MS=240000 npm run render
```

Why:

- The overlay still uses Remotion.
- The rest of the footage can stay on the fast ffmpeg path, which avoids
  unnecessary full-composition render risk.
- A longer Remotion startup timeout avoids false render failures on busy systems.

## Pipeline

For a new final video, run stages explicitly when diagnosing quality:

```bash
npm run record:local
npm run trim
npm run keyframes
npm run smooth
DEMO_REMOTION_TIMEOUT_MS=240000 npm run render
```

Use `npm run demo:local` only when the plan is already stable and you do not need
to inspect intermediate outputs.

## Verification Checklist

Always verify the raw, smoothed, and final files.

```bash
ffprobe -v error -select_streams v:0 \
  -show_entries stream=width,height,r_frame_rate,avg_frame_rate,duration,nb_frames \
  -of default=noprint_wrappers=1 output/demo.mp4
```

Required final profile:

- `width=1920`
- `height=1080`
- `r_frame_rate=60/1`
- `avg_frame_rate=60/1`
- Frame count should match duration times 60, allowing normal rounding.

Run a duplicate/static-frame scan:

```bash
ffmpeg -hide_banner -i output/demo.mp4 -vf mpdecimate -an -f null -
```

Interpretation:

- Some duplicates are normal in the intro, click dwell, and final settle.
- Duplicates across the scroll region are a warning sign.
- A 60fps file can still feel bad if many adjacent frames are identical during
  motion, so do not rely on `ffprobe` alone.

Extract visual samples:

```bash
mkdir -p /private/tmp/wdv-review
ffmpeg -hide_banner -loglevel error -y -ss 2.5 -i output/demo.mp4 -frames:v 1 /private/tmp/wdv-review/02.5.jpg
ffmpeg -hide_banner -loglevel error -y -ss 6.5 -i output/demo.mp4 -frames:v 1 /private/tmp/wdv-review/06.5.jpg
ffmpeg -hide_banner -loglevel error -y -ss 9.5 -i output/demo.mp4 -frames:v 1 /private/tmp/wdv-review/09.5.jpg
```

For suspected cursor or hover problems, make a cropped contact sheet around the
interaction area:

```bash
ffmpeg -hide_banner -loglevel error -y -ss 9.0 -t 1.4 -i output/demo.mp4 \
  -vf "fps=12,crop=520:180:1040:0,scale=520:180,tile=4x4" \
  -frames:v 1 /private/tmp/wdv-review/hover-tile.jpg
```

Review for:

- No large white/blank sections.
- No flickering hover states during scroll.
- Cursor remains visible and stable.
- The click ripple appears only around the intentional click.
- Intro text matches the new site brand.
- Destination page loads and form/product surface is framed.

## Studio Sync

When a Studio project is already using a specific take/render, keep the database
and artifacts in sync after rebuilding.

Copy these generated files into the active take:

- `recordings/raw.mp4` -> take `raw.mp4`
- `public/raw.mp4` -> take `smooth.mp4`
- `scripts/moments.json` -> take `moments.json`
- `scripts/clips.json` -> take `clips.json`
- `scripts/keyframes.json` -> take `keyframes.json`
- `output/demo.mp4` -> render mp4

Update the project/take/render rows:

- Project URL, viewport, steps, meta, recording config, hidden text.
- Take `status = "processed"`.
- Take and render `duration_ms` from the final `ffprobe` duration.
- Project display name, if the site brand changed.

Then probe the Studio render copy, not only `output/demo.mp4`.

## Reusability Techniques

Use these practices before adding more one-off code:

- Keep a reusable plan template. Most future videos should be a plan edit, not a
  recorder or renderer edit.
- Treat schema fields as contracts. Add fields to `packages/schema` only when the
  behavior will be reused across multiple videos.
- Keep motion behavior in shared capture code, not in individual plans. The
  deterministic scroll and hover suppression should benefit every scroll-heavy
  video automatically.
- Keep visual branding in overlay props. New brand, same overlay component.
- Keep quality gates as commands. Future agents should run `ffprobe`, `mpdecimate`,
  and frame/contact-sheet inspection before calling a render done.
- Keep golden comparisons. When a video is considered excellent, save a prior
  render or contact sheets so future changes can be compared visually.
- Prefer small named presets over many ad hoc flags. If several videos reuse this
  style, add a "continuous homepage walkthrough" preset rather than copying
  scattered magic numbers.
- Snapshot plans into Studio takes. A final MP4 should always be traceable back to
  the exact URL, steps, meta, and recording settings that produced it.

## When To Change The Standard

Change this playbook only after a new video proves a better pattern.

Do not change defaults because a single page is unusual. Instead, first adjust the
site-specific plan. Promote the change to shared code or this document only when
it improves multiple future recordings.
