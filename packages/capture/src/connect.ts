import fs from 'node:fs';
import path from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import SteelModule from 'steel-sdk';
import type { BrowsePlan, Viewport } from '@wdv/schema';
import type { ResolvedRecording, StageContext } from './types';

const Steel: any = (SteelModule as any).default || SteelModule;

// Chrome DevTools Protocol calls (e.g. Runtime.callFunctionOn) default to a ~30s timeout,
// which a busy authenticated SPA can blow past. Bump it generously for every connection.
export const PROTOCOL_TIMEOUT = 180000;

// High JPEG quality at 1080p can starve CDP screencast delivery during long scrolls, producing
// uneven frame gaps that read as lag. 82 keeps UI text crisp while giving Chrome more room to
// return frames consistently.
export const DEFAULT_SCREENCAST_QUALITY = 82;

// CDP screencast is event-driven — Chrome only pushes a frame when it repaints, and throttles under
// load, so fast scrolls step and static holds stall. We floor the capture at the final render rate by
// force-grabbing a screenshot whenever the screencast falls behind; this gives long scrolls a real
// 60fps source instead of asking interpolation to invent most of the motion later.
export const DEFAULT_CAPTURE_FPS = 60;

const truthy = (v: unknown) => ['1', 'true', 'yes'].includes(String(v || '').toLowerCase());

/**
 * Resolve the recording mode from the plan's `recording` block, with environment variables as
 * optional overrides (handy for CI / one-off runs). Env vars win when present:
 * DEMO_CONNECT_URL implies connect, DEMO_LOCAL=1 implies local.
 */
export function resolveRecordingConfig(plan: BrowsePlan, env: NodeJS.ProcessEnv = process.env): ResolvedRecording {
  const r = plan.recording || {};
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
  const captureFpsRaw = env.DEMO_CAPTURE_FPS !== undefined ? env.DEMO_CAPTURE_FPS : r.captureFps;
  const parsedCaptureFps = captureFpsRaw === undefined || captureFpsRaw === null ? null : Number(captureFpsRaw);
  return {
    mode,
    connectUrl,
    headful: env.DEMO_HEADFUL !== undefined ? truthy(env.DEMO_HEADFUL) : !!r.headful,
    userDataDir: env.DEMO_USER_DATA_DIR || r.userDataDir || undefined,
    chromePath: env.CHROME_PATH || r.chromePath || undefined,
    stepPauseMs: Number.isFinite(parsedStepPause as number) ? Math.max(0, parsedStepPause as number) : null,
    screencastQuality: Number.isFinite(parsedQuality as number)
      ? Math.max(1, Math.min(100, Math.round(parsedQuality as number)))
      : DEFAULT_SCREENCAST_QUALITY,
    captureFps: Number.isFinite(parsedCaptureFps as number)
      ? Math.max(10, Math.min(60, Math.round(parsedCaptureFps as number)))
      : DEFAULT_CAPTURE_FPS,
  };
}

