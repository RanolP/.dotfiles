(() => {
  const root = document.documentElement;
  const slider = document.getElementById('onion-slider');
  const output = document.getElementById('onion-value');
  const modeButton = document.querySelector('.mode-toggle');
  const modeNotice = document.querySelector('.mode-notice');
  const toast = document.querySelector('.toast');
  let toastTimer;
  let colorSeparationBlocked = false;

  slider.addEventListener('input', () => {
    root.style.setProperty('--tobe-opacity', String(Number(slider.value) / 100));
    output.value = `${slider.value}%`;
    output.textContent = `${slider.value}%`;
  });
  modeButton.addEventListener('click', async () => {
    if (colorSeparationBlocked) {
      modeNotice.hidden = false;
      return;
    }
    const enabled = document.body.classList.toggle('color-mode');
    modeButton.setAttribute('aria-pressed', String(enabled));
    modeButton.textContent = enabled ? '색 분리 끄기' : '색 분리 켜기';
    modeNotice.hidden = true;
    if (enabled) await Promise.all([...document.querySelectorAll('.review-row')].map(renderSeparation));
  });
  document.querySelector('.theme-toggle').addEventListener('click', () => {
    root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
  });

  async function renderSeparation(row) {
    const canvas = row.querySelector('.sep-canvas');
    if (canvas.dataset.ready === 'true' || canvas.dataset.error) return;
    const left = row.querySelector('.onion-asis');
    const right = row.querySelector('.onion-tobe');
    const images = [left, right].filter(image => image?.getAttribute('src'));
    if (!images.length) return;
    try {
      await Promise.all(images.map(image => image.complete ? Promise.resolve() : new Promise((resolve, reject) => {
        image.addEventListener('load', resolve, { once: true });
        image.addEventListener('error', reject, { once: true });
      })));
      const width = Math.max(...images.map(image => image.naturalWidth));
      const heightFor = image => Math.max(1, Math.round(image.naturalHeight * width / image.naturalWidth));
      canvas.width = width;
      canvas.height = Math.max(...images.map(heightFor));
      const context = canvas.getContext('2d', { willReadFrequently: true });
      const pixels = [];
      for (const image of [left, right]) {
        if (!image?.getAttribute('src')) {
          pixels.push(null);
          continue;
        }
        const scratch = document.createElement('canvas');
        scratch.width = width;
        scratch.height = canvas.height;
        const scratchContext = scratch.getContext('2d', { willReadFrequently: true });
        scratchContext.drawImage(image, 0, 0, width, heightFor(image));
        pixels.push(scratchContext.getImageData(0, 0, width, canvas.height).data);
      }
      const result = context.createImageData(width, canvas.height);
      for (let i = 0; i < result.data.length; i += 4) {
        const a = pixels[0], b = pixels[1];
        const aLuma = a ? a[i] * .2126 + a[i + 1] * .7152 + a[i + 2] * .0722 : 0;
        const bLuma = b ? b[i] * .2126 + b[i + 1] * .7152 + b[i + 2] * .0722 : 0;
        const alpha = Math.max(a ? a[i + 3] : 0, b ? b[i + 3] : 0);
        result.data[i] = Math.round(aLuma);
        result.data[i + 1] = Math.round(bLuma);
        result.data[i + 2] = Math.round(bLuma);
        result.data[i + 3] = alpha;
      }
      context.putImageData(result, 0, 0);
      canvas.dataset.ready = 'true';
    } catch (error) {
      canvas.dataset.error = error.name || 'error';
      canvas.setAttribute('aria-label', '색 분리 처리 실패');
      if (error.name === 'SecurityError') {
        colorSeparationBlocked = true;
        document.body.classList.remove('color-mode');
        modeButton.setAttribute('aria-pressed', 'false');
        modeButton.textContent = '색 분리 켜기';
        modeNotice.hidden = false;
      }
    }
  }

  function copyFallback(text) {
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.append(field);
    field.select();
    try { document.execCommand('copy'); } finally { field.remove(); }
  }
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-copy]');
    if (!button) return;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(button.dataset.copy);
      else copyFallback(button.dataset.copy);
    } catch { copyFallback(button.dataset.copy); }
    toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('visible'), 1100);
  });

  function setPairHighlight(id, active) {
    document.querySelectorAll('[data-box-id]').forEach(item => {
      if (item.dataset.boxId === id) item.classList.toggle(item.classList.contains('box-marker') ? 'box-highlight' : 'table-highlight', active);
    });
  }
  document.querySelectorAll('[data-box-id]').forEach(item => {
    item.addEventListener('mouseenter', () => setPairHighlight(item.dataset.boxId, true));
    item.addEventListener('mouseleave', () => setPairHighlight(item.dataset.boxId, false));
    item.addEventListener('focusin', () => setPairHighlight(item.dataset.boxId, true));
    item.addEventListener('focusout', () => setPairHighlight(item.dataset.boxId, false));
  });

  const storeKeys = { on: 'design-review.boxes', settled: 'design-review.showSettled' };
  const readStore = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const writeStore = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
  const boxButton = document.querySelector('.box-toggle');
  const settledBox = document.getElementById('show-settled');
  const settledStatuses = ['resolved', 'accepted'];
  let boxesOn = readStore(storeKeys.on) === '1';
  let isolated = null;
  settledBox.checked = readStore(storeKeys.settled) === '1';

  function setBoxes(on) {
    boxesOn = on;
    isolated = null;
    writeStore(storeKeys.on, on ? '1' : '0');
    applyFilters();
  }
  boxButton.addEventListener('click', () => setBoxes(!(boxesOn || isolated)));
  settledBox.addEventListener('change', () => { writeStore(storeKeys.settled, settledBox.checked ? '1' : '0'); applyFilters(); });
  document.addEventListener('click', event => {
    const button = event.target.closest('.table-box-label');
    if (!button) return;
    const id = button.closest('tr').dataset.boxId;
    isolated = isolated === id ? null : id;
    applyFilters();
  });
  document.addEventListener('keydown', event => {
    if ((event.key !== 'b' && event.code !== 'KeyB') || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const target = event.target;
    if (target && (/^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName) || target.isContentEditable)) return;
    setBoxes(!(boxesOn || isolated));
  });

  // Greedy per-screen label placement: smallest boxes pick first, since a big box's corner label rarely hides what it marks.
  const labelGap = 2;
  function placeLabels(screen) {
    const width = screen.clientWidth, height = screen.clientHeight;
    if (!width || !height) return;
    const origin = screen.getBoundingClientRect();
    const ox = origin.left + screen.clientLeft, oy = origin.top + screen.clientTop;
    const markers = [...screen.querySelectorAll('.box-marker')].filter(marker => !marker.hidden).map(marker => {
      const rect = marker.getBoundingClientRect();
      return { marker, label: marker.querySelector('.box-label'), x: rect.left - ox, y: rect.top - oy, w: rect.width, h: rect.height };
    }).sort((a, b) => a.w * a.h - b.w * b.h || a.marker.dataset.boxId.localeCompare(b.marker.dataset.boxId));
    const placed = [];
    const hits = (r, q) => r.x < q.x + q.w && q.x < r.x + r.w && r.y < q.y + q.h && q.y < r.y + r.h;
    for (const box of markers) {
      const { label, marker } = box;
      label.classList.remove('label-inside');
      label.style.cssText = 'left:0;top:0;bottom:auto;right:auto';
      const w = label.offsetWidth, h = label.offsetHeight;
      const above = box.y - h - labelGap, below = box.y + box.h + labelGap;
      const left = box.x, right = box.x + box.w - w;
      const candidates = [[left, above], [right, above], [left, below], [right, below]];
      const step = Math.max(4, Math.round(h / 2));
      for (const y of [above, below]) for (let k = 1; k * step <= width; k++) candidates.push([left + k * step, y], [left - k * step, y]);
      const free = candidates.map(([x, y]) => ({ x, y, w, h })).find(r => r.x >= 0 && r.y >= 0 && r.x + r.w <= width && r.y + r.h <= height && !placed.some(q => hits(r, q)));
      const spot = free || { x: box.x, y: box.y, w, h };
      if (!free) label.classList.add('label-inside');
      const inset = marker.clientLeft;
      label.style.left = `${spot.x - box.x - inset}px`;
      label.style.top = `${spot.y - box.y - marker.clientTop}px`;
      placed.push(spot);
    }
  }
  const placeAll = () => document.querySelectorAll('.screen').forEach(placeLabels);
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(entries => entries.forEach(entry => placeLabels(entry.target)));
    document.querySelectorAll('.screen').forEach(screen => { if (screen.querySelector('.box-marker')) observer.observe(screen); });
  } else window.addEventListener('resize', placeAll);

  const filterIds = ['concern-filter', 'platform-filter', 'kind-filter', 'status-filter'];
  filterIds.forEach(id => document.getElementById(id).addEventListener('change', applyFilters));
  function applyFilters() {
    const concern = document.getElementById('concern-filter').value;
    const platform = document.getElementById('platform-filter').value;
    const kind = document.getElementById('kind-filter').value;
    const status = document.getElementById('status-filter').value;
    const showSettled = settledBox.checked;
    const boxFilterActive = kind !== 'all' || status !== 'all';
    const markersOn = boxesOn || isolated !== null;
    boxButton.textContent = isolated ? `${isolated}만 표시 중` : boxesOn ? '박스 끄기' : '박스 켜기';
    boxButton.setAttribute('aria-pressed', String(markersOn));
    let visibleRows = 0;
    document.querySelectorAll('.review-row').forEach(row => {
      let visibleBoxes = 0;
      row.querySelectorAll('.box-record').forEach(record => {
        const id = record.dataset.boxId;
        const filterMatch = (kind === 'all' || record.dataset.kind === kind) && (status === 'all' || record.dataset.status === status);
        const visible = filterMatch && (showSettled || !settledStatuses.includes(record.dataset.status));
        record.hidden = !visible;
        if (visible) visibleBoxes++;
        record.querySelector('.table-box-label').setAttribute('aria-pressed', String(isolated === id));
        const markerVisible = isolated ? isolated === id : markersOn && filterMatch && (showSettled || record.dataset.status === 'open');
        row.querySelectorAll('.box-marker').forEach(marker => {
          if (marker.dataset.boxId === id) marker.hidden = !markerVisible;
        });
      });
      const match = (concern === 'all' || row.dataset.concern === concern)
        && (platform === 'all' || row.dataset.platform === platform)
        && (!boxFilterActive || visibleBoxes > 0);
      row.hidden = !match;
      if (match) visibleRows++;
    });
    document.querySelectorAll('.concern-section').forEach(section => {
      const concernMatch = concern === 'all' || section.dataset.concernSection === concern;
      section.hidden = !concernMatch || ![...section.querySelectorAll('.review-row')].some(row => !row.hidden);
    });
    document.querySelector('.no-results').hidden = visibleRows !== 0;
    placeAll();
  }
  applyFilters();
})();
