import { record } from './recorder';
import { screenshots } from './screenshots';
import type {
  CaptureRequest,
  CaptureResult,
  ScreenshotRequest,
  ScreenshotResult,
  StageContext,
  WebsiteCaptureService,
} from './types';

/** puppeteer-core + CDP screencast implementation (Steel cloud / local Chrome / connect). */
export class PuppeteerCaptureService implements WebsiteCaptureService {
  record(request: CaptureRequest, ctx: StageContext): Promise<CaptureResult> {
    return record(request, ctx);
  }

  screenshots(request: ScreenshotRequest, ctx: StageContext): Promise<ScreenshotResult> {
    return screenshots(request, ctx);
  }
}
