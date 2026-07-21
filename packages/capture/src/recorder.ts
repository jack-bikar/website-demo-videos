import fs from 'node:fs';
import path from 'node:path';
import type { ElementHandle, Page } from 'puppeteer-core';
import type { Moment, Step } from '@wdv/schema';
import { openBrowser } from './connect';
import { installCursor, installTextHider } from './inject';
import { clampTourScrollDelta, CursorController, humanPause, sleep, smoothScroll } from './motion';
import { encodeFrames, startScreencast, type EpochRef, type Screencast } from './screencast';
import { DEFAULT_VIEWPORT, type CaptureRequest, type CaptureResult, type StageContext } from './types';

/**
 * Substitute {{name}} placeholders with values captured earlier in the run (see the
 * `capture` step type). Unknown names are left intact so a typo is visible in the output
 * rather than silently blanked.
 */
const TEMPLATE_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;
function applyVars(value: string | undefined, vars: Record<string, string>): string | undefined {
  if (typeof value !== 'string') return value;
  return value.replace(TEMPLATE_RE, (whole, name) => (name in vars ? String(vars[name]) : whole));
}

const PACE_SPEED: Record<string, number> = {
  'very-slow': 0.75,
  slow: 1,
  normal: 1.3,
  quick: 2,
};

function stepPlaybackSpeed(step: Step): number | undefined {
  if (Number.isFinite(step.speed)) return step.speed;
  return step.pace ? PACE_SPEED[step.pace] : undefined;
}

/**
 * Wait for a selector, retrying a few times before giving up. A single waitForSelector can
 * lose a race on a busy SPA (element briefly detaches/re-renders); a short retry loop makes
 * plans far more robust. Prefer stable hooks like [data-testid="…"] in plans.
 */
