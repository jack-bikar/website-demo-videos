export * from './types';
export { PuppeteerCaptureService } from './service';
export { record } from './recorder';
export { screenshots } from './screenshots';
export { resolveRecordingConfig, resolveLocalChrome, openBrowser, DEFAULT_SCREENCAST_QUALITY, PROTOCOL_TIMEOUT } from './connect';
export { CursorController, smoothScroll, clampTourScrollDelta, sleep, humanPause } from './motion';
export { startScreencast, encodeFrames } from './screencast';
