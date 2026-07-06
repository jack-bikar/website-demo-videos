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
// High JPEG quality at 1080p can starve CDP screencast delivery during long scrolls, producing
// uneven frame gaps that read as lag. 82 keeps UI text crisp while giving Chrome more room to
// return frames consistently.
const DEFAULT_SCREENCAST_QUALITY = 82;

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
  const stepPauseRaw = env.DEMO_STEP_PAUSE_MS !== undefined ? env.DEMO_STEP_PAUSE_MS : r.stepPauseMs;
  const parsedStepPause = stepPauseRaw === undefined || stepPauseRaw === null ? null : Number(stepPauseRaw);
  const qualityRaw = env.DEMO_SCREENCAST_QUALITY !== undefined ? env.DEMO_SCREENCAST_QUALITY : r.screencastQuality;
  const parsedQuality = qualityRaw === undefined || qualityRaw === null ? null : Number(qualityRaw);
  return {
    mode,
    connectUrl,
    headful: env.DEMO_HEADFUL !== undefined ? truthy(env.DEMO_HEADFUL) : !!r.headful,
    userDataDir: env.DEMO_USER_DATA_DIR || r.userDataDir || undefined,
    chromePath: env.CHROME_PATH || r.chromePath || undefined,
    stepPauseMs: Number.isFinite(parsedStepPause) ? Math.max(0, parsedStepPause) : null,
    screencastQuality: Number.isFinite(parsedQuality)
      ? Math.max(1, Math.min(100, Math.round(parsedQuality)))
      : DEFAULT_SCREENCAST_QUALITY,
  };
}

// ---- Small helpers --------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const humanPause = () => sleep(300 + Math.floor(Math.random() * 500)); // 300–800ms
const ensureDir = (d) => fs.mkdirSync(d, { recursive: true });
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// Where the visible cursor currently sits, tracked in Node so a glide always starts from the
// cursor's real position (never a teleport from 0,0).
const mouse = { x: null, y: null };

async function syncVisibleCursor(page, x, y, instant = false) {
  try {
    await page.evaluate(
      (px, py, jump) => {
        const ID = '__demoCursor__';
        let c = document.getElementById(ID);
        if (!c) {
          c = document.createElement('div');
          c.id = ID;
          c.style.cssText =
            'position:fixed;left:-100px;top:-100px;width:44px;height:44px;z-index:2147483647;pointer-events:none;' +
            'transition:left .07s linear,top .07s linear;filter:drop-shadow(0 3px 6px rgba(0,0,0,.55));';
          c.innerHTML =
            '<svg width="44" height="44" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
            '<path d="M5 3l14 7-5.5 1.6L10 19 5 3z" fill="#fff" stroke="#111" stroke-width="1.8" stroke-linejoin="round"/></svg>';
          document.documentElement.appendChild(c);
        }
        const move = function (mx, my) {
          c.style.left = mx + 'px';
          c.style.top = my + 'px';
        };
        window.__demoCursor = window.__demoCursor || {};
        window.__demoCursor.move = move;
        window.__demoCursor.place = function (mx, my) {
          const prev = c.style.transition;
          c.style.transition = 'none';
          move(mx, my);
          void c.offsetWidth;
          c.style.transition = prev || 'left .07s linear,top .07s linear';
        };
        if (jump) window.__demoCursor.place(px, py);
        else move(px, py);
      },
      x,
      y,
      instant,
    );
  } catch (_e) {
    /* cursor not injectable on this document — ignore */
  }
}

/**
 * Move the mouse from its current position to (toX,toY) over a REAL duration, emitting many
 * small steps with sleeps between them so the screencast captures a smooth, human-paced glide.
 * (puppeteer's built-in `steps` option fires every step with no delay, which snaps instantly on
 * camera.) easeInOutQuad accelerates out of the start and eases into the target like a real hand.
 */
