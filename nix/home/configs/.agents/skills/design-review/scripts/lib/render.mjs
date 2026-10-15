import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readImageSize } from './image.mjs';
import { boxPlacement, logicalHeight, numberText } from './geometry.mjs';

const statusLabels = { open: '열림', fixed: '수정 완료', resolved: '해결', accepted: '수용' };
const kindLabels = { fix: '수정', unintended: '의도하지 않은 변경' };

function esc(value) {
  return value === null || value === undefined ? '–' : String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function textNotes(notes, className) {
  if (!notes.length) return '';
  return `<ul class="${className}">${notes.map(note => `<li>${esc(note)}</li>`).join('')}</ul>`;
}

function boxClass(box) {
  if (box.status === 'resolved') return 'box-resolved';
  if (box.status === 'accepted') return 'box-accepted';
  if (box.kind === 'fix' && box.status === 'fixed') return 'box-fix-fixed';
  if (box.kind === 'unintended') return 'box-unintended-open';
  return 'box-fix-open';
}

function copyPhrase(box) {
  return `${box.id} resolved`;
}

function marker(box, placement) {
  return `<div class="box-marker ${boxClass(box)}" data-box-id="${esc(box.id)}" data-kind="${esc(box.kind)}" data-status="${esc(box.status)}" style="left:${placement.left};top:${placement.top};width:${placement.width};height:${placement.height}"><button type="button" class="box-label" data-copy="${esc(copyPhrase(box))}" aria-label="${esc(box.id)} 해결 문구 복사">${esc(box.id)}</button></div>`;
}

async function relativeImage(rawPath, reviewDir, outputDir) {
  if (rawPath === null) return null;
  if (typeof rawPath !== 'string' || !rawPath.trim()) throw new TypeError(`Image path "${rawPath}" must be a non-empty relative path; set a relative image path in review.json`);
  if (/^[a-z][a-z\d+.-]*:/i.test(rawPath) || rawPath.startsWith('/') || rawPath.startsWith('\\') || /^[a-z]:[\\/]/i.test(rawPath)) {
    throw new TypeError(`image path must be relative: ${rawPath}`);
  }
  const source = path.resolve(reviewDir, rawPath);
  const relative = path.relative(outputDir, source);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Image "${rawPath}" at ${source} is outside output directory ${outputDir} (review directory ${reviewDir}); place the image under ${outputDir} or choose an output directory beside the review.`);
  }
  const src = relative.split(path.sep).join('/');
  const size = await readImageSize(source);
  return { src, source, ...size };
}

function shotImage(image, alt, className = 'screen-image') {
  return image
    ? `<img class="${className}" src="${esc(image.src)}" alt="${esc(alt)}">`
    : '<div class="stage-empty">미캡처</div>';
}

function figmaLink(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' && ['figma.com', 'www.figma.com'].includes(parsed.hostname) && parsed.pathname.startsWith('/design/')) {
      return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Figma에서 열기</a>`;
    }
  } catch {}
  return '<span>Figma</span>';
}

function rowBoxes(review, stateId, platformName) {
  return review.boxes.filter(box => box.state === stateId && box.platform === platformName);
}

export function duplicateKey(stateId, platformName) {
  return JSON.stringify([stateId, platformName]);
}

