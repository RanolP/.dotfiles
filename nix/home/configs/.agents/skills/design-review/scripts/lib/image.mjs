const glyphs = Buffer.from([
  '0000000000 00005f0000 0007000700 147f147f14 242a7f2a12 2313086462 3649552250 0005030000 001c224100 0041221c00',
  '082a1c2a08 08083e0808 0050300000 0808080808 0060600000 2010080402 3e5149453e 00427f4000 4261514946 2141454b31',
  '1814127f10 2745454539 3c4a494930 0171090503 3649494936 064949291e 0036360000 0056360000 0008142241 1414141414',
  '4122140800 0201510906 324979413e 7e1111117e 7f49494936 3e41414122 7f4141221c 7f49494941 7f09090101 3e41415132',
  '7f0808087f 00417f4100 2040413f01 7f08142241 7f40404040 7f0204027f 7f0408107f 3e4141413e 7f09090906 3e4151215e',
  '7f09192946 4649494931 01017f0101 3f4040403f 1f2040201f 7f2018207f 6314081463 0304780403 6151494543 00007f4141',
  '0204081020 41417f0000 0402010204 4040404040 0001020400 2054545478 7f48444438 3844444420 384444487f 3854545418',
  '087e090102 081454543c 7f08040478 00447d4000 2040443d00 007f102844 00417f4000 7c0418047c 7c08040478 3844444438',
  '7c14141408 081414187c 7c08040408 4854545420 043f444020 3c4040207c 1c2040201c 3c4030403c 4428102844 0c5050503c',
  '4464544c44 0008364100 00007f0000 0041360800 08082a1c08',
].join(' ').replaceAll(' ', ''), 'hex');

function fillRect(canvas, x, y, w, h, color) {
  for (let py = Math.max(0, y); py < Math.min(canvas.height, y + h); py++) {
    for (let px = Math.max(0, x); px < Math.min(canvas.width, x + w); px++) canvas.pixels.set(color, (py * canvas.width + px) * 3);
  }
}

export function textWidth(text, scale) {
  return text.length * 6 * scale;
}

export function drawText(canvas, text, x, y, scale, color) {
  [...text].forEach((char, index) => {
    const code = char.charCodeAt(0);
    const glyph = code >= 32 && code <= 126 ? glyphs.subarray((code - 32) * 5, (code - 31) * 5) : glyphs.subarray(155, 160);
    for (let column = 0; column < 5; column++) for (let row = 0; row < 7; row++) {
      if (glyph[column] >> row & 1) fillRect(canvas, x + (index * 6 + column) * scale, y + row * scale, scale, scale, color);
    }
  });
}

function blit(canvas, image, x, y, w, h) {
  const sx = image.width / w, sy = image.height / h;
  for (let ty = 0; ty < h; ty++) {
    const y0 = Math.floor(ty * sy), y1 = Math.max(y0 + 1, Math.floor((ty + 1) * sy));
    for (let tx = 0; tx < w; tx++) {
      const x0 = Math.floor(tx * sx), x1 = Math.max(x0 + 1, Math.floor((tx + 1) * sx));
      const sums = [0, 0, 0];
      let count = 0;
      for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) {
        const at = (py * image.width + px) * image.channels;
        const alpha = image.channels === 4 ? image.pixels[at + 3] / 255 : 1;
        for (let c = 0; c < 3; c++) sums[c] += image.pixels[at + c] * alpha + 255 * (1 - alpha);
        count++;
      }
      canvas.pixels.set(sums.map(value => Math.round(value / count)), ((y + ty) * canvas.width + x + tx) * 3);
    }
  }
}

const sheetLimit = 1568;
const cellBox = { w: 300, h: 600 };
const gap = 8, labelScale = 2, labelHeight = 7 * labelScale + 2 * gap;
const colors = { page: [255, 255, 255], text: [20, 24, 30], placeholder: [150, 150, 150], placeholderText: [255, 255, 255] };

function fit(image) {
  if (!image) return { w: cellBox.w, h: Math.round(cellBox.w * 1.5) };
  const scale = Math.min(cellBox.w / image.width, cellBox.h / image.height, 1);
  return { w: Math.max(1, Math.round(image.width * scale)), h: Math.max(1, Math.round(image.height * scale)) };
}

function drawCell(canvas, cell, x, y) {
  const size = fit(cell.image);
  if (cell.image) blit(canvas, cell.image, x, y, size.w, size.h);
  else {
    fillRect(canvas, x, y, size.w, size.h, colors.placeholder);
    drawText(canvas, cell.missing, x + gap, y + gap, labelScale, colors.placeholderText);
  }
}

// rows: [{ label, cells: [{ image: decoded PNG | null, missing: text drawn on the placeholder }] }]
export function composeContactSheets(rows) {
  const width = 2 * cellBox.w + 3 * gap;
  const measured = rows.map(row => ({ ...row, height: labelHeight + Math.max(...row.cells.map(cell => fit(cell.image).h)) + gap }));
  const pages = [];
  for (const row of measured) {
    const page = pages.at(-1);
    if (page && page.height + row.height <= sheetLimit) {
      page.rows.push(row);
      page.height += row.height;
    } else pages.push({ rows: [row], height: gap + row.height });
  }
  return pages.map(page => {
    const canvas = { width, height: page.height, pixels: new Uint8Array(width * page.height * 3) };
    fillRect(canvas, 0, 0, width, page.height, colors.page);
    let y = gap;
    for (const row of page.rows) {
      drawText(canvas, row.label, gap, y + gap, labelScale, colors.text);
      row.cells.forEach((cell, index) => drawCell(canvas, cell, gap + index * (cellBox.w + gap), y + labelHeight));
      y += row.height;
    }
    return canvas;
  });
}
