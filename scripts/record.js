#!/usr/bin/env node
/**
 * Stage 2 — Record.
 *
 * Launches a Steel Dev cloud browser, drives it through scripts/browse-plan.json with
 * human-like timing, and captures real video frames over CDP (Page.startScreencast).
 *
 * Steel's *native* session recording is RRWeb events, not an MP4 — so to get an actual
 * video file we screencast JPEG frames over the Chrome DevTools Protocol and encode them
 * to recordings/raw.mp4 with ffmpeg, preserving real-time pacing so the timestamps in
 * scripts/moments.json line up with the video timeline.
 *
 * Outputs:
 *   - recordings/raw.mp4     the captured footage (real-time paced)
 *   - public/raw.mp4         a copy Remotion can load via staticFile('raw.mp4')
 *   - scripts/moments.json   [{ time, action, type, x, y }] (time in ms from video start)
 *
 * Requires: STEEL_API_KEY (from .env.local or .env), puppeteer-core, ffmpeg on PATH.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Load env from .env.local first (this project's convention), then .env as a fallback.
const ROOT = path.resolve(__dirname, '..');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(ROOT, '.env.local') });
dotenv.config({ path: path.join(ROOT, '.env') });

const Steel = require('steel-sdk').default || require('steel-sdk');
const puppeteer = require('puppeteer-core');

// ---- Paths (all relative to project root) ---------------------------------
const BROWSE_PLAN = path.join(ROOT, 'scripts', 'browse-plan.json');
const MOMENTS_OUT = path.join(ROOT, 'scripts', 'moments.json');
const RECORDINGS_DIR = path.join(ROOT, 'recordings');
const PUBLIC_DIR = path.join(ROOT, 'public');
const RAW_MP4 = path.join(RECORDINGS_DIR, 'raw.mp4');
const PUBLIC_MP4 = path.join(PUBLIC_DIR, 'raw.mp4');

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

// Chrome DevTools Protocol calls (e.g. Runtime.callFunctionOn) default to a ~30s timeout,
// which a busy authenticated SPA can blow past. Bump it generously for every connection.
const PROTOCOL_TIMEOUT = 180000;

const truthy = (v) => ['1', 'true', 'yes'].includes(String(v || '').toLowerCase());

/**
 * Resolve the recording mode from the plan's `recording` block, with environment variables as
 * optional overrides (handy for CI / one-off runs). Everything lives in browse-plan.json so the
 * whole demo is configured in one file; env vars just win when present.
 *
 *   mode "cloud"    create a Steel Dev cloud browser session (needs STEEL_API_KEY).
 *   mode "local"    launch a fresh local Chrome (great for localhost / dev servers).
 *   mode "connect"  attach to an already-running, already-authenticated Chrome exposing a
 *                   remote-debugging port (e.g. http://127.0.0.1:9222) — this is how authed
 *                   apps (Clerk/OAuth) record, by reusing a live logged-in session.
 */
function resolveRecordingConfig(plan) {
  const r = (plan && plan.recording) || {};
  const env = process.env;
  // Env overrides: DEMO_CONNECT_URL implies connect, DEMO_LOCAL=1 implies local.
  const connectUrl = (env.DEMO_CONNECT_URL || r.connectUrl || '').trim() || null;
  let mode = r.mode || 'cloud';
  if (env.DEMO_CONNECT_URL) mode = 'connect';
  else if (truthy(env.DEMO_LOCAL)) mode = 'local';
  if (mode === 'connect' && !connectUrl) {
    throw new Error('recording.mode is "connect" but no connectUrl/DEMO_CONNECT_URL was provided.');
  }
  return {
    mode,
    connectUrl,
    headful: env.DEMO_HEADFUL !== undefined ? truthy(env.DEMO_HEADFUL) : !!r.headful,
    userDataDir: env.DEMO_USER_DATA_DIR || r.userDataDir || undefined,
    chromePath: env.CHROME_PATH || r.chromePath || undefined,
  };
}

// ---- Small helpers --------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const humanPause = () => sleep(300 + Math.floor(Math.random() * 500)); // 300–800ms
const ensureDir = (d) => fs.mkdirSync(d, { recursive: true });

/**
 * Substitute {{name}} placeholders with values captured earlier in the run (see the
 * `capture` step type). Unknown names are left intact so a typo is visible in the output
 * rather than silently blanked. Used on a step's target and text so a value generated at
 * runtime (e.g. an access code) can be carried forward into a later step.
 */
const TEMPLATE_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;
function applyVars(value, vars) {
  if (typeof value !== 'string') return value;
  return value.replace(TEMPLATE_RE, (whole, name) => (name in vars ? String(vars[name]) : whole));
}

