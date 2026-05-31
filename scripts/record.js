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

// ---- Small helpers --------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const humanPause = () => sleep(300 + Math.floor(Math.random() * 500)); // 300–800ms
const ensureDir = (d) => fs.mkdirSync(d, { recursive: true });

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

/** Resolve a step's target element and return its center coordinates, or null. */
async function centerOf(page, selector) {
  try {
    const el = await page.waitForSelector(selector, { timeout: 8000 });
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
async function runStep(page, step, t0Ref, moments, index) {
  const type = step.type;
  let x = null;
  let y = null;

  switch (type) {
    case 'navigate': {
      await page.goto(step.target, { waitUntil: 'networkidle2', timeout: 45000 });
      break;
    }
    case 'click': {
      const { handle, x: cx, y: cy } = await centerOf(page, step.target);
      if (!handle) throw new Error(`Selector not found for click: ${step.target}`);
      x = cx;
      y = cy;
      await handle.click();
      break;
    }
    case 'type': {
      const { handle, x: cx, y: cy } = await centerOf(page, step.target);
      if (!handle) throw new Error(`Selector not found for type: ${step.target}`);
      x = cx;
      y = cy;
      await handle.click();
      await handle.type(String(step.text ?? ''), { delay: 60 }); // char-by-char, human-like
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

  moments.push({
    time: Date.now() - t0Ref.t,
    action: step.why || step.target || type,
    type,
    x,
    y,
  });
  console.log(`  ✓ step ${index + 1} (${type})${x != null ? ` @ ${x},${y}` : ''}`);
}

// ---- Main -----------------------------------------------------------------
async function main() {
  const apiKey = process.env.STEEL_API_KEY;
  if (!apiKey) {
    throw new Error('STEEL_API_KEY is not set. Add it to .env.local (it is read from the environment).');
  }

  ensureDir(RECORDINGS_DIR);
  ensureDir(PUBLIC_DIR);

  const plan = loadBrowsePlan();
  const viewport = plan.viewport || DEFAULT_VIEWPORT;

  const client = new Steel(); // reads STEEL_API_KEY from env automatically
  const moments = [];
  const t0Ref = { t: Date.now() };

  let session;
  let browser;
  let screencast;

  try {
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
    });

    const pages = await browser.pages();
    const page = pages[0] || (await browser.newPage());
    await page.setViewport(viewport);

    console.log('• Starting screencast…');
    screencast = await startScreencast(page, viewport, t0Ref);

    console.log(`• Executing ${plan.steps.length} steps…`);
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      try {
        await runStep(page, step, t0Ref, moments, i);
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
        await browser.disconnect();
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
