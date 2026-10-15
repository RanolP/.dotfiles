import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const kinds = new Set(['fix', 'unintended']);
const statuses = new Set(['open', 'fixed', 'resolved', 'accepted']);

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
  return value;
}

function string(value, field, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new TypeError(`${field} must be a non-empty string`);
}

function finite(value, field, positive = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || (positive && value <= 0)) {
    throw new TypeError(`${field} must be ${positive ? 'a positive' : 'a finite'} number`);
  }
}

function stringArray(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  value.forEach((item, index) => string(item, `${field}[${index}]`, true));
}

function nullablePath(value, field) {
  if (value !== null) string(value, field);
}

export function validateReview(review) {
  object(review, 'review');
  const figma = object(review.figma, 'figma');
  string(figma.url, 'figma.url');
  string(figma.fileKey, 'figma.fileKey');
  string(review.repo, 'repo');
  for (const field of ['base', 'tobe']) {
    const ref = object(review[field], field);
    string(ref.branch, `${field}.branch`);
    string(ref.sha, `${field}.sha`);
  }
  if (typeof review.tobe.dirty !== 'boolean') throw new TypeError('tobe.dirty must be a boolean');
  if (!Array.isArray(review.concerns)) throw new TypeError('concerns must be an array');
  const statePlatforms = new Set();
  review.concerns.forEach((concern, ci) => {
    const base = `concerns[${ci}]`;
    object(concern, base);
    for (const key of ['id', 'name', 'nodeId']) string(concern[key], `${base}.${key}`, true);
    stringArray(concern.notes, `${base}.notes`);
    if (!Array.isArray(concern.states)) throw new TypeError(`${base}.states must be an array`);
    concern.states.forEach((state, si) => {
      const field = `${base}.states[${si}]`;
      object(state, field);
      for (const key of ['id', 'name', 'nodeId']) string(state[key], `${field}.${key}`, true);
      stringArray(state.notes, `${field}.notes`);
      const frame = object(state.frame, `${field}.frame`);
      finite(frame.w, `${field}.frame.w`, true);
      finite(frame.h, `${field}.frame.h`, true);
      nullablePath(state.figmaShot, `${field}.figmaShot`);
      if (!Array.isArray(state.platforms)) throw new TypeError(`${field}.platforms must be an array`);
      state.platforms.forEach((platform, pi) => {
        const p = `${field}.platforms[${pi}]`;
        object(platform, p);
        string(platform.name, `${p}.name`);
        finite(platform.width, `${p}.width`, true);
        nullablePath(platform.asis, `${p}.asis`);
        nullablePath(platform.tobe, `${p}.tobe`);
        if (!['captured', 'missing'].includes(platform.status)) throw new TypeError(`${p}.status must be captured or missing`);
        if (platform.reason !== undefined) string(platform.reason, `${p}.reason`, true);
        statePlatforms.add(JSON.stringify([state.id, platform.name]));
      });
    });
  });
  if (!Array.isArray(review.boxes)) throw new TypeError('boxes must be an array');
  const boxIds = new Map();
  review.boxes.forEach((box, index) => {
    const field = `boxes[${index}]`;
    object(box, field);
    for (const key of ['id', 'state', 'platform']) string(box[key], `${field}.${key}`);
    if (boxIds.has(box.id)) throw new TypeError(`${field}.id ${box.id} duplicates ${boxIds.get(box.id)}; assign a unique DR-### id`);
    boxIds.set(box.id, field);
    if (!statePlatforms.has(JSON.stringify([box.state, box.platform]))) {
      throw new TypeError(`${field} id ${box.id} references missing state/platform pair (${box.state}, ${box.platform}); correct the pair to match a platform in review.concerns`);
    }
    if (!kinds.has(box.kind)) throw new TypeError(`${field}.kind must be fix or unintended`);
    if (!statuses.has(box.status)) throw new TypeError(`${field}.status must be open, fixed, resolved, or accepted`);
    if (box.status === 'resolved' && box.kind !== 'fix') throw new TypeError(`${field}.resolved requires kind fix`);
    if (box.status === 'resolved' && !box.commit) throw new TypeError(`${field}.resolved requires commit sha`);
    if (box.status === 'accepted' && box.kind !== 'unintended') throw new TypeError(`${field}.accepted requires kind unintended`);
    const rect = object(box.rect, `${field}.rect`);
    for (const key of ['x', 'y', 'w', 'h']) finite(rect[key], `${field}.rect.${key}`);
    if (rect.w <= 0 || rect.h <= 0) throw new TypeError(`${field}.rect.w and .h must be positive`);
    const node = object(box.node, `${field}.node`);
    string(node.id, `${field}.node.id`, true);
    string(node.name, `${field}.node.name`, true);
    for (const key of ['property', 'asis', 'answer', 'note']) string(box[key], `${field}.${key}`, true);
    stringArray(box.files, `${field}.files`);
    if (box.batch !== null && (!Number.isInteger(box.batch) || box.batch < 1)) throw new TypeError(`${field}.batch must be null or a positive integer`);
    if (box.commit !== null) string(box.commit, `${field}.commit`);
    if (box.fixedAt !== undefined) string(box.fixedAt, `${field}.fixedAt`);
    if (box.noPhotoReason !== undefined) string(box.noPhotoReason, `${field}.noPhotoReason`);
    if (box.status !== 'resolved' && box.commit !== null) throw new TypeError(`${field}.commit must be null unless status is resolved`);
  });
  return review;
}

export async function loadReview(file) {
  let source;
  try {
    source = await readFile(file, 'utf8');
  } catch (error) {
    throw new Error(`Could not read review.json at ${file}: ${error.message}`);
  }
  let review;
  try {
    review = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid JSON in ${file}: ${error.message}`);
  }
  try {
    return validateReview(review);
  } catch (error) {
    throw new Error(`Invalid review.json field in ${file}: ${error.message}`);
  }
}

export async function writeReviewAtomic(file, review) {
  validateReview(review);
  const target = path.resolve(file);
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(review, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw new Error(`Could not atomically write ${target}: ${error.message}`);
  }
}