function loadBrowsePlan() {
  if (!fs.existsSync(BROWSE_PLAN)) {
    throw new Error(
      `No browse plan found at ${path.relative(ROOT, BROWSE_PLAN)}. ` +
        `Stage 1 must create it first (see the screen-demo skill).`,
    );
  }
  const plan = JSON.parse(fs.readFileSync(BROWSE_PLAN, 'utf8'));
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    throw new Error('browse-plan.json has no steps.');
  }
  return plan;
}

/**
 * Build the CDP/WebSocket endpoint puppeteer-core connects to. Steel's connect endpoint
 * authenticates via an apiKey query param, so append it (and the sessionId) if missing.
 */
function buildWsEndpoint(session, apiKey) {
  const url = new URL(session.websocketUrl);
  if (!url.searchParams.has('apiKey')) url.searchParams.set('apiKey', apiKey);
  if (!url.searchParams.has('sessionId')) url.searchParams.set('sessionId', session.id);
  return url.toString();
}

/** Find the Chrome Headless Shell that Remotion already downloaded for rendering. */
function findRemotionChrome() {
  const base = path.join(ROOT, 'node_modules', '.remotion', 'chrome-headless-shell');
  if (!fs.existsSync(base)) return null;
  for (const platform of fs.readdirSync(base)) {
    const platformDir = path.join(base, platform);
    if (!fs.statSync(platformDir).isDirectory()) continue;
    for (const sub of fs.readdirSync(platformDir)) {
      const exe = path.join(platformDir, sub, 'chrome-headless-shell');
      if (fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

/**
 * Locate a Chrome/Chromium executable for local-mode recording. Prefers an explicit
 * chromePath (from recording.chromePath / CHROME_PATH), then a real installed browser (best
 * fidelity), then Remotion's bundled headless shell so no extra download is needed.
 */
function resolveLocalChrome(chromePath) {
  const candidates = [
    chromePath,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    findRemotionChrome(),
  ].filter(Boolean);

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    'No local Chrome/Chromium found. Install Google Chrome or set recording.chromePath (or CHROME_PATH).',
  );
}

/**
 * Wait for a selector, retrying a few times before giving up. A single waitForSelector can
 * lose a race on a busy SPA (element briefly detaches/re-renders); a short retry loop makes
 * plans far more robust. Prefer stable hooks like [data-tour="…"] / [data-testid="…"] in the
 * plan so selectors survive copy and layout changes.
 */
async function waitForSelectorRetry(page, selector, { timeout = 8000, retries = 2 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const el = await page.waitForSelector(selector, { timeout });
      if (el) return el;
    } catch (e) {
      lastErr = e;
    }
    if (attempt < retries) await sleep(400);
  }
  if (lastErr) throw lastErr;
  return null;
}

/** Resolve a step's target element and return its center coordinates, or null. */
async function centerOf(page, selector) {
  try {
    const el = await waitForSelectorRetry(page, selector);
    if (!el) return { handle: null, x: null, y: null };
    const box = await el.boundingBox();
    if (!box) return { handle: el, x: null, y: null };
    return { handle: el, x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  } catch (_e) {
    return { handle: null, x: null, y: null };
  }
}

// ---- Screencast capture ---------------------------------------------------
/**
 * Starts a CDP screencast and collects frames in memory with their arrival offset (ms).
 * Returns { stop } — call stop() to end the screencast and return the captured frames.
 */
async function startScreencast(page, viewport, t0Ref) {
  const cdp = await page.createCDPSession();
  const frames = [];

  cdp.on('Page.screencastFrame', async (frame) => {
    // t0Ref.t is set the moment we kick off the screencast so offsets are video-relative.
    frames.push({ buffer: Buffer.from(frame.data, 'base64'), t: Date.now() - t0Ref.t });
    try {
      await cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId });
    } catch (_e) {
      /* session may have ended; ignore */
    }
  });

  t0Ref.t = Date.now();
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 80,
    maxWidth: viewport.width,
    maxHeight: viewport.height,
    everyNthFrame: 1,
  });

  return {
    frames,
    stop: async () => {
      try {
        await cdp.send('Page.stopScreencast');
      } catch (_e) {
        /* ignore */
      }
    },
  };
}

/**
 * Encode captured frames to an MP4 that preserves real-time pacing.
 * Uses the ffmpeg concat demuxer with per-frame durations derived from arrival offsets,
 * so the video's timeline matches moments.json (which is later consumed by trim.js).
 */