async function glideMouse(page, toX, toY, durationMs = 1000) {
  const fromX = mouse.x == null ? toX : mouse.x;
  const fromY = mouse.y == null ? toY : mouse.y;
  const dist = Math.hypot(toX - fromX, toY - fromY);
  const steps = Math.max(24, Math.min(90, Math.round(dist / 8)));
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const perStep = durationMs / steps;
  for (let i = 1; i <= steps; i++) {
    const t = ease(i / steps);
    const x = Math.round(fromX + (toX - fromX) * t);
    const y = Math.round(fromY + (toY - fromY) * t);
    await page.mouse.move(x, y);
    await syncVisibleCursor(page, x, y);
    await sleep(perStep);
  }
  mouse.x = toX;
  mouse.y = toY;
}

/** Instantly place the (visible) cursor without any visible glide, and record its position. Used
 *  to seat the cursor at a natural resting spot at the start and after each navigation. */
async function cursorPlace(page, x, y) {
  await syncVisibleCursor(page, x, y, true);
  await page.mouse.move(x, y); // keep puppeteer's internal pointer in sync
  mouse.x = x;
  mouse.y = y;
}

/**
 * During scroll tours, keep the cursor out of the reading path. Downward scrolls progressively
 * bias the cursor rightward; upward scrolls relax it slightly left so it still feels hand-driven.
 */
async function cursorRestForScroll(page, deltaY, durationMs = 500) {
  const vp = page.viewport() || DEFAULT_VIEWPORT;
  const marginX = Math.round(vp.width * 0.07);
  const direction = deltaY >= 0 ? 1 : -1;
  const targetX =
    mouse.x == null
      ? Math.round(vp.width * 0.68)
      : Math.round(mouse.x + direction * (deltaY >= 0 ? vp.width * 0.08 : vp.width * 0.04));
  const x = clamp(targetX, Math.round(vp.width * 0.58), vp.width - marginX);
  const targetY = deltaY >= 0 ? Math.round(vp.height * 0.64) : Math.round(vp.height * 0.36);
  const y = clamp(
    mouse.y == null ? targetY : Math.round(mouse.y * 0.65 + targetY * 0.35),
    Math.round(vp.height * 0.18),
    Math.round(vp.height * 0.82),
  );

  await glideMouse(page, x, y, clamp(Math.round(durationMs * 0.18), 340, 720));
  return { x, y };
}

/**
 * Find a visible form/card/dialog-like region and return a natural cursor rest point near one of
 * its right corners. This is intentionally heuristic so plans stay portable across unrelated sites.
 */
async function findContextRestSpot(page) {
  const vp = page.viewport() || DEFAULT_VIEWPORT;
  return page.evaluate(
    ({ vw, vh, currentX, currentY }) => {
      const visibleRect = (el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 180 || rect.height < 90) return null;
        const left = Math.max(0, rect.left);
        const top = Math.max(0, rect.top);
        const right = Math.min(vw, rect.right);
        const bottom = Math.min(vh, rect.bottom);
        const width = right - left;
        const height = bottom - top;
        if (width < 160 || height < 80) return null;
        return { left, top, right, bottom, width, height, area: width * height, raw: rect };
      };

      const isVisible = (el) => {
        const style = window.getComputedStyle(el);
        return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0.05;
      };

      const textFor = (el) =>
        `${el.tagName || ''} ${el.id || ''} ${el.className || ''} ${el.getAttribute('role') || ''} ${
          el.getAttribute('aria-label') || ''
        }`.toLowerCase();

      const candidates = Array.from(
        document.querySelectorAll('form,[role="form"],[role="dialog"],fieldset,section,article,main,aside,div'),
      );
      let best = null;

      for (const el of candidates) {
        if (!isVisible(el)) continue;
        const rect = visibleRect(el);
        if (!rect) continue;

        const label = textFor(el);
        const inputCount = el.querySelectorAll('input:not([type="hidden"]),textarea,select').length;
        const buttonCount = el.querySelectorAll('button,a[href],[role="button"]').length;
        const isFormTag = el.tagName && el.tagName.toLowerCase() === 'form';
        const isDialog = label.includes('dialog') || label.includes('modal');
        const nameMatch = /(form|booking|reservation|checkout|payment|contact|signup|sign-up|login|request|details|journey|trip|settings|profile|account)/.test(
          label,
        );
        const focusLike = inputCount > 0 || isFormTag || isDialog || nameMatch;
        if (!focusLike) continue;

        const tooMuchPage = rect.width > vw * 0.92 && rect.height > vh * 0.82;
        const fieldScore = inputCount * 130 + buttonCount * 24;
        const semanticScore = (isFormTag ? 240 : 0) + (isDialog ? 170 : 0) + (nameMatch ? 120 : 0);
        const sizeScore = Math.min(220, rect.area / 5000) - (tooMuchPage ? 180 : 0);
        const centerY = rect.top + rect.height / 2;
        const centerBias = 90 - Math.min(90, Math.abs(centerY - vh / 2) / 4);
        const score = fieldScore + semanticScore + sizeScore + centerBias;

        if (score < 210) continue;
        if (!best || score > best.score) best = { el, rect, score, inputCount, label };
      }

      if (!best) return null;

      const r = best.rect;
      const insetX = Math.max(34, Math.min(76, r.width * 0.08));
      const topY = r.top + Math.max(34, Math.min(78, r.height * 0.14));
      const bottomY = r.bottom - Math.max(34, Math.min(78, r.height * 0.14));
      const current = Number.isFinite(currentY) ? currentY : vh * 0.55;
      const y = Math.abs(topY - current) <= Math.abs(bottomY - current) ? topY : bottomY;

      return {
        x: Math.round(Math.min(vw - 52, Math.max(28, r.right - insetX))),
        y: Math.round(Math.min(vh - 52, Math.max(28, y))),
        label: best.label.slice(0, 80),
        score: Math.round(best.score),
      };
    },
    { vw: vp.width, vh: vp.height, currentX: mouse.x, currentY: mouse.y },
  );
}

