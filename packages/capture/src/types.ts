import type { BrowsePlan, Moment, RecordingMode, StageContext, Viewport } from '@wdv/schema';

export type { StageContext };
export { consoleStageContext } from '@wdv/schema';

/** Recording config after plan + env-var resolution (env wins when present). */
export interface ResolvedRecording {
  mode: RecordingMode;
  connectUrl: string | null;
  headful: boolean;
  userDataDir: string | undefined;
  chromePath: string | undefined;
  stepPauseMs: number | null;
  screencastQuality: number;
  /** Constant capture-cadence floor in fps (see recordingConfigSchema.captureFps). */
  captureFps: number;
}

export interface CaptureRequest {
  plan: BrowsePlan;
  recording: ResolvedRecording;
  /** Directory receiving raw.mp4, moments.json and error-*.png. */
  outDir: string;
  /** Project root used to locate Remotion's bundled chrome-headless-shell fallback. */
  chromeSearchRoot?: string;
}

export interface CaptureResult {
  rawVideoPath: string;
  momentsPath: string;
  moments: Moment[];
  frameCount: number;
  durationMs: number;
}

export interface ScreenshotRequest {
  url: string;
  /** Steps to run before shooting (e.g. dismiss a cookie banner); silent, no screencast. */
  preSteps?: BrowsePlan['steps'];
  viewports?: ViewportPreset[];
  /** Explicit selectors to capture as element shots (hero, pricing card, CTA…). */
  elementSelectors?: string[];
  hideText?: string[];
  recording: ResolvedRecording;
  outDir: string;
  chromeSearchRoot?: string;
}

export interface ViewportPreset {
  id: string;
  width: number;
  height: number;
  deviceScaleFactor?: number;
  isMobile?: boolean;
}

export const DEFAULT_VIEWPORT_PRESETS: ViewportPreset[] = [
  { id: 'desktop', width: 1440, height: 900, deviceScaleFactor: 2 },
  { id: 'mobile', width: 390, height: 844, deviceScaleFactor: 3, isMobile: true },
];

export interface ScreenshotEntry {
  id: string;
  kind: 'fullpage' | 'section' | 'element';
  viewport: string;
  file: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  scrollY?: number;
  selector?: string;
  sectionTitle?: string;
}

export interface PageMeta {
  url: string;
  title: string;
  description: string | null;
  ogImage: string | null;
  favicon: string | null;
  themeColor: string | null;
  /** Prominent brand colors sampled from computed styles (best effort). */
  brandColors: string[];
}

export interface ScreenshotResult {
  manifestPath: string;
  screenshots: ScreenshotEntry[];
  pageMeta: PageMeta;
}

export interface WebsiteCaptureService {
  record(request: CaptureRequest, ctx: StageContext): Promise<CaptureResult>;
  screenshots(request: ScreenshotRequest, ctx: StageContext): Promise<ScreenshotResult>;
}

export const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 800 };
