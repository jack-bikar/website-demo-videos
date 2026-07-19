import { registerRoot } from 'remotion';
import { RemotionRoot } from './Root';

export { DemoVideo, demoVideoMetadata, resolveDemoVideo, FPS } from './walkthrough/DemoVideo';
export { RemotionRoot } from './Root';
export { overlayRegistry, resolveOverlayComponent } from './shared/overlays/registry';
export { BrandIntroOverlay, brandIntroPropsSchema } from './shared/overlays/BrandIntroOverlay';

registerRoot(RemotionRoot);