function encodeFrames(frames, outPath) {
  if (frames.length === 0) throw new Error('No frames were captured — recording is empty.');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-frames-'));
  try {
    const lines = [];
    for (let i = 0; i < frames.length; i++) {
      const file = path.join(tmpDir, `frame-${String(i).padStart(5, '0')}.jpg`);
      fs.writeFileSync(file, frames[i].buffer);
      // Duration until the next frame (clamped); last frame held for 1s.
      const next = i < frames.length - 1 ? frames[i + 1].t : frames[i].t + 1000;
      const dur = Math.max(0.016, (next - frames[i].t) / 1000);
      lines.push(`file '${file}'`);
      lines.push(`duration ${dur.toFixed(3)}`);
    }
    // The concat demuxer needs the final file repeated for its duration to apply.
    lines.push(`file '${path.join(tmpDir, `frame-${String(frames.length - 1).padStart(5, '0')}.jpg`)}'`);

    const listFile = path.join(tmpDir, 'frames.txt');
    fs.writeFileSync(listFile, lines.join('\n'));

    ensureDir(path.dirname(outPath));
    const res = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', listFile,
        '-vsync', 'vfr',
        '-pix_fmt', 'yuv420p',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-movflags', '+faststart',
        outPath,
      ],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    );
    if (res.status !== 0) {
      throw new Error(`ffmpeg exited with code ${res.status}. Is ffmpeg installed and on PATH?`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---- Step execution -------------------------------------------------------
async function runStep(page, step, t0Ref, moments, index, vars) {
  const type = step.type;
  // Resolve {{var}} placeholders against values captured earlier in the run.
  const target = applyVars(step.target, vars);
  const text = applyVars(step.text, vars);
  let x = null;
  let y = null;

  switch (type) {
    case 'navigate': {
      await page.goto(target, { waitUntil: 'networkidle2', timeout: 45000 });
      break;
    }
    case 'click': {
      const { handle, x: cx, y: cy } = await centerOf(page, target);
      if (!handle) throw new Error(`Selector not found for click: ${target}`);
      x = cx;
      y = cy;
      await handle.click();
      break;
    }
    case 'type': {
      const { handle, x: cx, y: cy } = await centerOf(page, target);
      if (!handle) throw new Error(`Selector not found for type: ${target}`);
      x = cx;
      y = cy;
      await handle.click();
      await handle.type(String(text ?? ''), { delay: 60 }); // char-by-char, human-like
      break;
    }
    case 'capture': {
      // Read a value rendered at runtime (e.g. a generated access code) and stash it under
      // step.as so a later step can reference it with {{as}}. We zoom to it like any action.
      if (!step.as) throw new Error('capture step requires an "as" field to name the value.');
      const { handle, x: cx, y: cy } = await centerOf(page, target);
      if (!handle) throw new Error(`Selector not found for capture: ${target}`);
      x = cx;
      y = cy;
      const value = String(
        await page.evaluate((el) => (el.value ?? el.textContent ?? '').trim(), handle),
      );
      vars[step.as] = value;
      console.log(`  ⧉ captured ${step.as} = ${JSON.stringify(value)}`);
      break;
    }
    case 'scroll': {
      const dy = Number(step.deltaY ?? 600);
      await page.evaluate((d) => window.scrollBy({ top: d, behavior: 'smooth' }), dy);
      break;
    }
    case 'wait': {
      await sleep(Number(step.ms ?? 1000));
      break;
    }
    default:
      throw new Error(`Unknown step type: ${type}`);
  }

  const moment = {
    time: Date.now() - t0Ref.t,
    // `caption` is the authored, on-screen scene description; `why` is the debug note. Fall
    // back through caption → why → target → type so a lower-third always has something to show.
    action: step.caption || step.why || target || type,
    type,
    x,
    y,
  };
  // Optional per-step playback speed (a "per-section" override the composition honors).
  if (Number.isFinite(step.speed)) moment.speed = step.speed;
  moments.push(moment);
  console.log(`  ✓ step ${index + 1} (${type})${x != null ? ` @ ${x},${y}` : ''}`);
}

// ---- Main -----------------------------------------------------------------
async function main() {
  ensureDir(RECORDINGS_DIR);
  ensureDir(PUBLIC_DIR);

  const plan = loadBrowsePlan();
  const viewport = plan.viewport || DEFAULT_VIEWPORT;
  const rec = resolveRecordingConfig(plan);

  const moments = [];
  const vars = {}; // runtime values captured by `capture` steps, referenced via {{name}}
  const t0Ref = { t: Date.now() };

  let client; // Steel client (cloud mode only)
  let session; // Steel session (cloud mode only)
  let browser;
  let screencast;

  try {
    let page;

    if (rec.mode === 'connect') {
      // Attach to an already-running, already-authenticated Chrome (started with
      // --remote-debugging-port). Reuses its live session, so Clerk/OAuth-gated apps record
      // logged in. We connect rather than launch, so we must NOT close it on teardown.
      console.log(`• Connecting to existing Chrome at ${rec.connectUrl}…`);
      browser = await puppeteer.connect({
        browserURL: rec.connectUrl,
        protocolTimeout: PROTOCOL_TIMEOUT,
        defaultViewport: viewport,
      });
      const pages = await browser.pages();
      page = pages.find((p) => /^https?:/.test(p.url())) || pages[0] || (await browser.newPage());
      await page.bringToFront();
    } else if (rec.mode === 'local') {
      const executablePath = resolveLocalChrome(rec.chromePath);
      // Optional: reuse a pre-authenticated Chrome profile so the recording starts logged in
      // (recording.userDataDir / DEMO_USER_DATA_DIR). Must be an unlocked copy — Chrome locks a
      // profile while another instance has it open.
      const userDataDir = rec.userDataDir;
      console.log(`• Launching local Chrome (${rec.headful ? 'headful' : 'headless'})`);
      console.log(`  ${executablePath}`);
      if (userDataDir) console.log(`  profile: ${userDataDir}`);
      browser = await puppeteer.launch({
        executablePath,
        headless: !rec.headful,
        defaultViewport: viewport,
        protocolTimeout: PROTOCOL_TIMEOUT,
        userDataDir,
        args: [
          `--window-size=${viewport.width},${viewport.height}`,
          '--hide-scrollbars',
          '--force-device-scale-factor=1',
          '--no-first-run',
          '--no-default-browser-check',
        ],
      });
      const pages = await browser.pages();
      page = pages[0] || (await browser.newPage());
    } else {
      const apiKey = process.env.STEEL_API_KEY;
      if (!apiKey) {
        throw new Error(
          'STEEL_API_KEY is not set. Add it to .env.local, or set recording.mode to "local"/"connect".',
        );
      }
      client = new Steel(); // reads STEEL_API_KEY from env automatically
      console.log('• Creating Steel session…');
      session = await client.sessions.create({
        dimensions: { width: viewport.width, height: viewport.height },
        timeout: 600000,
      });
      console.log(`  session ${session.id} — viewer: ${session.sessionViewerUrl}`);

      const wsEndpoint = buildWsEndpoint(session, apiKey);
      browser = await puppeteer.connect({
        browserWSEndpoint: wsEndpoint,
        defaultViewport: viewport,
        protocolTimeout: PROTOCOL_TIMEOUT,
      });
      const pages = await browser.pages();
      page = pages[0] || (await browser.newPage());
    }

    await page.setViewport(viewport);

    console.log('• Starting screencast…');
    screencast = await startScreencast(page, viewport, t0Ref);

    console.log(`• Executing ${plan.steps.length} steps…`);
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      try {
        await runStep(page, step, t0Ref, moments, i, vars);
      } catch (err) {
        console.warn(`  ⚠ step ${i + 1} (${step.type}) failed: ${err.message} — continuing.`);
        try {
          await page.screenshot({ path: path.join(RECORDINGS_DIR, `error-${i + 1}.png`) });
        } catch (_e) {
          /* ignore screenshot failures */
        }
      }
      await humanPause();
    }

    // Let the final state settle on screen before we cut.
    await sleep(800);
  } finally {
    if (screencast) await screencast.stop();
    if (browser) {
      try {
        // A browser we launched must be closed (kills the process); one we connected to
        // (cloud session or connect-mode Chrome) is only disconnected so it keeps running.
        if (rec.mode === 'local') await browser.close();
        else await browser.disconnect();
      } catch (_e) {
        /* ignore */
      }
    }
    if (session && client) {
      try {
        await client.sessions.release(session.id);
        console.log(`• Released session ${session.id}.`);
      } catch (_e) {
        /* ignore */
      }
    }
  }

  const frames = screencast ? screencast.frames : [];
  console.log(`• Captured ${frames.length} frames; encoding to ${path.relative(ROOT, RAW_MP4)}…`);
  encodeFrames(frames, RAW_MP4);
  fs.copyFileSync(RAW_MP4, PUBLIC_MP4); // Remotion loads this via staticFile('raw.mp4')

  fs.writeFileSync(MOMENTS_OUT, JSON.stringify(moments, null, 2));
  const durationMs = moments.length ? moments[moments.length - 1].time : frames.length ? frames[frames.length - 1].t : 0;
  console.log(`✓ Recorded ${moments.length} moments over ~${(durationMs / 1000).toFixed(1)}s.`);
  console.log(`  raw video → ${path.relative(ROOT, RAW_MP4)}`);
  console.log(`  moments   → ${path.relative(ROOT, MOMENTS_OUT)}`);
  console.log('  Next: npm run trim');
}

main().catch((err) => {
  console.error('✗ Recording failed:', err.message);
  process.exit(1);
});
