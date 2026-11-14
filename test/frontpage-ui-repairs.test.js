// Front page UI repairs from the PR 135 review: sticky-bar focus, completion subtitle,
// phone queue padding, subtitle contrast, dropzone name, Recent Jobs hint reach.
// Behavior runs the real inline script in the VM harness; CSS checks resolve the real stylesheet.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { disposeAll, jsonResponse, loadIndex } from './helpers/browser-index-harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '../public/index.html'), 'utf8');
const SAMPLE = readFileSync(join(here, 'fixtures/title-opinion-sample.md'), 'utf8');
const css = html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, '');

// Flat, ordered rule list: { selectors, decls, media } with media '' for top level.
function parseRules(source) {
  const rules = [];
  const walk = (text, media) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const head = text.slice(i, open).trim();
      let depth = 1, j = open + 1;
      while (depth && j < text.length) { if (text[j] === '{') depth++; else if (text[j] === '}') depth--; j++; }
      const body = text.slice(open + 1, j - 1);
      if (head.startsWith('@media')) walk(body, head);
      else if (!head.startsWith('@')) {
        const decls = {};
        body.split(';').forEach(d => { const k = d.indexOf(':'); if (k > 0) decls[d.slice(0, k).trim()] = d.slice(k + 1).trim(); });
        rules.push({ selectors: head.split(',').map(s => s.trim()), decls, media: media || '' });
      }
      i = j;
    }
  };
  walk(source, '');
  return rules;
}
const RULES = parseRules(css);
const mediaApplies = (media, width) => {
  if (!media) return true;
  if (/prefers-reduced-motion/.test(media)) return false;
  const max = media.match(/max-width:\s*(\d+)px/);
  const min = media.match(/min-width:\s*(\d+)px/);
  return (!max || width <= Number(max[1])) && (!min || width >= Number(min[1]));
};
// Winning value for a property on an element that carries `classes`, among simple class selectors.
function resolveForClasses(classes, prop, width) {
  let best = null;
  RULES.forEach((rule, order) => {
    if (!mediaApplies(rule.media, width) || !(prop in rule.decls)) return;
    rule.selectors.forEach(sel => {
      const m = sel.match(/^(?:\.[\w-]+)+$/);
      if (!m) return;
      const parts = sel.split('.').filter(Boolean);
      if (!parts.every(p => classes.includes(p))) return;
      const spec = parts.length;
      if (!best || spec > best.spec || (spec === best.spec && order >= best.order)) best = { spec, order, value: rule.decls[prop] };
    });
  });
  return best?.value;
}
const declFor = (selector, prop, width) => {
  let value;
  RULES.forEach(rule => { if (mediaApplies(rule.media, width) && rule.selectors.includes(selector) && prop in rule.decls) value = rule.decls[prop]; });
  return value;
};
const token = name => (css.match(new RegExp(`${name.replace(/[-]/g, '\\-')}:\\s*(#[0-9a-fA-F]{3,6})`)) || [])[1];
const resolveColor = v => (v?.startsWith('var(') ? token(v.slice(4, -1).trim()) : v);
const luminance = hex => {
  const h = hex.length === 4 ? hex.slice(1).split('').map(c => c + c).join('') : hex.slice(1);
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const openTag = id => (html.match(new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`)) || [''])[0];
const attr = (tag, name) => (tag.match(new RegExp(`\\s${name}="([^"]*)"`)) || [])[1];

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('U1 sticky focus: a visible follow-up bar reserves scroll padding so focused controls clear it on phones', () => {
  const pad = width => {
    let value;
    RULES.forEach(rule => {
      if (!mediaApplies(rule.media, width) || !('scroll-padding-bottom' in rule.decls)) return;
      if (rule.selectors.some(s => s.startsWith('html') && s.includes('#jobFollowup')) && rule.selectors.some(s => s.includes('#followupSection'))) value = parseFloat(rule.decls['scroll-padding-bottom']);
    });
    return value;
  };
  assert.ok(pad(1280) >= 80, `desktop scroll-padding-bottom under the action bar is ${pad(1280)}`);
  assert.ok(pad(390) >= 140, `phone scroll-padding-bottom must cover the wrapped two-row action bar, got ${pad(390)}`);
});

test('U2 subtitle: a completed analysis replaces the staged-files subtitle, and reset restores the default', () => {
  const app = loadIndex({ fetchImpl: async () => jsonResponse(404, {}) });
  const subtitle = () => app.getEl('homeSubtitle').textContent;
  app.run(`files = [new File(['x'], 'a.pdf', { type: 'application/pdf' }), new File(['y'], 'b.pdf', { type: 'application/pdf' })]; updateStagedSummary();`);
  assert.match(subtitle(), /^2 documents staged/, 'staged state keeps its count');
  app.ctx.__sample = SAMPLE;
  app.run(`conversationHistory = [
    { role: 'user', content: 'x', kind: 'analysis-input' },
    { role: 'assistant', content: __sample, kind: 'title-opinion' },
  ]; renderResults();`);
  assert.doesNotMatch(subtitle(), /staged and ready/, 'completed view must not claim files are still waiting to run');
  assert.match(subtitle(), /Analysis complete/);
  app.run('updateStagedSummary()');
  assert.match(subtitle(), /Analysis complete/, 'a later staged-summary refresh keeps the completed copy');
  app.run('resetHomeForNewJob()');
  assert.match(subtitle(), /^Add optional tract context/, 'reset returns to the empty-state copy');
});

test('U3 queue padding: the staged queue stays edge-to-edge on phones instead of inheriting card padding', () => {
  assert.equal(resolveForClasses(['card', 'queue-box'], 'padding', 1280), '0');
  assert.equal(resolveForClasses(['card', 'queue-box'], 'padding', 390), '0', 'mobile .card padding must not win over .queue-box');
  assert.equal(resolveForClasses(['card'], 'padding', 390), '16px', 'other cards keep their phone padding');
});

test('U4 contrast: the page subtitle meets 4.5:1 on the page background', () => {
  const fg = resolveColor(declFor('.page-head p', 'color', 1280));
  const bg = token('--bg');
  assert.ok(fg && bg, `colors resolved: ${fg} on ${bg}`);
  const ratio = contrast(fg, bg);
  assert.ok(ratio >= 4.5, `subtitle contrast ${ratio.toFixed(2)}:1 (${fg} on ${bg})`);
});

test('U5 dropzone: accessible name comes from its visible button text and the visible copy describes it', () => {
  const zone = openTag('uploadZone');
  assert.equal(attr(zone, 'role'), 'button');
  assert.equal(attr(zone, 'aria-label'), undefined, 'a hidden aria-label overrides the visible "Select Files" text');
  const labelledby = attr(zone, 'aria-labelledby');
  assert.ok(labelledby, 'dropzone must be labelled by visible text');
  labelledby.split(/\s+/).forEach(id => {
    const tag = openTag(id);
    assert.ok(tag, `labelledby target #${id} exists`);
    assert.notEqual(attr(tag, 'aria-hidden'), 'true', `#${id} must not be aria-hidden`);
  });
  assert.match(html.slice(html.indexOf(openTag(labelledby.split(/\s+/)[0]))).slice(0, 200), /Select Files/);
  const describedby = attr(zone, 'aria-describedby');
  assert.ok(describedby && openTag(describedby), 'dropzone description points at the visible drop copy');
});

test('U6 Recent Jobs: the disabled toolbar item stays focusable and hoverable so its hint is reachable', () => {
  const app = loadIndex({ fetchImpl: async () => jsonResponse(404, {}) });
  const button = app.getEl('recentJobsButton');
  button.removeAttribute = k => { delete button[k]; };
  app.run('renderRecentJobsToolbar()');
  assert.equal(button.getAttribute('aria-disabled'), 'true');
  assert.equal(button.getAttribute('href'), null, 'disabled item still has no destination');
  assert.equal(button.getAttribute('tabindex'), '0', 'keyboard users must be able to reach the explanation');
  const tag = openTag('recentJobsButton');
  assert.equal(attr(tag, 'tabindex'), '0', 'initial markup is focusable before script runs');
  assert.equal(attr(tag, 'role'), 'link', 'an <a> without href needs an explicit role for aria-disabled to be announced');
  assert.equal(attr(tag, 'aria-describedby'), 'recentJobsToolbarHint');
  assert.notEqual(declFor('.recent-jobs-toolbar-button--disabled', 'pointer-events', 1280), 'none', 'pointer-events:none blocks hover and tap, so the hint never shows');
  app.run(`localStorage.setItem(RECENT_JOBS_KEY, JSON.stringify([{ id: 'j1', status: 'complete', lastViewedAt: Date.now(), documentCount: 1 }])); renderRecentJobsToolbar();`);
  assert.equal(button.getAttribute('aria-disabled'), 'false');
  assert.equal(button.getAttribute('href'), '#/jobs');
  assert.equal(button.getAttribute('tabindex'), '0');
});

let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    passed++;
    console.log(`✓ ${t.name}`);
  } catch (err) {
    failed++;
    console.log(`✗ ${t.name}\n  ${err.message.split('\n')[0]}`);
  }
}
disposeAll();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
