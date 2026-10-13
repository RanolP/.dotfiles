import { decodePng } from './png.mjs';

function averagePixel(image, scale, x, y) {
  const x0 = Math.max(0, Math.floor(x * scale));
  const x1 = Math.min(image.width, Math.max(x0 + 1, Math.floor((x + 1) * scale)));
  const y0 = Math.max(0, Math.floor(y * scale));
  const y1 = Math.min(image.height, Math.max(y0 + 1, Math.floor((y + 1) * scale)));
  if (x0 >= image.width || y0 >= image.height || x1 <= x0 || y1 <= y0) return null;
  const sums = [0, 0, 0, 0];
  let count = 0;
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const index = (py * image.width + px) * image.channels;
      for (let c = 0; c < 3; c++) sums[c] += image.pixels[index + c];
      sums[3] += image.channels === 4 ? image.pixels[index + 3] : 255;
      count++;
    }
  }
  return sums.map(value => value / count);
}

function changed(a, b, threshold) {
  if (!a || !b) return a !== b;
  return a.some((value, index) => Math.abs(value - b[index]) > threshold);
}

function mergeClose(regions, gap) {
  let merged = regions.map(region => ({ ...region }));
  let changedAny = true;
  while (changedAny) {
    changedAny = false;
    outer: for (let i = 0; i < merged.length; i++) {
      for (let j = i + 1; j < merged.length; j++) {
        const a = merged[i], b = merged[j];
        const dx = Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w));
        const dy = Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h));
        if (Math.hypot(dx, dy) <= gap) {
          const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
          merged[i] = { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
          merged.splice(j, 1);
          changedAny = true;
          break outer;
        }
      }
    }
  }
  return merged;
}

function coveredFraction(region, boxes) {
  const left = region.x, right = region.x + region.w;
  const top = region.y, bottom = region.y + region.h;
  const rects = boxes.map(box => ({
    left: Math.max(left, box.rect.x),
    right: Math.min(right, box.rect.x + box.rect.w),
    top: Math.max(top, box.rect.y),
    bottom: Math.min(bottom, box.rect.y + box.rect.h),
  })).filter(rect => rect.right > rect.left && rect.bottom > rect.top);
  const xs = [...new Set([left, right, ...rects.flatMap(rect => [rect.left, rect.right])])].sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i < xs.length - 1; i++) {
    const x1 = xs[i], x2 = xs[i + 1];
    if (x2 <= x1) continue;
    const intervals = rects
      .filter(rect => rect.left < x2 && rect.right > x1)
      .map(rect => [rect.top, rect.bottom])
      .sort((a, b) => a[0] - b[0]);
    let coveredY = 0, start = null, end = null;
    for (const [nextStart, nextEnd] of intervals) {
      if (start === null) [start, end] = [nextStart, nextEnd];
      else if (nextStart <= end) end = Math.max(end, nextEnd);
      else {
        coveredY += end - start;
        [start, end] = [nextStart, nextEnd];
      }
    }
    if (start !== null) coveredY += end - start;
    area += (x2 - x1) * coveredY;
  }
  return area / (region.w * region.h);
}

export async function findChangedRegions(asisPath, tobePath, logicalWidth, options = {}) {
  const threshold = options.threshold ?? 16;
  const minArea = options.minArea ?? 16;
  const merge = options.merge ?? 8;
  if (!Number.isFinite(logicalWidth) || logicalWidth <= 0) throw new TypeError(`logicalWidth must be a positive finite number; received ${logicalWidth}`);
  if (!Number.isFinite(threshold) || threshold < 0) throw new TypeError(`threshold must be a finite non-negative number; received ${threshold}`);
  if (!Number.isFinite(minArea) || minArea < 0) throw new TypeError(`minArea must be a finite non-negative number; received ${minArea}`);
  if (!Number.isFinite(merge) || merge < 0) throw new TypeError(`merge must be a finite non-negative number; received ${merge}`);
  const [asis, tobe] = await Promise.all([decodePng(asisPath), decodePng(tobePath)]);
  const scaleA = asis.width / logicalWidth, scaleB = tobe.width / logicalWidth;
  const width = Math.ceil(logicalWidth);
  const height = Math.ceil(Math.max(asis.height / scaleA, tobe.height / scaleB));
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (changed(averagePixel(asis, scaleA, x, y), averagePixel(tobe, scaleB, x, y), threshold)) mask[y * width + x] = 1;
    }
  }
  const seen = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const regions = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let head = 0, tail = 0;
    queue[tail++] = start; seen[start] = 1;
    let minX = width, minY = height, maxX = -1, maxY = -1;
    while (head < tail) {
      const at = queue[head++], x = at % width, y = Math.floor(at / width);
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy, next = ny * width + nx;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height && mask[next] && !seen[next]) {
          seen[next] = 1; queue[tail++] = next;
        }
      }
    }
    regions.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 });
  }
  let result = mergeClose(regions, merge).filter(region => region.w * region.h >= minArea);
  if (options.excludeBoxes) {
    const recorded = options.excludeBoxes.filter(box => box.state === options.state && box.platform === options.platform);
    result = result.filter(region => coveredFraction(region, recorded) < 0.9);
  }
  return result.sort((a, b) => a.y - b.y || a.x - b.x);
}
