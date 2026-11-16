import path from 'node:path';
import { runProbe, withPage, fileObjs, measure, fullShot, clean, visibleText, READ_GATE, OUT } from './lib/harness.mjs';

const anims = page => page.evaluate(() => document.getAnimations().map(a => {
  const t = a.effect?.getTiming?.() || {};
  const tgt = a.effect?.target;
  const cls = tgt ? String(tgt.className || '') : '';
  return {
    name: a.animationName || a.transitionProperty || a.constructor.name,
    target: tgt ? (tgt.id || cls.split(' ')[0] || tgt.tagName) : '?',
    pseudo: a.effect?.pseudoElement || '',
    spinner: /(^|\s)(spinner|step-spinner)(\s|$)/.test(cls),
    duration: Math.round((+t.duration || 0) * 100) / 100,
    iterations: t.iterations,
  };
}));
const fmt = list => list.map(a => `${a.name}@${a.target}${a.pseudo}:${a.duration}ms x${a.iterations}`);

const intake = page => page.evaluate(() => {
  const btn = document.getElementById('analyzeBtn');
  const prog = document.getElementById('intakeProgress');
  const bar = document.getElementById('stageBar');
  const rendered = el => !!el && !el.hidden && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0;
  return {
    rows: document.querySelectorAll('#fileList .file-item').length,
    duplicates: document.querySelectorAll('#fileList .file-item.is-attn').length,
    buildDisabled: btn.disabled,
    buildCount: document.getElementById('analyzeBtnCount').textContent,
    progressShown: rendered(prog) && !!(prog.innerText || '').trim(),
    progressRole: prog?.getAttribute('role') || null,
    stageBarShown: rendered(bar),
    stageBarReading: !!bar?.classList.contains('is-reading'),
    stageBarText: (document.getElementById('stageBarText')?.innerText || '').trim(),
  };
});

