import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Renders the page in headless Edge at phone widths and checks nothing is wider than the screen.
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PAGE = pathToFileURL(fileURLToPath(new URL('../index.html', import.meta.url))).href;
const WIDTHS = [320, 360, 375, 390, 414];

function measure() {
  const dir = mkdtempSync(join(tmpdir(), 'ncs-layout-'));
  const harness = join(dir, 'measure.html');
  writeFileSync(harness, `<!doctype html><meta charset="utf-8"><body style="margin:0"><script>
    const widths = ${JSON.stringify(WIDTHS)}; const out = {}; let i = 0;
    function next() {
      if (i >= widths.length) { document.title = JSON.stringify(out); return; }
      const w = widths[i++]; const f = document.createElement('iframe');
      f.style.cssText = 'width:' + w + 'px;height:800px;border:0'; f.src = ${JSON.stringify(PAGE)};
      f.onload = () => setTimeout(() => {
        const d = f.contentDocument, W = f.contentWindow.innerWidth;
        out[w] = { scrollWidth: d.documentElement.scrollWidth, viewport: W,
          over: [...d.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > W + 0.5)
            .map(e => e.tagName.toLowerCase() + (e.className ? '.' + e.className : '')).slice(0, 5) };
        f.remove(); next();
      }, 400);
      document.body.appendChild(f);
    }
    next();
  </script>`);
  const dom = execFileSync(EDGE, ['--headless', '--disable-gpu', '--allow-file-access-from-files',
    '--window-size=520,900', '--virtual-time-budget=8000', '--dump-dom', pathToFileURL(harness).href],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const title = dom.match(/<title>([^<]*)<\/title>/)[1].replace(/&quot;/g, '"');
  return JSON.parse(title);
}

test('no horizontal scroll at common phone widths', { skip: !existsSync(EDGE) && 'Edge not installed' }, () => {
  const results = measure();
  for (const w of WIDTHS) {
    const r = results[w];
    assert.ok(r.scrollWidth <= r.viewport, `${w}px: page is ${r.scrollWidth}px wide; overflowing: ${r.over.join(', ')}`);
    // The overflow-x: clip guard hides overflow from scrollWidth, so also check every element's edge.
    assert.deepEqual(r.over, [], `${w}px: elements past the right edge`);
  }
});