async function cursorRestForContext(page, durationMs = 700) {
  let spot = null;
  try {
    spot = await findContextRestSpot(page);
  } catch (_e) {
    return { x: mouse.x, y: mouse.y };
  }
  if (!spot) return { x: mouse.x, y: mouse.y };
  const dist = mouse.x == null || mouse.y == null ? Infinity : Math.hypot(spot.x - mouse.x, spot.y - mouse.y);
  if (dist > 18) {
    await glideMouse(page, spot.x, spot.y, durationMs);
  }
  return { x: spot.x, y: spot.y };
}

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

/**
 * Injected into every page so a real mouse cursor is visible in the recording. The CDP
 * screencast does NOT capture the OS cursor, so we draw our own: an arrow that follows the
 * synthesized mouse moves, plus a soft ripple on each click. Lives on <html> so SPA re-renders
 * of <body> don't remove it.
 */
function installCursor() {
  var ID = '__demoCursor__';
  function install() {
    if (!document.documentElement || document.getElementById(ID)) return;
    var c = document.createElement('div');
    c.id = ID;
    // Visible from the start; Node seats it at a natural resting spot (off the corner) before the
    // recording begins, then it follows the synthesized mouse moves.
    c.style.cssText =
      'position:fixed;left:-100px;top:-100px;width:44px;height:44px;z-index:2147483647;pointer-events:none;' +
      'transition:left .07s linear,top .07s linear;' +
      'filter:drop-shadow(0 3px 6px rgba(0,0,0,.55));';
    c.innerHTML =
      '<svg width="44" height="44" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M5 3l14 7-5.5 1.6L10 19 5 3z" fill="#fff" stroke="#111" stroke-width="1.8" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(c);
    var move = function (x, y) {
      c.style.left = x + 'px';
      c.style.top = y + 'px';
    };
    document.addEventListener('mousemove', function (e) { move(e.clientX, e.clientY); }, true);
    document.addEventListener('mousedown', function (e) {
      c.style.filter = 'drop-shadow(0 3px 6px rgba(0,0,0,.55)) brightness(0.85)';
      setTimeout(function () { c.style.filter = 'drop-shadow(0 3px 6px rgba(0,0,0,.55))'; }, 160);
      var r = document.createElement('div');
      r.style.cssText =
        'position:fixed;z-index:2147483646;pointer-events:none;border-radius:50%;' +
        'left:' + (e.clientX - 16) + 'px;top:' + (e.clientY - 16) + 'px;width:32px;height:32px;' +
        'background:rgba(56,132,255,.5);border:3px solid rgba(56,132,255,1);' +
        'box-shadow:0 0 18px rgba(56,132,255,.6);' +
        'transition:transform .5s ease-out,opacity .5s ease-out;';
      document.documentElement.appendChild(r);
      requestAnimationFrame(function () { r.style.transform = 'scale(3.5)'; r.style.opacity = '0'; });
      setTimeout(function () { r.remove(); }, 550);
    }, true);

    // Node hook to seat the cursor at a position with no visible streak (used at start / after nav).
    window.__demoCursor = {
      move: move,
      place: function (x, y) {
        var prev = c.style.transition;
        c.style.transition = 'none'; // jump with no visible streak
        move(x, y);
        void c.offsetWidth; // force reflow so 'none' applies before we restore the transition
        c.style.transition = prev;
      },
    };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  install();
  setTimeout(install, 400);
}

/**
 * Removes known non-demo page furniture (for example a staging disclaimer) before it appears
 * in the screencast. Text matching is exact after whitespace normalization.
 */
function installTextHider(hiddenText) {
  var needles = Array.isArray(hiddenText)
    ? hiddenText
        .map(function (t) {
          return String(t || '').replace(/\s+/g, ' ').trim();
        })
        .filter(Boolean)
    : [];
  if (!needles.length || window.__demoTextHiderInstalled) return;
  window.__demoTextHiderInstalled = true;

  function normalize(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function removeMatches() {
    if (!document.body) return;
    var all = Array.prototype.slice.call(document.body.querySelectorAll('*'));
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (!el || !el.parentElement || el === document.body || el === document.documentElement) continue;
      if (needles.indexOf(normalize(el.textContent)) !== -1) {
        el.remove();
      }
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', removeMatches);
  removeMatches();
  new MutationObserver(removeMatches).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}

/**
 * Bring an element into view, then glide the (visible) cursor to its centre and dwell briefly,
 * so the hover reads clearly on camera. Returns the on-screen centre after scrolling.
 */
async function hoverTarget(page, handle) {
  const vp = page.viewport() || DEFAULT_VIEWPORT;

  // Only scroll when the element isn't already comfortably in view. This is what kills the
  // "teleport to another section" glitch: a sticky-header button (or anything already on screen)
  // needs no scroll, so the page stays exactly where the previous scroll left it.
  let box = await handle.boundingBox();
  const inView = box && box.y >= 0 && box.y + box.height <= vp.height;
  if (!inView) {
    await smoothScrollToElement(page, handle); // gentle glide, never an instant jump
    await sleep(200);
    box = await handle.boundingBox();
  }
  if (!box) return { x: null, y: null };

  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);

  await glideMouse(page, x, y, 650); // human-paced drag from the cursor's rest spot to the target
  await sleep(180); // hover dwell so the element clearly highlights
  return { x, y };
}

/**
 * Gently scroll an off-screen element to the vertical centre of the viewport, reusing the smooth
 * in-page scroll so the motion is captured as a glide rather than a hard jump.
 */
async function smoothScrollToElement(page, handle, durationMs = 700) {
  const vp = page.viewport() || DEFAULT_VIEWPORT;
  const box = await handle.boundingBox();
  if (!box) return;
  const dy = Math.round(box.y + box.height / 2 - vp.height / 2);
  if (Math.abs(dy) < 8) return;
  await smoothScroll(page, dy, durationMs, false);
}

async function fitTargetForShot(page, handle, durationMs = 850) {
  const vp = page.viewport() || DEFAULT_VIEWPORT;
  let box = await handle.boundingBox();
  if (!box) return { x: null, y: null };

  const topBand = Math.round(vp.height * 0.16);
  const bottomBand = Math.round(vp.height * 0.88);
  const desiredCenter = (topBand + bottomBand) / 2;
  let dy = 0;

  if (box.height >= vp.height * 0.68) {
    dy = Math.round(box.y - topBand);
  } else if (box.y < topBand || box.y + box.height > bottomBand) {
    dy = Math.round(box.y + box.height / 2 - desiredCenter);
  }

  if (Math.abs(dy) > 8) {
    await smoothScroll(page, dy, durationMs, false);
    await sleep(180);
    box = await handle.boundingBox();
  }
  if (!box) return { x: null, y: null };

  const insetX = Math.max(34, Math.min(76, box.width * 0.08));
  const insetY = Math.max(34, Math.min(78, box.height * 0.14));
  const topY = box.y + insetY;
  const bottomY = box.y + box.height - insetY;
  const currentY = mouse.y == null ? topY : mouse.y;
  const y = Math.abs(topY - currentY) <= Math.abs(bottomY - currentY) ? topY : bottomY;
  const x = box.x + box.width - insetX;

  const target = {
    x: Math.round(clamp(x, 28, vp.width - 52)),
    y: Math.round(clamp(y, 28, vp.height - 52)),
  };
  await glideMouse(page, target.x, target.y, 750);
  return target;
}

/**
 * Keep generic page-tour scrolls out of footers. Plans can still request "scroll down a lot";
 * the recorder clamps that to the last meaningful content section before footer/contentinfo.
 */
async function clampTourScrollDelta(page, requestedDeltaY, allowFooter = false) {
  if (allowFooter || requestedDeltaY <= 0) return requestedDeltaY;

  const result = await page.evaluate((requested) => {
    const scrollY = window.scrollY || document.documentElement.scrollTop || 0;
    const viewportH = window.innerHeight || document.documentElement.clientHeight || 800;
    const doc = document.documentElement;
    const body = document.body;
    const scrollHeight = Math.max(
      doc ? doc.scrollHeight : 0,
      body ? body.scrollHeight : 0,
      doc ? doc.offsetHeight : 0,
      body ? body.offsetHeight : 0,
    );

    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return (
        rect.width > 80 &&
        rect.height > 40 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || 1) > 0.05
      );
    };

    const signature = (el) =>
      `${el.tagName || ''} ${el.id || ''} ${el.className || ''} ${el.getAttribute('role') || ''} ${
        el.getAttribute('aria-label') || ''
      }`.toLowerCase();

    const documentTop = (el) => el.getBoundingClientRect().top + scrollY;

    let footerTop = Infinity;
    for (const el of Array.from(document.querySelectorAll('footer,[role="contentinfo"],body *'))) {
      if (!isVisible(el)) continue;
      const sig = signature(el);
      const isFooter =
        el.tagName.toLowerCase() === 'footer' ||
        el.getAttribute('role') === 'contentinfo' ||
        /\b(footer|site-footer|page-footer|copyright)\b/.test(sig);
      if (!isFooter) continue;
      const top = documentTop(el);
      if (top > viewportH * 0.35 && top < footerTop) footerTop = top;
    }

    const hasFooter = Number.isFinite(footerTop);
    const footerBoundary = hasFooter ? footerTop : scrollHeight;
    let lastSectionBottom = 0;
    const sectionSelectors = [
      'main > section',
      'main > article',
      'body > section',
      'section',
      'article',
      '[data-section]',
      '[data-testid*="section" i]',
      '[class*="section" i]',
      '[id*="section" i]',
    ].join(',');

    for (const el of Array.from(document.querySelectorAll(sectionSelectors))) {
      if (!isVisible(el)) continue;
      const rect = el.getBoundingClientRect();
      const top = rect.top + scrollY;
      const bottom = rect.bottom + scrollY;
      if (bottom <= top || top >= footerBoundary - 12) continue;
      if (rect.height < Math.min(140, viewportH * 0.18)) continue;
      if (rect.width < Math.min(360, window.innerWidth * 0.35)) continue;
      lastSectionBottom = Math.max(lastSectionBottom, Math.min(bottom, footerBoundary));
    }

    const contentBottom = lastSectionBottom > 0 ? Math.min(footerBoundary, lastSectionBottom) : footerBoundary;
    const normalMaxY = Math.max(0, scrollHeight - viewportH);
    const tourMaxY = Math.max(0, Math.min(normalMaxY, Math.round(contentBottom - viewportH)));
    const requestedY = Math.min(normalMaxY, scrollY + requested);
    const targetY = Math.min(requestedY, tourMaxY);

    return {
      deltaY: Math.round(Math.max(0, targetY - scrollY)),
      clamped: targetY < requestedY - 2,
      requestedY: Math.round(requestedY),
      targetY: Math.round(targetY),
      footerBoundary: hasFooter ? Math.round(footerBoundary) : null,
    };
  }, requestedDeltaY);

  if (result && result.clamped) {
    console.log(
      `  ↳ scroll clamped before footer (${Math.round(requestedDeltaY)}px requested, ${result.deltaY}px used)`,
    );
  }
  return result && Number.isFinite(result.deltaY) ? result.deltaY : requestedDeltaY;
}