await runProbe('motion-reflow', async ({ rec, step, srv, browser }) => {
  const seen = {};
  for (const rm of ['no-preference', 'reduce']) {
    await step(`motion ${rm}`, async () => {
      await withPage(browser, { motion: rm, device: { viewport: { width: 1280, height: 860 } } }, async ({ page, errors }) => {
        await page.goto(srv.base);
        await page.waitForSelector('#view-home', { state: 'visible' });
        await page.waitForTimeout(30);
        const onload = await anims(page);
        await page.setInputFiles('#fileInput', fileObjs(6));
        await page.waitForSelector('#fileList .file-item');
        await page.waitForTimeout(20);
        const afterStage = await anims(page);
        await page.waitForFunction(() => !document.getElementById('analyzeBtn').disabled, null, { timeout: 10000 });
        await page.route('**/api/jobs', () => {});
        await page.click('#analyzeBtn');
        await page.waitForSelector('#progressSection', { state: 'visible' });
        await page.evaluate(() => updateProgress(30, 'Abstracted 2 of 6 documents...', [{ label: 'a.pdf', status: 'done' }, { label: 'b.pdf', status: 'active' }, { label: 'Synthesize', status: 'pending' }]));
        await page.waitForTimeout(600);
        const processing = await anims(page);
        seen[rm] = { onload, afterStage, processing };
        const all = [...onload, ...afterStage, ...processing];
        if (rm === 'reduce') {
          const moving = all.filter(a => !a.spinner && (a.duration > 1 || a.iterations !== 1));
          const spinning = processing.filter(a => a.spinner && a.duration > 100 && a.iterations === Infinity);
          rec.check('reduced motion: only the busy spinner animates', { onload: fmt(onload), afterStage: fmt(afterStage), processing: fmt(processing), moving: fmt(moving), spinning: fmt(spinning) },
            'every non-spinner animation/transition collapsed to <= 1 ms, one iteration; the busy spinner still loops', moving.length === 0 && spinning.length > 0, clean(errors));
        } else {
          const decorative = all.filter(a => !a.spinner && a.duration > 100);
          rec.check('no-preference: decorative motion present', { onload: fmt(onload), afterStage: fmt(afterStage), processing: fmt(processing) },
            'at least one non-spinner animation longer than 100 ms (staged rows or processing)', decorative.length > 0, clean(errors));
        }
      });
    });
  }

  for (const [w, h] of [[640, 430], [320, 256]]) {
    await step(`reflow-${w}`, async () => {
      await withPage(browser, { device: { viewport: { width: w, height: h } }, init: READ_GATE }, async ({ page, errors }) => {
        await page.goto(srv.base);
        await page.waitForSelector('#view-home', { state: 'visible' });
        await page.setInputFiles('#fileInput', [{ name: '001_Warranty_Deed_Vane_to_Pettibone_Book_412_Page_88_recorded_1948.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF\n') }, ...fileObjs(4, { start: 2 })]);
        await page.waitForFunction(() => document.querySelectorAll('#fileList .file-item').length === 5 && !document.getElementById('analyzeBtn').disabled, null, { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(200);
        const settled = { ...(await intake(page)), ...(await measure(page)) };
        await fullShot(page, path.join(OUT, `reflow-${w}.png`));
        rec.check(`reflow ${w}px: 5 staged`, settled, 'no horizontal overflow, nothing past the right edge; 5 rows; Build enabled with (5); stage bar shown, not reading',
          settled.overflowX <= 0 && settled.pastRightEdge.length === 0 && settled.rows === 5 && !settled.buildDisabled && settled.buildCount === '(5)' && settled.stageBarShown && !settled.stageBarReading, clean(errors));

        await page.evaluate(() => window.__closeReadGate());
        await page.setInputFiles('#fileInput', fileObjs(2, { start: 6 }));
        await page.waitForFunction(() => !document.getElementById('intakeProgress').hidden, null, { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(200);
        const pending = { ...(await intake(page)), ...(await measure(page)) };
        await page.screenshot({ path: path.join(OUT, `reflow-${w}-pending.png`) });
        await fullShot(page, path.join(OUT, `reflow-${w}-pending-full.png`));
        rec.check(`reflow ${w}px: pending read`, pending, 'Build disabled; progress status shown; stage bar in reading state; earlier 5 rows kept; no overflow',
          pending.buildDisabled && pending.progressShown && pending.stageBarShown && pending.stageBarReading && pending.rows === 5 && pending.overflowX <= 0 && pending.pastRightEdge.length === 0, clean(errors));

        await page.evaluate(() => window.__openReadGate());
        await page.waitForFunction(() => document.getElementById('analyzeBtnCount').textContent === '(7)' && !document.getElementById('analyzeBtn').disabled, null, { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(200);
        const after = { ...(await intake(page)), ...(await measure(page)) };
        await fullShot(page, path.join(OUT, `reflow-${w}-after-full.png`));
        rec.check(`reflow ${w}px: after read`, after, 'Build enabled with (7); progress hidden; 7 rows, none duplicate; no overflow',
          !after.buildDisabled && after.buildCount === '(7)' && !after.progressShown && !after.stageBarReading && after.rows === 7 && after.duplicates === 0 && after.overflowX <= 0 && after.pastRightEdge.length === 0, clean(errors));
      });
    });
  }

  await step('intake pending -> settled (12 + 300)', async () => {
    await withPage(browser, { init: READ_GATE }, async ({ page, errors }) => {
      await page.goto(srv.base);
      await page.waitForSelector('#view-home', { state: 'visible' });
      await page.setInputFiles('#fileInput', fileObjs(12));
      await page.waitForFunction(() => document.getElementById('analyzeBtnCount').textContent === '(12)' && !document.getElementById('analyzeBtn').disabled, null, { timeout: 15000 });
      await page.evaluate(() => window.__closeReadGate());
      await page.setInputFiles('#fileInput', fileObjs(300, { start: 13 }));
      await page.waitForFunction(() => !document.getElementById('intakeProgress').hidden, null, { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(300);
      const pending = await intake(page);
      pending.progressText = await visibleText(page, '#intakeProgress');
      pending.badgeAtPending = (await page.locator('#stagedBadge').innerText()).trim();
      await page.screenshot({ path: path.join(OUT, 'during-read-w1280.png') });
      rec.check('intake pending (12 staged + 300 reading)', pending, 'Build disabled; progress status shown; stage bar reading; the 12 staged rows stay listed',
        pending.buildDisabled && pending.progressShown && pending.progressRole === 'status' && pending.stageBarReading && pending.rows === 12 && pending.buildCount === '(12)', clean(errors));

      const t0 = Date.now();
      await page.evaluate(() => window.__openReadGate());
      await page.waitForFunction(() => document.getElementById('analyzeBtnCount').textContent === '(312)' && !document.getElementById('analyzeBtn').disabled, null, { timeout: 120000 }).catch(() => {});
      const settled = await intake(page);
      settled.readMs = Date.now() - t0;
      settled.homeStatus = (await page.locator('#homeStatus').textContent()).trim();
      await page.screenshot({ path: path.join(OUT, 'after-read-w1280.png') });
      rec.check('intake settled (312)', settled, 'Build enabled with (312); progress hidden; 312 rows listed, none duplicate; stage bar not reading',
        !settled.buildDisabled && settled.buildCount === '(312)' && !settled.progressShown && settled.rows === 312 && settled.duplicates === 0 && !settled.stageBarReading, clean(errors));
    });
  });
});
