import type { ElementHandle, Page } from 'puppeteer-core';
import type { Viewport } from '@wdv/schema';
import { DEFAULT_VIEWPORT } from './types';

/**
 * Human-motion layer: an injected visible cursor driven with eased glides, smooth in-page
 * scrolling, footer clamping and context-aware rest spots. Ported 1:1 from scripts/record.js —
 * the feel of these constants is the product; don't tune them casually.
 *
 * The old module-global `mouse` position became per-instance state so captures are isolated.
 */

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const humanPause = () => sleep(300 + Math.floor(Math.random() * 500)); // 300–800ms
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export class CursorController {
  /** Where the visible cursor currently sits, tracked in Node so a glide always starts from the
   *  cursor's real position (never a teleport from 0,0). */
  x: number | null = null;
  y: number | null = null;

  constructor(private readonly page: Page) {}

  private viewport(): Viewport {
    return (this.page.viewport() as Viewport | null) || DEFAULT_VIEWPORT;
  }

  private async syncVisibleCursor(x: number, y: number, instant = false): Promise<void> {
    try {
      await this.page.evaluate(
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
          const move = function (mx: number, my: number) {
            c!.style.left = mx + 'px';
            c!.style.top = my + 'px';
          };
          const w = window as any;
          w.__demoCursor = w.__demoCursor || {};
          w.__demoCursor.move = move;
          w.__demoCursor.place = function (mx: number, my: number) {
            const prev = c!.style.transition;
            c!.style.transition = 'none';
            move(mx, my);
            void c!.offsetWidth;
            c!.style.transition = prev || 'left .07s linear,top .07s linear';
          };
          if (jump) w.__demoCursor.place(px, py);
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
   * easeInOutQuad accelerates out of the start and eases into the target like a real hand.
   */
  async glide(toX: number, toY: number, durationMs = 1000): Promise<void> {
    const fromX = this.x == null ? toX : this.x;
    const fromY = this.y == null ? toY : this.y;
    const dist = Math.hypot(toX - fromX, toY - fromY);
    const steps = Math.max(24, Math.min(90, Math.round(dist / 8)));
    const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
    const perStep = durationMs / steps;
    for (let i = 1; i <= steps; i++) {
      const t = ease(i / steps);
      const x = Math.round(fromX + (toX - fromX) * t);
      const y = Math.round(fromY + (toY - fromY) * t);
      await this.page.mouse.move(x, y);
      await this.syncVisibleCursor(x, y);
      await sleep(perStep);
    }
    this.x = toX;
    this.y = toY;
  }

  /** Instantly place the visible cursor with no glide (start of recording / after navigation). */
  async place(x: number, y: number): Promise<void> {
    await this.syncVisibleCursor(x, y, true);
    await this.page.mouse.move(x, y); // keep puppeteer's internal pointer in sync
    this.x = x;
    this.y = y;
  }

  /**
   * During scroll tours, keep the cursor out of the reading path. Downward scrolls progressively
   * bias the cursor rightward; upward scrolls relax it slightly left so it still feels hand-driven.
   */
  async restForScroll(deltaY: number, durationMs = 500): Promise<{ x: number; y: number }> {
    const vp = this.viewport();
    const marginX = Math.round(vp.width * 0.07);
    const direction = deltaY >= 0 ? 1 : -1;
    const targetX =
      this.x == null
        ? Math.round(vp.width * 0.68)
        : Math.round(this.x + direction * (deltaY >= 0 ? vp.width * 0.08 : vp.width * 0.04));
    const x = clamp(targetX, Math.round(vp.width * 0.58), vp.width - marginX);
    const targetY = deltaY >= 0 ? Math.round(vp.height * 0.64) : Math.round(vp.height * 0.36);
    const y = clamp(
      this.y == null ? targetY : Math.round(this.y * 0.65 + targetY * 0.35),
      Math.round(vp.height * 0.18),
      Math.round(vp.height * 0.82),
    );

    await this.glide(x, y, clamp(Math.round(durationMs * 0.18), 340, 720));
    return { x, y };
  }

  /**
   * Find a visible form/card/dialog-like region and return a natural cursor rest point near one of
   * its right corners. Intentionally heuristic so plans stay portable across unrelated sites.
   */
  private async findContextRestSpot(): Promise<{ x: number; y: number } | null> {
    const vp = this.viewport();
    return this.page.evaluate(
      ({ vw, vh, currentY }) => {
        const visibleRect = (el: Element) => {
          const rect = el.getBoundingClientRect();
          if (rect.width < 180 || rect.height < 90) return null;
          const left = Math.max(0, rect.left);
          const top = Math.max(0, rect.top);
          const right = Math.min(vw, rect.right);
          const bottom = Math.min(vh, rect.bottom);
          const width = right - left;
          const height = bottom - top;
          if (width < 160 || height < 80) return null;
          return { left, top, right, bottom, width, height, area: width * height };
        };

        const isVisible = (el: Element) => {
          const style = window.getComputedStyle(el);
          return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0.05;
        };

        const textFor = (el: Element) =>
          `${el.tagName || ''} ${el.id || ''} ${el.className || ''} ${el.getAttribute('role') || ''} ${
            el.getAttribute('aria-label') || ''
          }`.toLowerCase();

        const candidates = Array.from(
          document.querySelectorAll('form,[role="form"],[role="dialog"],fieldset,section,article,main,aside,div'),
        );
        let best: { rect: NonNullable<ReturnType<typeof visibleRect>>; score: number; label: string } | null = null;

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
          if (!best || score > best.score) best = { rect, score, label };
        }

        if (!best) return null;

        const r = best.rect;
        const insetX = Math.max(34, Math.min(76, r.width * 0.08));
        const topY = r.top + Math.max(34, Math.min(78, r.height * 0.14));
        const bottomY = r.bottom - Math.max(34, Math.min(78, r.height * 0.14));
        const current = Number.isFinite(currentY as number) ? (currentY as number) : vh * 0.55;
        const y = Math.abs(topY - current) <= Math.abs(bottomY - current) ? topY : bottomY;

        return {
          x: Math.round(Math.min(vw - 52, Math.max(28, r.right - insetX))),
          y: Math.round(Math.min(vh - 52, Math.max(28, y))),
        };
      },
      { vw: vp.width, vh: vp.height, currentY: this.y },
    );
  }

  async restForContext(durationMs = 700): Promise<{ x: number | null; y: number | null }> {
    let spot: { x: number; y: number } | null = null;
    try {
      spot = await this.findContextRestSpot();
    } catch (_e) {
      return { x: this.x, y: this.y };
    }
    if (!spot) return { x: this.x, y: this.y };
    const dist = this.x == null || this.y == null ? Infinity : Math.hypot(spot.x - this.x, spot.y - this.y);
    if (dist > 18) {
      await this.glide(spot.x, spot.y, durationMs);
    }
    return { x: spot.x, y: spot.y };
  }

  /**
   * Bring an element into view, then glide the cursor to its centre and dwell briefly, so the
   * hover reads clearly on camera. Returns the on-screen centre after scrolling.
   */
  async hoverTarget(handle: ElementHandle): Promise<{ x: number | null; y: number | null }> {
    const vp = this.viewport();

    // Only scroll when the element isn't already comfortably in view. This is what kills the
    // "teleport to another section" glitch: a sticky-header button (or anything already on screen)
    // needs no scroll, so the page stays exactly where the previous scroll left it.
    let box = await handle.boundingBox();
    const inView = box && box.y >= 0 && box.y + box.height <= vp.height;
    if (!inView) {
      await this.smoothScrollToElement(handle); // gentle glide, never an instant jump
      await sleep(200);
      box = await handle.boundingBox();
    }
    if (!box) return { x: null, y: null };

    const x = Math.round(box.x + box.width / 2);
    const y = Math.round(box.y + box.height / 2);

    await this.glide(x, y, 650); // human-paced drag from the cursor's rest spot to the target
    await sleep(180); // hover dwell so the element clearly highlights
    return { x, y };
  }

  /** Gently scroll an off-screen element to the vertical centre of the viewport. */
  async smoothScrollToElement(handle: ElementHandle, durationMs = 700): Promise<void> {
    const vp = this.viewport();
    const box = await handle.boundingBox();
    if (!box) return;
    const dy = Math.round(box.y + box.height / 2 - vp.height / 2);
    if (Math.abs(dy) < 8) return;
    await smoothScroll(this.page, dy, durationMs, false);
  }

  /** Frame a large target for a held shot and rest the cursor near one of its right corners. */
  async fitTargetForShot(handle: ElementHandle, durationMs = 850): Promise<{ x: number | null; y: number | null }> {
    const vp = this.viewport();
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
      await smoothScroll(this.page, dy, durationMs, false);
      await sleep(180);
      box = await handle.boundingBox();
    }
    if (!box) return { x: null, y: null };

    const insetX = Math.max(34, Math.min(76, box.width * 0.08));
    const insetY = Math.max(34, Math.min(78, box.height * 0.14));
    const topY = box.y + insetY;
    const bottomY = box.y + box.height - insetY;
    const currentY = this.y == null ? topY : this.y;
    const y = Math.abs(topY - currentY) <= Math.abs(bottomY - currentY) ? topY : bottomY;
    const x = box.x + box.width - insetX;

    const target = {
      x: Math.round(clamp(x, 28, vp.width - 52)),
      y: Math.round(clamp(y, 28, vp.height - 52)),
    };
    await this.glide(target.x, target.y, 750);
    return target;
  }
}

/**
 * Animate a page scroll in-page with requestAnimationFrame so the screencast captures a smooth
 * 60fps glide of exact `durationMs`. `linear` holds a constant velocity (consistent pace for a
 * scroll-tour); otherwise easeInOutCubic gives a gentle accelerate/decelerate.
 */
export async function smoothScroll(page: Page, deltaY: number, durationMs: number, linear?: boolean): Promise<void> {
  await page.evaluate(
    (dy, dur, lin) =>
      new Promise<void>((resolve) => {
        const startY = window.scrollY;
        const t0 = performance.now();
        const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
        const frame = (now: number) => {
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

/**
 * Keep generic page-tour scrolls out of footers. Plans can still request "scroll down a lot";
 * the recorder clamps that to the last meaningful content section before footer/contentinfo.
 */
export async function clampTourScrollDelta(
  page: Page,
  requestedDeltaY: number,
  allowFooter = false,
  log: (line: string) => void = () => {},
): Promise<number> {
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

    const isVisible = (el: Element) => {
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

    const signature = (el: Element) =>
      `${el.tagName || ''} ${el.id || ''} ${el.className || ''} ${el.getAttribute('role') || ''} ${
        el.getAttribute('aria-label') || ''
      }`.toLowerCase();

    const documentTop = (el: Element) => el.getBoundingClientRect().top + scrollY;

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
    };
  }, requestedDeltaY);

  if (result && result.clamped) {
    log(`  ↳ scroll clamped before footer (${Math.round(requestedDeltaY)}px requested, ${result.deltaY}px used)`);
  }
  return result && Number.isFinite(result.deltaY) ? result.deltaY : requestedDeltaY;
}
