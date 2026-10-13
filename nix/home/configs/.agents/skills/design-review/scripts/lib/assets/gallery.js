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

  const filterIds = ['concern-filter', 'platform-filter', 'kind-filter', 'status-filter', 'open-only'];
  filterIds.forEach(id => document.getElementById(id).addEventListener('change', applyFilters));
  function applyFilters() {
    const concern = document.getElementById('concern-filter').value;
    const platform = document.getElementById('platform-filter').value;
    const kind = document.getElementById('kind-filter').value;
    const status = document.getElementById('status-filter').value;
    const openOnly = document.getElementById('open-only').checked;
    const boxFilterActive = kind !== 'all' || status !== 'all';
    let visibleRows = 0;
    document.querySelectorAll('.review-row').forEach(row => {
      let visibleBoxes = 0;
      row.querySelectorAll('.box-record').forEach(record => {
        const visible = (kind === 'all' || record.dataset.kind === kind)
          && (status === 'all' || record.dataset.status === status)
          && (!openOnly || !['resolved', 'accepted'].includes(record.dataset.status));
        record.hidden = !visible;
        if (visible) visibleBoxes++;
        row.querySelectorAll('.box-marker').forEach(marker => {
          if (marker.dataset.boxId === record.dataset.boxId) marker.hidden = !visible;
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
  }
  applyFilters();
})();
