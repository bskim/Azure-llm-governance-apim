import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const publicRoot = new URL('../../app/admin-ui/public/', import.meta.url);

/**
 * Where a screen's markup ends.
 *
 * Counted rather than parsed, because the failure this guards against is a lost
 * opening tag: a parser that repairs the document would report the repaired nesting
 * and agree that everything is fine.
 */
function regionOf(html, startIndex) {
  const opens = /<div[\s>]/gi;
  const closes = /<\/div\s*>/gi;
  let depth = 0;
  let cursor = startIndex;
  while (cursor < html.length) {
    opens.lastIndex = cursor;
    closes.lastIndex = cursor;
    const open = opens.exec(html);
    const close = closes.exec(html);
    if (close === null) return null;
    if (open !== null && open.index < close.index) {
      depth += 1;
      cursor = open.index + 1;
      continue;
    }
    depth -= 1;
    if (depth === 0) return html.slice(startIndex, close.index);
    cursor = close.index + 1;
  }
  return null;
}

test('every screen keeps its own table inside its own screen container', async () => {
  const html = await readFile(new URL('index.html', publicRoot), 'utf8');
  const screens = [...html.matchAll(/<div id="([a-z-]+)-content"/g)].map((match) => match[1]);

  assert.ok(screens.length > 5, 'the console should have more than five screens');

  for (const screen of screens) {
    const start = html.indexOf(`<div id="${screen}-content"`);
    const region = regionOf(html, start);
    assert.ok(region !== null, `${screen}-content is never closed`);

    const bodyId = `id="${screen}-table-body"`;
    if (!html.includes(bodyId)) continue;
    // Outside its container a table shows on every screen at once, which is how the
    // publishing table came to render, empty, under users and groups.
    assert.ok(region.includes(bodyId), `${screen}-table-body sits outside ${screen}-content`);
  }
});
