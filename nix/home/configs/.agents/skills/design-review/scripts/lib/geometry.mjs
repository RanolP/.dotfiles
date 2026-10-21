import { numberText } from '../../../artificier-comparison/formats/still-cut-onion/scripts/lib/onion.mjs';

export function percent(value) {
  return `${numberText(value)}%`;
}

export function boxPlacement(rect, logicalWidth, logicalHeight) {
  return {
    left: percent(rect.x / logicalWidth * 100),
    top: percent(rect.y / logicalHeight * 100),
    width: percent(rect.w / logicalWidth * 100),
    height: percent(rect.h / logicalHeight * 100),
  };
}

export function logicalHeight(image, logicalWidth) {
  if (!image) return null;
  const scale = image.width / logicalWidth;
  if (!Number.isFinite(scale) || scale <= 0) throw new Error(`Screenshot width ${image.width} and logical platform width ${logicalWidth} must be positive; fix platform.width or replace the screenshot`);
  return image.height / scale;
}