/**
 * Animate a page scroll in-page with requestAnimationFrame so the screencast captures a smooth
 * 60fps glide of exact `durationMs`. `linear: true` holds a constant velocity (consistent pace
 * for a scroll-tour); otherwise easeInOutCubic gives a gentle accelerate/decelerate.
 */
async function smoothScroll(page, deltaY, durationMs, linear) {
  await page.evaluate(
    (dy, dur, lin) =>
      new Promise((resolve) => {
        const startY = window.scrollY;
        const t0 = performance.now();
        const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
        const frame = (now) => {
          const t = Math.min(1, (now - t0) / dur);
          window.scrollTo(0, startY + dy * (lin ? t : easeInOut(t)));
          if (t < 1) requestAnimationFrame(frame);
          else resolve();
        };
        requestAnimationFrame(frame);
      }),
    deltaY,
    durationMs,
    !!linear,
  );
}

// ---- Screencast capture ---------------------------------------------------
/**
 * Starts a CDP screencast and collects frames in memory with their arrival offset (ms).
 * Returns { stop } — call stop() to end the screencast and return the captured frames.
 */
async function startScreencast(page, viewport, t0Ref, options = {}) {
  const cdp = await page.createCDPSession();
  const frames = [];
  const quality = Number.isFinite(options.quality)
    ? Math.max(1, Math.min(100, Math.round(options.quality)))
    : DEFAULT_SCREENCAST_QUALITY;

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
    quality,
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
        // Screencast frames can come back with an odd height (e.g. 1280x713); libx264 + yuv420p
        // require even dimensions, so round both down to the nearest even number.
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
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
  let recorded = false; // a step may push its own moment(s) (e.g. scroll waypoints)

  switch (type) {
    case 'navigate': {
      await page.goto(target, { waitUntil: step.waitUntil || 'networkidle2', timeout: 45000 });
      // Fresh document re-injects the cursor off-screen; re-seat it where it last was so it stays
      // visible on the new page instead of vanishing.
      if (mouse.x != null && mouse.y != null) await cursorPlace(page, mouse.x, mouse.y);
      break;
    }
    case 'click': {
      const handle = await waitForSelectorRetry(page, target);
      if (!handle) throw new Error(`Selector not found for click: ${target}`);
      ({ x, y } = await hoverTarget(page, handle)); // glide cursor over it and dwell
      await handle.click();
      break;
    }
    case 'type': {
      const handle = await waitForSelectorRetry(page, target);
      if (!handle) throw new Error(`Selector not found for type: ${target}`);
      ({ x, y } = await hoverTarget(page, handle));
      await handle.click();
      await handle.type(String(text ?? ''), { delay: 60 }); // char-by-char, human-like
      break;
    }
    case 'capture': {
      // Read a value rendered at runtime (e.g. a generated access code) and stash it under
      // step.as so a later step can reference it with {{as}}.
      if (!step.as) throw new Error('capture step requires an "as" field to name the value.');
      const handle = await waitForSelectorRetry(page, target);
      if (!handle) throw new Error(`Selector not found for capture: ${target}`);
      ({ x, y } = await hoverTarget(page, handle));
      const value = String(
        await page.evaluate((el) => (el.value ?? el.textContent ?? '').trim(), handle),
      );
      vars[step.as] = value;
      console.log(`  ⧉ captured ${step.as} = ${JSON.stringify(value)}`);
      break;
    }
    case 'focus': {
      const handle = await waitForSelectorRetry(page, target, {
        timeout: Number(step.timeoutMs || 12000),
        retries: Number.isFinite(step.retries) ? step.retries : 4,
      });
      if (!handle) throw new Error(`Selector not found for focus: ${target}`);
      const focusStart = Date.now() - t0Ref.t;
      ({ x, y } = await fitTargetForShot(page, handle, Number(step.fitMs || 850)));
      await sleep(Number(step.ms ?? 1200));
      const action = step.caption || step.why || target || type;
      const startMoment = {
        time: focusStart,
        action,
        type,
        x,
        y,
      };
      const endMoment = {
        time: Date.now() - t0Ref.t,
        action,
        type,
        x,
        y,
      };
      if (Number.isFinite(step.speed)) {
        startMoment.speed = step.speed;
        endMoment.speed = step.speed;
      }
      moments.push(startMoment, endMoment);
      recorded = true;
      break;
    }
    case 'scroll': {
      const requestedDy = Number(step.deltaY ?? 600);
      const dy = await clampTourScrollDelta(page, requestedDy, step.allowFooter === true);
      const baseDur = Number(step.ms ?? 1600); // scroll duration; `linear: true` keeps a constant pace
      const dur =
        Math.abs(requestedDy) > 1 && Math.abs(dy) < Math.abs(requestedDy)
          ? Math.max(500, Math.round(baseDur * (Math.abs(dy) / Math.abs(requestedDy))))
          : baseDur;
      const rest = await cursorRestForScroll(page, dy, dur);
      const startT = Date.now() - t0Ref.t;
      if (Math.abs(dy) > 1) {
        await smoothScroll(page, dy, dur, step.linear);
      } else {
        await sleep(220);
      }
      const endT = Date.now() - t0Ref.t;
      // Emit a moment every ~1.2s across the scroll. Without these, a long scroll looks to trim.js
      // like a big gap between actions (dead air) and gets cut — these keep it as one clip.
      if (Math.abs(dy) > 1) {
        const waypoints = Math.max(1, Math.ceil((endT - startT) / 1200));
        for (let w = 1; w <= waypoints; w++) {
          moments.push({
            time: Math.round(startT + ((endT - startT) * w) / waypoints),
            action: step.caption || step.why || 'scroll',
            type: 'scroll',
            x: rest.x,
            y: rest.y,
          });
        }
      }
      recorded = true;
      break;
    }
    case 'wait': {
      ({ x, y } = await cursorRestForContext(page, 650));
      await sleep(Number(step.ms ?? 1000));
      break;
    }
    default:
      throw new Error(`Unknown step type: ${type}`);
  }

  // `silent` steps (e.g. the initial navigate + hydration wait) record no moment, so trim.js
  // starts the clip at the first real action and the page-load/banner footage is cut off the front.
  if (!recorded && !step.silent) {
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
  }
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
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-features=CalculateNativeWinOcclusion',
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

    // Draw a visible cursor and apply capture-only page cleanup on every future navigation, and
    // on the current page too (in case we're already on a URL, e.g. connect mode).
    const hiddenText = Array.isArray(plan.hideText) ? plan.hideText : [];
    await page.evaluateOnNewDocument(installTextHider, hiddenText);
    await page.evaluateOnNewDocument(installCursor);
    try {
      await page.evaluate(installTextHider, hiddenText);
      await page.evaluate(installCursor);
    } catch (_e) {
      /* about:blank or not ready yet — evaluateOnNewDocument covers the real pages */
    }

    console.log(`• Starting screencast (JPEG q${rec.screencastQuality})…`);
    screencast = await startScreencast(page, viewport, t0Ref, { quality: rec.screencastQuality });

    // Seat the visible cursor at a natural resting spot (lower-centre) so it's on screen from the
    // first frame — it stays put while the page scrolls, then glides to targets on interaction.
    await cursorPlace(page, Math.round(viewport.width * 0.5), Math.round(viewport.height * 0.68));

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
      if (rec.stepPauseMs !== null) await sleep(rec.stepPauseMs);
      else await humanPause();
    }

    // Let the final state settle on screen before we cut. CDP screencast delivery can lag during
    // long scrolls, so final focus shots need real tail room for the encoded video to catch up.
    const finalSettleMs = Number(plan.meta && plan.meta.finalSettleMs);
    await sleep(Number.isFinite(finalSettleMs) ? Math.max(0, finalSettleMs) : 800);
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
  fs.copyFileSync(RAW_MP4, PUBLIC_MP4);

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