export async function renderGallery(review, reviewPath, outputPath, title, duplicates = new Map()) {
  const reviewDir = path.dirname(path.resolve(reviewPath));
  const outputDir = path.dirname(path.resolve(outputPath));
  const images = new Set();
  const imageFiles = [];
  async function image(raw) {
    if (raw === null) return null;
    const result = await relativeImage(raw, reviewDir, outputDir);
    if (!images.has(result.src)) {
      images.add(result.src);
      imageFiles.push({ src: result.src, source: result.source });
    }
    return result;
  }

  const concernFilter = [];
  const platformFilter = [];
  const sections = [];
  for (const concern of review.concerns) {
    concernFilter.push([concern.id, concern.name]);
    const rows = [];
    for (const state of concern.states) {
      const figmaShot = await image(state.figmaShot);
      for (const platform of state.platforms) {
        platformFilter.push(platform.name);
        const asis = await image(platform.asis);
        const tobe = await image(platform.tobe);
        const heights = [logicalHeight(asis, platform.width), logicalHeight(tobe, platform.width)].filter(Number.isFinite);
        const screenHeight = Math.max(...heights, heights.length ? 0 : state.frame.h);
        const ratio = `${numberText(platform.width)} / ${numberText(screenHeight)}`;
        const boxList = rowBoxes(review, state.id, platform.name);
        if (platform.status === 'missing' && !asis && !tobe && !boxList.length) {
          rows.push(`<div class="review-row missing-row" data-concern="${esc(concern.id)}" data-platform="${esc(platform.name)}"><p class="missing-line">${esc(state.name)} · ${esc(platform.name)}: ${esc(platform.reason || '캡처 없음')}, 이번 판 촬영 제외</p></div>`);
          continue;
        }
        const rowMarkers = boxList.map(box => marker(box, boxPlacement(box.rect, platform.width, screenHeight))).join('');
        const tableRows = boxList.map(box => {
          const files = box.files.length ? box.files.map(esc).join('<br>') : '–';
          const commit = box.commit ? box.commit.slice(0, 8) : '–';
          return `<tr class="box-record ${boxClass(box)}" data-box-id="${esc(box.id)}" data-kind="${esc(box.kind)}" data-status="${esc(box.status)}"><td><button type="button" class="table-box-label" data-copy="${esc(copyPhrase(box))}" aria-label="${esc(box.id)} 해결 문구 복사">${esc(box.id)}</button></td><td>${esc(kindLabels[box.kind])}</td><td>${esc(box.node.name)}</td><td>${esc(box.property)}</td><td>${esc(box.asis)} <span aria-hidden="true">→</span> ${esc(box.answer)}</td><td>${files}</td><td>${esc(statusLabels[box.status])}${box.noPhotoReason ? `<span class="no-photo">no photo: ${esc(box.noPhotoReason)}</span>` : ''}</td><td>${esc(commit)}</td></tr>`;
        }).join('');
        const table = tableRows
          ? `<div class="table-wrap"><table><thead><tr><th>ID</th><th>종류</th><th>노드</th><th>속성</th><th>기준 → 답</th><th>파일</th><th>상태</th><th>커밋</th></tr></thead><tbody>${tableRows}</tbody></table></div>`
          : '';
        const warning = platform.status === 'missing'
          ? `<p class="missing-notice">플랫폼 캡처 없음${platform.reason ? ` · ${esc(platform.reason)}` : ''}</p>`
          : '';
        const duplicateBadges = (duplicates.get(duplicateKey(state.id, platform.name)) || [])
          .map(item => `<p class="duplicate-notice">looks identical to ${esc(item.other)} (${esc(item.side)})</p>`).join('');
        const figma = `<div class="screen figma-screen" style="aspect-ratio:${numberText(state.frame.w)} / ${numberText(state.frame.h)}">${shotImage(figmaShot, 'Figma 디자인')}</div>`;
        const asisView = `<div class="screen comparison-screen" style="aspect-ratio:${ratio}">${shotImage(asis, '기준 화면')}${rowMarkers}</div>`;
        const tobeView = `<div class="screen comparison-screen" style="aspect-ratio:${ratio}">${shotImage(tobe, '작업 후 화면')}${rowMarkers}</div>`;
        const onion = `<div class="screen comparison-screen onion-screen" style="aspect-ratio:${ratio}"><div class="onion-pair">${shotImage(asis, '기준 화면', 'onion-image onion-asis')}${shotImage(tobe, '작업 후 화면', 'onion-image onion-tobe')}</div><canvas class="sep-canvas" aria-label="색 분리 비교"></canvas>${rowMarkers}</div>`;
        rows.push(`<article class="review-row" data-concern="${esc(concern.id)}" data-platform="${esc(platform.name)}"><header class="row-heading"><h3>${esc(state.name)} <span class="platform-tag">${esc(platform.name)}</span></h3>${textNotes(state.notes, 'state-notes')}</header>${warning}${duplicateBadges}<div class="comparison-grid"><figure class="shot"><figcaption>Figma <span>${numberText(state.frame.w)} × ${numberText(state.frame.h)}</span></figcaption>${figma}</figure><figure class="shot"><figcaption>기준</figcaption>${asisView}</figure><figure class="shot"><figcaption>작업 후</figcaption>${tobeView}</figure><figure class="shot"><figcaption>겹쳐 보기</figcaption>${onion}</figure></div>${table}</article>`);
      }
    }
    sections.push(`<section class="concern-section" data-concern-section="${esc(concern.id)}"><div class="concern-heading"><h2>${esc(concern.name)}</h2>${concern.nodeId ? `<span class="node-ref">Figma ${esc(concern.nodeId)}</span>` : ''}</div>${textNotes(concern.notes, 'concern-notes')}${rows.join('')}</section>`);
  }

  const counts = Object.keys(statusLabels).map(status => `<span class="count count-${status}"><b>${review.boxes.filter(box => box.status === status).length}</b> ${statusLabels[status]}</span>`).join('');
  const concernOptions = concernFilter.map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join('');
  const platformOptions = [...new Set(platformFilter)].map(value => `<option value="${esc(value)}">${esc(value)}</option>`).join('');
  const pageTitle = title || `Design Review ${review.repo.split(/[\s/]+/).filter(Boolean).slice(0, 2).join(' ')}`;
  const words = pageTitle.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) throw new Error(`--title "${pageTitle}" has ${words.length} words; provide 2 to 4 words for the Artifact page title`);
  const dirty = review.tobe.dirty ? ' · 변경 있음' : '';
  const css = await readFile(new URL('./assets/gallery.css', import.meta.url), 'utf8');
  const js = await readFile(new URL('./assets/gallery.js', import.meta.url), 'utf8');
  const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(pageTitle)}</title><style>${css}</style></head>
