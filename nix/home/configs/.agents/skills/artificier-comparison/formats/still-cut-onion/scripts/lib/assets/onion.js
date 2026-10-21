(() => {
  const root = document.documentElement;

  // Each onion cell owns its opacity and colour mode, so one row can sit in colour separation while its neighbours stay blended.
  document.querySelectorAll('.onion-controls').forEach(controls => {
    const cell = controls.closest('.onion-cell');
    const slider = controls.querySelector('input[type="range"]');
    const output = controls.querySelector('.onion-value');
    const modeButton = controls.querySelector('.mode-toggle');
    const modeNotice = controls.querySelector('.mode-notice');
    slider?.addEventListener('input', () => {
      cell.style.setProperty('--tobe-opacity', String(Number(slider.value) / 100));
      output.value = `${slider.value}%`;
      output.textContent = `${slider.value}%`;
    });
    modeButton.addEventListener('click', async () => {
      if (cell.dataset.sepBlocked === 'true') {
        modeNotice.hidden = false;
        return;
      }
      const enabled = cell.classList.toggle('color-mode');
      setModeButton(cell, enabled);
      modeNotice.hidden = true;
      if (enabled) await renderSeparation(cell);
    });
  });
  function setModeButton(cell, enabled) {
    const modeButton = cell.querySelector('.mode-toggle');
    modeButton.setAttribute('aria-pressed', String(enabled));
    modeButton.textContent = enabled ? '색 분리 끄기' : '색 분리 켜기';
  }
  document.querySelector('.theme-toggle')?.addEventListener('click', () => {
    root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
  });

  // Red carries the as-is luminance and cyan the to-be luminance: matching pixels read grey, a shift shows as a red/cyan fringe.
  async function renderSeparation(cell) {
    const canvas = cell.querySelector('.sep-canvas');
    if (canvas.dataset.ready === 'true' || canvas.dataset.error) return;
    const left = cell.querySelector('.onion-asis');
    const right = cell.querySelector('.onion-tobe');
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
      // A file:// page taints the canvas, so separation stays off and the notice says why.
      if (error.name === 'SecurityError') {
        cell.dataset.sepBlocked = 'true';
        cell.classList.remove('color-mode');
        setModeButton(cell, false);
        cell.querySelector('.mode-notice').hidden = false;
      }
    }
  }
})();
