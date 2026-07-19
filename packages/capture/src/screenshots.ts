import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { openBrowser } from './connect';
import { installTextHider } from './inject';
import { sleep, smoothScroll } from './motion';
import type { PageMeta, ScreenshotEntry, ScreenshotRequest, ScreenshotResult, StageContext } from './types';
import { DEFAULT_VIEWPORT_PRESETS } from './types';

/**
 * Screenshot capture for the Screenshot-Based mode: per viewport preset, settle lazy-loaded
 * content with a scroll pre-pass, then take a full-page shot, per-section shots, and any
 * explicitly requested element shots. Emits screenshots.json + page-meta.json manifests.
 */

/** Scroll to the bottom and back so lazy images/animations settle before shooting. */
async function lazyLoadPrePass(page: Page): Promise<void> {
  const scrollHeight = await page.evaluate(() =>
    Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
  );
  const viewportH = await page.evaluate(() => window.innerHeight);
  const distance = Math.max(0, scrollHeight - viewportH);
  if (distance > 0) {
    await smoothScroll(page, distance, Math.min(4000, Math.max(1200, distance)), true);
    await sleep(350);
    await smoothScroll(page, -distance, 600, true);
  }
  await sleep(400);
}

interface SectionInfo {
  scrollY: number;
  title: string;
}

/** Detect meaningful section boundaries (section/[id] anchors/h2 offsets) for section shots. */
async function detectSections(page: Page): Promise<SectionInfo[]> {
  return page.evaluate(() => {
    const viewportH = window.innerHeight;
    const scrollMax = Math.max(
      0,
      Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0) - viewportH,
    );
    const seen = new Set<number>();
    const sections: { scrollY: number; title: string }[] = [];

    const candidates = Array.from(document.querySelectorAll('main > section, body > section, section, article, h2'));
    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (rect.height < 120 && el.tagName !== 'H2') continue;
      if (rect.width < window.innerWidth * 0.4) continue;

      const top = Math.round(rect.top + window.scrollY);
      const scrollY = Math.min(scrollMax, Math.max(0, top - Math.round(viewportH * 0.08)));
      // De-dupe targets that land within half a viewport of one another.
      const bucket = Math.round(scrollY / (viewportH / 2));
      if (seen.has(bucket)) continue;
      seen.add(bucket);

      const heading = el.tagName === 'H2' ? el : el.querySelector('h1,h2,h3');
      const title = (heading?.textContent || el.getAttribute('aria-label') || el.id || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
      sections.push({ scrollY, title });
      if (sections.length >= 12) break;
    }
    return sections;
  });
}

/** Extract identity + brand colors used to build gradients and browser-frame chrome. */
async function extractPageMeta(page: Page, url: string): Promise<PageMeta> {
  return page.evaluate((pageUrl) => {
    const attr = (selector: string, name: string) => document.querySelector(selector)?.getAttribute(name) ?? null;

    const colorCounts = new Map<string, number>();
    const record = (value: string | null, weight: number) => {
      if (!value) return;
      const m = value.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
      if (!m) return;
      const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      // Skip near-white/near-black/greys — we want brand hues.
      if (max > 245 && min > 235) return;
      if (max < 25) return;
      if (max - min < 18) return;
      const key = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
      colorCounts.set(key, (colorCounts.get(key) ?? 0) + weight);
    };

    const sampled = document.querySelectorAll(
      'header, nav, button, a[href], h1, h2, [class*="hero" i], [class*="banner" i], [class*="cta" i]',
    );
    for (const el of Array.from(sampled).slice(0, 400)) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const weight = Math.max(1, Math.min(50, Math.round((rect.width * rect.height) / 5000)));
      record(style.backgroundColor, weight * 2);
      record(style.color, weight);
      record(style.borderColor, 1);
    }
    const brandColors = Array.from(colorCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([color]) => color);

    return {
      url: pageUrl,
      title: document.title || '',
      description: attr('meta[name="description"]', 'content') ?? attr('meta[property="og:description"]', 'content'),
      ogImage: attr('meta[property="og:image"]', 'content'),
      favicon: attr('link[rel="icon"]', 'href') ?? attr('link[rel="shortcut icon"]', 'href'),
      themeColor: attr('meta[name="theme-color"]', 'content'),
      brandColors,
    };
  }, url);
}

