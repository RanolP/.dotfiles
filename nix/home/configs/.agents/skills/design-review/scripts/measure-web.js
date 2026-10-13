// Usage: set window.__DR_SELECTORS to CSS selectors, then run `agent-browser eval --stdin < scripts/measure-web.js`.
(() => {
  const selectors = window.__DR_SELECTORS;
  if (!Array.isArray(selectors)) throw new Error('set window.__DR_SELECTORS to an array of CSS selectors before running measure-web.js');
  const properties = [
    'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'color', 'background-color',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-top', 'margin-right', 'margin-bottom',
    'margin-left', 'gap', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
    'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'border-radius',
    'width', 'height', 'opacity',
  ];
  return selectors.map(selector => ({
    selector,
    elements: [...document.querySelectorAll(selector)].map(element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        box: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
        computed: Object.fromEntries(properties.map(property => [property, style.getPropertyValue(property)])),
        text: element.textContent.trim(),
      };
    }),
  }));
})()