async function waitForSelectorRetry(
  page: Page,
  selector: string,
  { timeout = 8000, retries = 2 }: { timeout?: number; retries?: number } = {},
): Promise<ElementHandle | null> {
  let lastErr: unknown = null;
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

async function runStep(
  page: Page,
  cursor: CursorController,
  step: Step,
  t0Ref: EpochRef,
  moments: Moment[],
  index: number,
  vars: Record<string, string>,
  ctx: StageContext,
): Promise<void> {
  const type = step.type;
  const target = applyVars(step.target, vars);
  const text = applyVars(step.text, vars);
  let x: number | null = null;
  let y: number | null = null;
  let recorded = false; // a step may push its own moment(s) (e.g. scroll waypoints)

  switch (type) {
    case 'navigate': {
      await page.goto(target!, { waitUntil: step.waitUntil || 'networkidle2', timeout: 45000 });
      // Fresh document re-injects the cursor off-screen; re-seat it where it last was so it stays
      // visible on the new page instead of vanishing.
      if (cursor.x != null && cursor.y != null) await cursor.place(cursor.x, cursor.y);
      break;
    }
    case 'click': {
      const handle = await waitForSelectorRetry(page, target!);
      if (!handle) throw new Error(`Selector not found for click: ${target}`);
      ({ x, y } = await cursor.hoverTarget(handle)); // glide cursor over it and dwell
      await handle.click();
      break;
    }
    case 'type': {
      const handle = await waitForSelectorRetry(page, target!);
      if (!handle) throw new Error(`Selector not found for type: ${target}`);
      ({ x, y } = await cursor.hoverTarget(handle));
      await handle.click();
      await handle.type(String(text ?? ''), { delay: 60 }); // char-by-char, human-like
      break;
    }
    case 'capture': {
      // Read a value rendered at runtime (e.g. a generated access code) and stash it under
      // step.as so a later step can reference it with {{as}}.
      if (!step.as) throw new Error('capture step requires an "as" field to name the value.');
      const handle = await waitForSelectorRetry(page, target!);
      if (!handle) throw new Error(`Selector not found for capture: ${target}`);
      ({ x, y } = await cursor.hoverTarget(handle));
      const value = String(
        await page.evaluate((el: any) => (el.value ?? el.textContent ?? '').trim(), handle),
      );
      vars[step.as] = value;
      ctx.log(`  ⧉ captured ${step.as} = ${JSON.stringify(value)}`);
      break;
    }
    case 'focus': {
      const handle = await waitForSelectorRetry(page, target!, {
        timeout: Number(step.timeoutMs || 12000),
        retries: Number.isFinite(step.retries) ? step.retries : 4,
      });
      if (!handle) throw new Error(`Selector not found for focus: ${target}`);
      const focusStart = Date.now() - t0Ref.t;
      ({ x, y } = await cursor.fitTargetForShot(handle, Number(step.fitMs || 850)));
      await sleep(Number(step.ms ?? 1200));
      const action = step.caption || step.why || target || type;
      const startMoment: Moment = { time: focusStart, action, type, x: x ?? 0, y: y ?? 0 };
      const endMoment: Moment = { time: Date.now() - t0Ref.t, action, type, x: x ?? 0, y: y ?? 0 };
      const speed = stepPlaybackSpeed(step);
      if (Number.isFinite(speed)) {
        startMoment.speed = speed;
        endMoment.speed = speed;
      }
      moments.push(startMoment, endMoment);
      recorded = true;
      break;
    }
    case 'scroll': {
      const requestedDy = Number(step.deltaY ?? 600);
      const dy = await clampTourScrollDelta(page, requestedDy, step.allowFooter === true, ctx.log);
      const baseDur = Number(step.ms ?? 1600); // scroll duration; `linear: true` keeps a constant pace
      const dur =
        Math.abs(requestedDy) > 1 && Math.abs(dy) < Math.abs(requestedDy)
          ? Math.max(500, Math.round(baseDur * (Math.abs(dy) / Math.abs(requestedDy))))
          : baseDur;
      const rest = await cursor.restForScroll(dy, dur);
      const startT = Date.now() - t0Ref.t;
      const continuous = step.smoothness === 'continuous';
      if (Math.abs(dy) > 1) {
        await smoothScroll(page, dy, dur, step.linear ?? continuous);
      } else {
        await sleep(220);
      }
      const endT = Date.now() - t0Ref.t;
      // Emit a moment every ~1.2s across the scroll. Without these, a long scroll looks to the
      // trim stage like a big gap between actions (dead air) and gets cut — these keep it as one clip.
      if (Math.abs(dy) > 1) {
        const waypointIntervalMs = continuous ? 600 : 1200;
        const waypoints = Math.max(1, Math.ceil((endT - startT) / waypointIntervalMs));
        const speed = stepPlaybackSpeed(step);
        for (let w = 1; w <= waypoints; w++) {
          const moment: Moment = {
            time: Math.round(startT + ((endT - startT) * w) / waypoints),
            action: step.caption || step.why || 'scroll',
            type: 'scroll',
            x: rest.x,
            y: rest.y,
          };
          if (Number.isFinite(speed)) moment.speed = speed;
          moments.push(moment);
        }
      }
      recorded = true;
      break;
    }
    case 'wait': {
      ({ x, y } = await cursor.restForContext(650));
      await sleep(Number(step.ms ?? 1000));
      break;
    }
    default:
      throw new Error(`Unknown step type: ${type}`);
  }

  // `silent` steps record no moment. Leading silent setup runs before the screencast starts;
  // later silent steps still happen in the recording but do not create kept clip windows.
  if (!recorded && !step.silent) {
    const moment: Moment = {
      time: Date.now() - t0Ref.t,
      // `caption` is the authored, on-screen scene description; `why` is the debug note. Fall
      // back through caption → why → target → type so a lower-third always has something to show.
      action: step.caption || step.why || target || type,
      type,
      x: x ?? 0,
      y: y ?? 0,
    };
    const speed = stepPlaybackSpeed(step);
    if (Number.isFinite(speed)) moment.speed = speed;
    moments.push(moment);
  }
  ctx.log(`  ✓ step ${index + 1} (${type})${x != null ? ` @ ${x},${y}` : ''}`);
}

/**
 * Drive a browser through the plan with human-like timing and capture real video frames
 * over CDP. Writes raw.mp4 + moments.json into request.outDir.
 */
export async function record(request: CaptureRequest, ctx: StageContext): Promise<CaptureResult> {
  const { plan, recording: rec, outDir } = request;
  fs.mkdirSync(outDir, { recursive: true });

  const viewport = plan.viewport || DEFAULT_VIEWPORT;
  const rawVideoPath = path.join(outDir, 'raw.mp4');
  const momentsPath = path.join(outDir, 'moments.json');

  const moments: Moment[] = [];
  const vars: Record<string, string> = {}; // runtime values captured by `capture` steps
  const t0Ref: EpochRef = { t: Date.now() };

  let screencast: Screencast | undefined;
  const session = await openBrowser(rec, viewport, ctx, request.chromeSearchRoot);

  try {
    const { page } = session;
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

    const cursor = new CursorController(page);
    const runPlanStep = async (i: number): Promise<void> => {
      if (ctx.signal?.aborted) throw new Error('Capture canceled.');
      const step = plan.steps[i];
      try {
        await runStep(page, cursor, step, t0Ref, moments, i, vars, ctx);
      } catch (err) {
        ctx.warn(`  ⚠ step ${i + 1} (${step.type}) failed: ${(err as Error).message} — continuing.`);
        try {
          await page.screenshot({ path: path.join(outDir, `error-${i + 1}.png`) as `${string}.png` });
        } catch (_e) {
          /* ignore screenshot failures */
        }
      }
      ctx.onProgress?.({ value: (i + 1) / (plan.steps.length + 1), message: `Step ${i + 1}/${plan.steps.length}` });
      if (rec.stepPauseMs !== null) await sleep(rec.stepPauseMs);
      else await humanPause();
    };

    // Leading silent steps are setup, not footage. Running them before the screencast means
    // `preserveStart` can keep the authored opening hold without also keeping page-load dead time.
    let firstRecordedStep = 0;
    while (firstRecordedStep < plan.steps.length && plan.steps[firstRecordedStep].silent) {
      if (firstRecordedStep === 0) ctx.log('• Executing leading setup steps before recording…');
      await runPlanStep(firstRecordedStep);
      firstRecordedStep++;
    }

    ctx.log(`• Starting screencast (JPEG q${rec.screencastQuality}, ${rec.captureFps}fps floor)…`);
    screencast = await startScreencast(page, viewport, t0Ref, {
      quality: rec.screencastQuality,
      captureFps: rec.captureFps,
    });

    // Seat the visible cursor at a natural resting spot (lower-centre) so it's on screen from the
    // first frame — it stays put while the page scrolls, then glides to targets on interaction.
    await cursor.place(Math.round(viewport.width * 0.5), Math.round(viewport.height * 0.68));

    ctx.log(`• Executing ${plan.steps.length - firstRecordedStep} recorded steps…`);
    for (let i = firstRecordedStep; i < plan.steps.length; i++) {
      await runPlanStep(i);
    }

    // Let the final state settle on screen before we cut. CDP screencast delivery can lag during
    // long scrolls, so final focus shots need real tail room for the encoded video to catch up.
    const finalSettleMs = Number(plan.meta?.finalSettleMs);
    await sleep(Number.isFinite(finalSettleMs) ? Math.max(0, finalSettleMs) : 800);
  } finally {
    if (screencast) await screencast.stop();
    await session.teardown();
  }

  const frames = screencast ? screencast.frames : [];
  ctx.log(`• Captured ${frames.length} frames; encoding to ${rawVideoPath}…`);
  ctx.onProgress?.({ value: 0.95, message: 'Encoding frames' });
  encodeFrames(frames, rawVideoPath, { fps: rec.captureFps });

  fs.writeFileSync(momentsPath, JSON.stringify(moments, null, 2));
  const durationMs = moments.length
    ? moments[moments.length - 1].time
    : frames.length
      ? frames[frames.length - 1].t
      : 0;
  ctx.log(`✓ Recorded ${moments.length} moments over ~${(durationMs / 1000).toFixed(1)}s.`);

  return { rawVideoPath, momentsPath, moments, frameCount: frames.length, durationMs };
}