/** Find the Chrome Headless Shell that Remotion already downloaded for rendering. */
function findRemotionChrome(searchRoot: string): string | null {
  const base = path.join(searchRoot, 'node_modules', '.remotion', 'chrome-headless-shell');
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
 * chromePath (recording.chromePath / CHROME_PATH), then a real installed browser (best
 * fidelity), then Remotion's bundled headless shell so no extra download is needed.
 */
export function resolveLocalChrome(chromePath: string | undefined, searchRoot: string): string {
  const candidates = [
    chromePath,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    findRemotionChrome(searchRoot),
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    'No local Chrome/Chromium found. Install Google Chrome or set recording.chromePath (or CHROME_PATH).',
  );
}

/**
 * Build the CDP/WebSocket endpoint puppeteer-core connects to. Steel's connect endpoint
 * authenticates via an apiKey query param, so append it (and the sessionId) if missing.
 */
function buildWsEndpoint(session: { websocketUrl: string; id: string }, apiKey: string): string {
  const url = new URL(session.websocketUrl);
  if (!url.searchParams.has('apiKey')) url.searchParams.set('apiKey', apiKey);
  if (!url.searchParams.has('sessionId')) url.searchParams.set('sessionId', session.id);
  return url.toString();
}

export interface BrowserSession {
  browser: Browser;
  page: Page;
  /** Disconnect-or-close per mode + release any Steel session. Always safe to call once. */
  teardown: () => Promise<void>;
}

/**
 * Open a browser per the resolved recording mode:
 *   cloud    create a Steel Dev cloud session (needs STEEL_API_KEY)
 *   local    launch a fresh local Chrome (localhost / dev servers)
 *   connect  attach to an already-running, already-authenticated Chrome — we connect rather
 *            than launch, so teardown disconnects instead of closing it.
 */
export async function openBrowser(
  rec: ResolvedRecording,
  viewport: Viewport,
  ctx: StageContext,
  chromeSearchRoot: string = process.cwd(),
): Promise<BrowserSession> {
  let client: any = null;
  let session: any = null;
  let browser: Browser;
  let page: Page;

  if (rec.mode === 'connect') {
    ctx.log(`• Connecting to existing Chrome at ${rec.connectUrl}…`);
    browser = await puppeteer.connect({
      browserURL: rec.connectUrl!,
      protocolTimeout: PROTOCOL_TIMEOUT,
      defaultViewport: viewport,
    });
    const pages = await browser.pages();
    page = pages.find((p) => /^https?:/.test(p.url())) || pages[0] || (await browser.newPage());
    await page.bringToFront();
  } else if (rec.mode === 'local') {
    const executablePath = resolveLocalChrome(rec.chromePath, chromeSearchRoot);
    // Optional: reuse a pre-authenticated Chrome profile so the recording starts logged in.
    // Must be an unlocked copy — Chrome locks a profile while another instance has it open.
    const userDataDir = rec.userDataDir;
    ctx.log(`• Launching local Chrome (${rec.headful ? 'headful' : 'headless'})`);
    ctx.log(`  ${executablePath}`);
    if (userDataDir) ctx.log(`  profile: ${userDataDir}`);
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
      throw new Error('STEEL_API_KEY is not set. Add it to .env.local, or set recording.mode to "local"/"connect".');
    }
    client = new Steel(); // reads STEEL_API_KEY from env automatically
    ctx.log('• Creating Steel session…');
    session = await client.sessions.create({
      dimensions: { width: viewport.width, height: viewport.height },
      timeout: 600000,
    });
    ctx.log(`  session ${session.id} — viewer: ${session.sessionViewerUrl}`);

    const wsEndpoint = buildWsEndpoint(session, apiKey);
    browser = await puppeteer.connect({
      browserWSEndpoint: wsEndpoint,
      defaultViewport: viewport,
      protocolTimeout: PROTOCOL_TIMEOUT,
    });
    const pages = await browser.pages();
    page = pages[0] || (await browser.newPage());
  }

  // esbuild-based runners (tsx) wrap transpiled functions in a __name() helper. puppeteer
  // serializes evaluate() callbacks without that helper, so define a no-op shim in every
  // document or every in-page evaluate throws "__name is not defined".
  const NAME_SHIM = 'window.__name = window.__name || ((fn) => fn);';
  await page.evaluateOnNewDocument(NAME_SHIM);
  try {
    await page.evaluate(NAME_SHIM);
  } catch (_e) {
    /* about:blank not ready — evaluateOnNewDocument covers real pages */
  }

  let torndown = false;
  const teardown = async () => {
    if (torndown) return;
    torndown = true;
    try {
      // A browser we launched must be closed (kills the process); one we connected to
      // (cloud session or connect-mode Chrome) is only disconnected so it keeps running.
      if (rec.mode === 'local') await browser.close();
      else await browser.disconnect();
    } catch (_e) {
      /* ignore */
    }
    if (session && client) {
      try {
        await client.sessions.release(session.id);
        ctx.log(`• Released session ${session.id}.`);
      } catch (_e) {
        /* ignore */
      }
    }
  };

  return { browser, page, teardown };
}
