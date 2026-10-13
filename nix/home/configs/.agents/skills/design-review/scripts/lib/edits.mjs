import { stat } from 'node:fs/promises';
import path from 'node:path';
import { loadReview, writeReviewAtomic } from './review.mjs';

function findBox(review, id) {
  const box = review.boxes.find(item => item.id === id);
  if (!box) throw new Error(`No box with id ${id}; use a DR-### id listed in review.json`);
  return box;
}

async function platformImagePath(value, flag, reviewPath) {
  const absolutePath = path.resolve(process.cwd(), value);
  let info;
  try {
    info = await stat(absolutePath);
  } catch (error) {
    throw new Error(`--${flag} path "${value}" resolves to ${absolutePath} but cannot be read: ${error.message}; provide an existing image file`);
  }
  if (!info.isFile()) throw new Error(`--${flag} path "${value}" resolves to ${absolutePath}, which is not a file; provide an existing image file`);
  const reviewDirectory = path.dirname(path.resolve(reviewPath));
  const relativePath = path.relative(reviewDirectory, absolutePath);
  if (path.isAbsolute(relativePath) || relativePath.split(path.sep)[0] === '..') {
    throw new Error(`--${flag} path "${value}" resolves outside review.json directory ${reviewDirectory}; choose an image inside that directory`);
  }
  return relativePath.split(path.sep).join('/');
}

export async function editReview(reviewPath, action, values) {
  const review = await loadReview(reviewPath);
  if (action === 'union') {
    const box = findBox(review, values.id);
    const rects = [];
    if (values.asisRect) rects.push(values.asisRect);
    if (values.tobeRect) rects.push(values.tobeRect);
    const x = Math.min(...rects.map(rect => rect.x)), y = Math.min(...rects.map(rect => rect.y));
    box.rect = { x, y, w: Math.max(...rects.map(rect => rect.x + rect.w)) - x, h: Math.max(...rects.map(rect => rect.y + rect.h)) - y };
    await writeReviewAtomic(reviewPath, review);
    return box.id;
  }
  if (action === 'add') {
    const kind = values.kind;
    const sequence = Math.max(0, ...review.boxes.map(box => Number(box.id.match(/^DR-(\d+)$/)?.[1] || 0))) + 1;
    const id = `DR-${String(sequence).padStart(3, '0')}`;
    review.boxes.push({
      id, kind, state: values.state, platform: values.platform, rect: values.rect,
      node: { id: values['node-id'] || '', name: values['node-name'] || '' },
      property: values.property || '', asis: values.asis || '', answer: values.answer || '',
      files: values.files ? values.files.split(',').filter(Boolean) : [],
      batch: values.batch === undefined ? null : Number(values.batch), status: 'open', commit: null, note: values.note || '',
    });
    await writeReviewAtomic(reviewPath, review);
    return id;
  }
  if (action === 'status') {
    const box = findBox(review, values.id);
    const status = values.to;
    if (status === 'resolved' && box.kind !== 'fix') throw new Error('resolved status is only valid for fix boxes');
    if (status === 'accepted' && box.kind !== 'unintended') throw new Error('accepted status is only valid for unintended boxes');
    box.status = status;
    box.commit = status === 'resolved' ? values.commit : null;
    await writeReviewAtomic(reviewPath, review);
    return box.id;
  }
  if (action === 'set') {
    const box = findBox(review, values.id);
    if (values.batch !== undefined) box.batch = Number(values.batch);
    if (values.files !== undefined) box.files = values.files.split(',').map(file => file.trim()).filter(Boolean);
    if (values.note !== undefined) box.note = values.note;
    await writeReviewAtomic(reviewPath, review);
    return box.id;
  }
  if (action === 'platform') {
    const platform = review.concerns.flatMap(concern => concern.states)
      .filter(state => state.id === values.state)
      .flatMap(state => state.platforms)
      .find(item => item.name === values.name);
    if (!platform) throw new Error(`No platform "${values.name}" in state "${values.state}"; use an existing state/platform pair from review.json`);
    if (values.asis !== undefined) platform.asis = await platformImagePath(values.asis, 'asis', reviewPath);
    if (values.tobe !== undefined) platform.tobe = await platformImagePath(values.tobe, 'tobe', reviewPath);
    for (const key of ['status', 'reason']) if (values[key] !== undefined) platform[key] = values[key];
    await writeReviewAtomic(reviewPath, review);
    return `${values.state}/${values.name}`;
  }
  if (action === 'meta') {
    const fields = {
      'figma-url': ['figma', 'url'],
      'figma-file-key': ['figma', 'fileKey'],
      repo: ['repo'],
      'base-branch': ['base', 'branch'],
      'base-sha': ['base', 'sha'],
      'tobe-branch': ['tobe', 'branch'],
      'tobe-sha': ['tobe', 'sha'],
      'tobe-dirty': ['tobe', 'dirty'],
    };
    for (const [flag, keys] of Object.entries(fields)) {
      if (values[flag] === undefined) continue;
      let value = values[flag];
      if (flag === 'tobe-dirty') value = value === 'true';
      let target = review;
      for (const key of keys.slice(0, -1)) target = target[key];
      target[keys.at(-1)] = value;
    }
    await writeReviewAtomic(reviewPath, review);
    return 'meta';
  }
  if (action === 'batches') {
    const batch = Math.max(0, ...review.boxes.filter(box => box.kind === 'fix').map(box => Number(box.batch) || 0)) + 1;
    const openFixes = review.boxes.filter(box => box.kind === 'fix' && box.status === 'open')
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    const missingFiles = openFixes.filter(box => box.files.length === 0).map(box => box.id);
    if (missingFiles.length) throw new Error(`Open fix boxes have no files: ${missingFiles.join(', ')}; set them with review-edit set --review <path/review.json> --id <DR-###> --files <a,b>`);
    const selected = [];
    const usedFiles = new Set(review.boxes
      .filter(box => box.kind === 'fix' && box.status === 'fixed')
      .flatMap(box => box.files));
    for (const box of openFixes) {
      if (box.files.every(file => !usedFiles.has(file))) {
        selected.push(box);
        box.files.forEach(file => usedFiles.add(file));
      }
    }
    if (values.write) {
      selected.forEach(box => { box.batch = batch; });
      await writeReviewAtomic(reviewPath, review);
    }
    return JSON.stringify({ batch, boxes: selected.map(box => ({ id: box.id, files: box.files })) }, null, 2);
  }
  throw new Error(`Unknown edit action: ${action}`);
}
