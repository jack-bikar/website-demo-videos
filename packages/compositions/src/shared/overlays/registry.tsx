import React from 'react';
import { BrandIntroOverlay } from './BrandIntroOverlay';

/**
 * Overlay registry: `meta.overlay.id` selects a component; `meta.overlay.props` are passed
 * through and validated by the component's own zod schema. A static map, not a plugin
 * system — new overlays are added here.
 */

export interface OverlayComponentProps {
  durationInFrames: number;
  props?: Record<string, unknown>;
}

export const overlayRegistry: Record<string, React.FC<OverlayComponentProps>> = {
  'brand-intro': BrandIntroOverlay,
};

export function resolveOverlayComponent(id: string): React.FC<OverlayComponentProps> | null {
  return overlayRegistry[id] ?? null;
}