export async function screenshots(request: ScreenshotRequest, ctx: StageContext): Promise<ScreenshotResult> {
  const outDir = path.join(request.outDir, 'screenshots');
  fs.mkdirSync(outDir, { recursive: true });

  const presets = request.viewports?.length ? request.viewports : DEFAULT_VIEWPORT_PRESETS;
  const entries: ScreenshotEntry[] = [];
  let pageMeta: PageMeta | null = null;

  // Screenshot capture drives its own viewport per preset; open with the first one.
  const session = await openBrowser(request.recording, { width: presets[0].width, height: presets[0].height }, ctx, request.chromeSearchRoot);

  try {
    const { page } = session;
    if (request.hideText?.length) {
      await page.evaluateOnNewDocument(installTextHider, request.hideText);
    }

    for (const [presetIndex, preset] of presets.entries()) {
      ctx.log(`• Capturing ${preset.id} (${preset.width}×${preset.height}@${preset.deviceScaleFactor ?? 1}x)…`);
      await page.setViewport({
        width: preset.width,
        height: preset.height,
        deviceScaleFactor: preset.deviceScaleFactor ?? 1,
        isMobile: preset.isMobile ?? false,
      });
      await page.goto(request.url, { waitUntil: 'networkidle2', timeout: 45000 });
      await lazyLoadPrePass(page);

      if (!pageMeta) pageMeta = await extractPageMeta(page, request.url);

      // Full-page shot. captureBeyondViewport lets Chrome compose the whole page in one PNG;
      // pages beyond Chrome's ~16k px texture limit fall back to the viewport-sized shot.
      const fullFile = path.join(outDir, `${preset.id}-fullpage.png`);
      try {
        await page.screenshot({ path: fullFile as `${string}.png`, fullPage: true, captureBeyondViewport: true });
      } catch (err) {
        ctx.warn(`  ⚠ full-page shot failed (${(err as Error).message}) — capturing viewport instead.`);
        await page.screenshot({ path: fullFile as `${string}.png` });
      }
      const fullDims = await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      }));
      entries.push({
        id: `${preset.id}-fullpage`,
        kind: 'fullpage',
        viewport: preset.id,
        file: path.relative(request.outDir, fullFile),
        width: fullDims.width,
        height: fullDims.height,
        deviceScaleFactor: preset.deviceScaleFactor ?? 1,
      });

      // Section shots at detected boundaries.
      const sections = await detectSections(page);
      for (const [i, section] of sections.entries()) {
        await page.evaluate((y) => window.scrollTo(0, y), section.scrollY);
        await sleep(450); // let sticky headers/animations settle at the new position
        const file = path.join(outDir, `${preset.id}-section-${String(i + 1).padStart(2, '0')}.png`);
        await page.screenshot({ path: file as `${string}.png` });
        entries.push({
          id: `${preset.id}-section-${i + 1}`,
          kind: 'section',
          viewport: preset.id,
          file: path.relative(request.outDir, file),
          width: preset.width,
          height: preset.height,
          deviceScaleFactor: preset.deviceScaleFactor ?? 1,
          scrollY: section.scrollY,
          sectionTitle: section.title || undefined,
        });
      }
      await page.evaluate(() => window.scrollTo(0, 0));

      // Explicit element shots (hero, pricing card, CTA…).
      for (const [i, selector] of (request.elementSelectors ?? []).entries()) {
        try {
          const handle = await page.waitForSelector(selector, { timeout: 5000 });
          if (!handle) continue;
          await handle.scrollIntoView();
          await sleep(300);
          const file = path.join(outDir, `${preset.id}-element-${String(i + 1).padStart(2, '0')}.png`);
          await handle.screenshot({ path: file as `${string}.png` });
          const box = await handle.boundingBox();
          entries.push({
            id: `${preset.id}-element-${i + 1}`,
            kind: 'element',
            viewport: preset.id,
            file: path.relative(request.outDir, file),
            width: Math.round(box?.width ?? 0),
            height: Math.round(box?.height ?? 0),
            deviceScaleFactor: preset.deviceScaleFactor ?? 1,
            selector,
          });
        } catch (err) {
          ctx.warn(`  ⚠ element shot failed for ${selector}: ${(err as Error).message}`);
        }
      }

      ctx.onProgress?.({ value: (presetIndex + 1) / presets.length, message: `Captured ${preset.id}` });
    }
  } finally {
    await session.teardown();
  }

  const manifestPath = path.join(request.outDir, 'screenshots.json');
  fs.writeFileSync(manifestPath, JSON.stringify(entries, null, 2));
  fs.writeFileSync(path.join(request.outDir, 'page-meta.json'), JSON.stringify(pageMeta, null, 2));
  ctx.log(`✓ Captured ${entries.length} screenshots across ${presets.length} viewport(s).`);

  return { manifestPath, screenshots: entries, pageMeta: pageMeta! };
}