<body><main class="page"><header class="top"><div><h1>${esc(pageTitle)}</h1><p class="repo">저장소: ${esc(review.repo)}</p><div class="source-meta"><span><strong>Figma</strong> ${figmaLink(review.figma.url)}</span><span><strong>기준</strong> ${esc(`${review.base.branch}@${review.base.sha}`)}</span><span><strong>작업 중</strong> ${esc(`${review.tobe.branch}@${review.tobe.sha}${dirty}`)}</span></div></div></header>
<div class="status-counts" aria-label="상태별 상자 수">${counts}</div>
<div class="filters" aria-label="화면 필터"><label>화면 <select id="concern-filter"><option value="all">모든 화면</option>${concernOptions}</select></label><label>플랫폼 <select id="platform-filter"><option value="all">모든 플랫폼</option>${platformOptions}</select></label><label>종류 <select id="kind-filter"><option value="all">모든 종류</option><option value="fix">수정</option><option value="unintended">의도하지 않은 변경</option></select></label><label>상태 <select id="status-filter"><option value="all">모든 상태</option>${Object.entries(statusLabels).map(([status, label]) => `<option value="${status}">${label}</option>`).join('')}</select></label><button type="button" class="box-off" title="단축키 b">전부 끄기</button><button type="button" class="box-restore" title="단축키 b">전부 이전 상태로 돌리기</button><label class="only-open"><input id="show-settled" type="checkbox"> 해결된 박스도</label><span class="slider-wrap"><label for="onion-slider">겹침</label><input id="onion-slider" type="range" min="0" max="100" value="50"><output id="onion-value">50%</output></span><button type="button" class="mode-toggle" aria-pressed="false">색 분리 켜기</button><button type="button" class="theme-toggle" aria-label="색상 테마 전환">테마 전환</button></div>
<span class="mode-notice" role="status" aria-live="polite" hidden>색 분리는 http(s)로 열었을 때만 동작한다</span>
<div id="gallery">${sections.join('')}</div><div class="no-results" hidden>조건에 맞는 화면이 없습니다.</div></main><div class="toast" role="status" aria-live="polite">복사됨</div><script>${js}</script></body></html>`;
  return { html, files: imageFiles };
}
