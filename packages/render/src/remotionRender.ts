import { createRequire } from 'node:module';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import type { DemoVideoProps, RenderQuality, StageContext } from '@wdv/schema';
import { QUALITY_PRESETS } from './fastRender';

/**
 * Programmatic Remotion rendering (replaces shelling out to the remotion CLI binary).
 * The composition entry lives in @wdv/compositions; `publicDir` decides what
 * staticFile() resolves against, so each take's directory can serve its own footage.
 */

const require = createRequire(import.meta.url);

/** Bundling costs seconds — cache per publicDir and reuse across renders of the same take. */
const bundleCache = new Map<string, Promise<string>>();

function bundleFor(publicDir: string, ctx: StageContext): Promise<string> {
  let cached = bundleCache.get(publicDir);
  if (!cached) {
    ctx.log('• Bundling Remotion composition…');
    cached = bundle({
      entryPoint: require.resolve('@wdv/compositions'),
      publicDir,
    });
    bundleCache.set(publicDir, cached);
    cached.catch(() => bundleCache.delete(publicDir));
  }
  return cached;
}

export interface RemotionRenderRequest {
  compositionId?: string;
  inputProps: DemoVideoProps;
  outputPath: string;
  /** Directory staticFile() resolves against (the take dir holding the footage). */
  publicDir: string;
  quality: RenderQuality;
  /** Render only these frames (inclusive) — used for the brand-overlay opening. */
  frameRange?: [number, number];
  muted?: boolean;
  timeoutMs?: number;
  onProgress?: (progress: number) => void;
}

export async function renderWithRemotion(request: RemotionRenderRequest, ctx: StageContext): Promise<void> {
  const serveUrl = await bundleFor(request.publicDir, ctx);
  const compositionId = request.compositionId ?? 'DemoVideo';
  const quality = QUALITY_PRESETS[request.quality] ?? QUALITY_PRESETS.draft;
  const timeoutInMilliseconds = request.timeoutMs ?? 120000;

  const composition = await selectComposition({
    serveUrl,
    id: compositionId,
    inputProps: request.inputProps,
    timeoutInMilliseconds,
  });

  const label = request.frameRange
    ? `Rendering frames ${request.frameRange[0]}–${request.frameRange[1]} with Remotion`
    : 'Rendering all frames with Remotion';
  ctx.log(`\n${label}`);

  let lastLogged = -1;
  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    outputLocation: request.outputPath,
    inputProps: request.inputProps,
    frameRange: request.frameRange,
    muted: request.muted ?? false,
    crf: quality.crf,
    x264Preset: quality.preset as 'veryfast' | 'medium' | 'slow',
    timeoutInMilliseconds,
    onProgress: ({ progress }) => {
      request.onProgress?.(progress);
      const pct = Math.floor(progress * 10) * 10;
      if (pct > lastLogged) {
        lastLogged = pct;
        ctx.log(`  rendered ${pct}%`);
      }
    },
  });
}
