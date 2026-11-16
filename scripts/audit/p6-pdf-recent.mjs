import fs from 'node:fs';
import path from 'node:path';
import { runProbe, withPage, json, clean, visibleText, JOBS, OUT } from './lib/harness.mjs';

async function pdfText(file) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), useSystemFonts: false, isEvalSupported: false, verbosity: 0 }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++) text += (await (await doc.getPage(i)).getTextContent()).items.map(it => it.str).join(' ') + '\n';
  return { pages: doc.numPages, text: text.replace(/\s+/g, ' ') };
}

const enabledDownloadControls = page => page.evaluate(() => [...document.querySelectorAll('#view-job button, #view-job a')]
  .filter(b => /download pdf/i.test(b.innerText) && !b.disabled && b.getAttribute('aria-disabled') !== 'true')
  .filter(b => { const r = b.getBoundingClientRect(); const s = getComputedStyle(b); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden'; })
  .map(b => b.id || b.innerText.trim()));

await runProbe('p6-pdf-recent', async ({ rec, step, srv, browser }) => {
  await step('PDF with CDN blocked', async () => {
    await withPage(browser, {}, async ({ page, errors, dialogs, external }) => {
      await page.goto(srv.base + '#/job/job_complete');
      await page.waitForSelector('#jobBarDownloadBtn', { state: 'visible' });
      let dl = null; page.on('download', d => { dl = d; });
      await page.click('#jobBarDownloadBtn');
      await page.waitForFunction(() => (document.getElementById('jobExportNotice')?.innerText || '').trim(), null, { timeout: 15000 }).catch(() => {});
      const notice = await visibleText(page, '#jobExportNotice');
      const st = await page.evaluate(() => ({
        role: document.querySelector('#jobExportNotice [role=alert]') ? 'alert' : null,
        retry: !!document.querySelector('#jobExportNotice [data-pdf-retry]'),
        barEnabled: !document.getElementById('jobBarDownloadBtn').disabled,
        jspdf: typeof window.jspdf,
      }));
      rec.check('PDF with CDN blocked', { download: !!dl, dialogs: dialogs.length, notice, ...st, blockedHosts: [...new Set(external.map(u => new URL(u).hostname))] },
        'no download, no dialog; visible inline alert with a Retry button; Download stays enabled',
        !dl && dialogs.length === 0 && !!notice && st.role === 'alert' && st.retry && st.barEnabled, clean(errors));
    });
  });

  const pdfCases = [
    ['job_complete', 'Calloway Minerals LP'],
    ['job_defect', 'Mortgage never released'],
    ['job_over', 'Heirs of A. Roe'],
    ['job_fallback', 'prose instead of the required sections'],
    ['job_partial', 'Harlan Pettibone'],
  ];
  for (const [id, needle] of pdfCases) {
    await step('PDF ' + id, async () => {
      await withPage(browser, { allowCdn: true }, async ({ page, errors, dialogs }) => {
        await page.goto(srv.base + '#/job/' + id);
        await page.waitForSelector('#jobBarDownloadBtn', { state: 'visible', timeout: 60000 });
        const t0 = Date.now();
        const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }).catch(() => null), page.click('#jobBarDownloadBtn')]);
        const observed = { download: !!dl, dialogs: dialogs.length, notice: await visibleText(page, '#jobExportNotice') };
        let pass = false;
        if (dl) {
          const f = path.join(OUT, `pdf-${id}.pdf`);
          await dl.saveAs(f);
          const head = fs.readFileSync(f).subarray(0, 5).toString();
          const { pages, text } = await pdfText(f);
          Object.assign(observed, { file: dl.suggestedFilename(), bytes: fs.statSync(f).size, ms: Date.now() - t0, head, pages, hasNeedle: text.includes(needle) });
          if (id === 'job_partial') observed.mentionsFailedDocs = /fail|omitted|incomplete/i.test(text);
          pass = head === '%PDF-' && pages > 0 && observed.hasNeedle && /\.pdf$/i.test(dl.suggestedFilename()) && dialogs.length === 0 && !observed.notice
            && (id !== 'job_partial' || observed.mentionsFailedDocs);
        }
        rec.check('PDF ' + id, observed, `a PDF file containing "${needle}"${id === 'job_partial' ? ' and the failed-document warning' : ''}; no dialog or error notice`, pass, clean(errors));
      });
    });
  }

  await step('PDF 2MB opinion', async () => {
    const base = JOBS.job_complete.result.finalTitleOpinion;
    let big = base;
    while (big.length < 2_000_000) big += '\n\n' + base.replace(/^# /m, '## Appendix ');
    const over = [[u => u.pathname === '/api/jobs/job_complete/result', r => json(r, 200, { result: { finalTitleOpinion: big, warnings: [], failedDocuments: [] } })]];
    await withPage(browser, { allowCdn: true, overrides: over }, async ({ page, errors, dialogs }) => {
      await page.goto(srv.base + '#/job/job_complete');
      await page.waitForSelector('#jobBarDownloadBtn', { state: 'visible', timeout: 60000 });
      const t0 = Date.now();
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 150000 }).catch(() => null), page.click('#jobBarDownloadBtn')]);
      const ms = Date.now() - t0;
      let bytes = 0;
      let head = '';
      if (dl) { const f = path.join(OUT, 'pdf-job_complete-2mb.pdf'); await dl.saveAs(f); bytes = fs.statSync(f).size; head = fs.readFileSync(f).subarray(0, 5).toString(); }
      rec.check('PDF 2MB opinion', { download: !!dl, bytes, head, ms, dialogs: dialogs.length }, 'a non-empty PDF file, no dialog (duration is recorded, not asserted: it includes the jsPDF download)', !!dl && head === '%PDF-' && bytes > 0 && dialogs.length === 0, clean(errors));
    });
  });

  await step('PDF controls while result is missing', async () => {
    const over = [[u => u.pathname === '/api/jobs/job_complete/result', r => json(r, 404, { error: 'No result.' })]];
    await withPage(browser, { allowCdn: true, overrides: over }, async ({ page, errors, dialogs }) => {
      let dl = null; page.on('download', d => { dl = d; });
      await page.goto(srv.base + '#/job/job_complete');
      await page.waitForSelector('#jobResults .rd-unavailable', { state: 'visible', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1000);
      const header = await page.evaluate(() => {
        const b = document.getElementById('jobDownloadPdfBtn');
        if (!b) return { present: false };
        const r = b.getBoundingClientRect();
        return { present: true, rendered: r.width > 0 && r.height > 0 && getComputedStyle(b).visibility !== 'hidden', disabled: b.disabled, ariaDisabled: b.getAttribute('aria-disabled'), why: b.title || '' };
      });
      const bar = await page.evaluate(() => { const b = document.getElementById('jobBarDownloadBtn'); const r = b?.getBoundingClientRect(); return { rendered: !!r && r.width > 0 && r.height > 0 }; });
      const enabled = await enabledDownloadControls(page);
      const explanation = await visibleText(page, '#jobResults .rd-unavailable');
      const retry = await page.locator('#jobResults .rd-unavailable button', { hasText: /retry/i }).count();
      const headerOk = !header.present || !header.rendered || (header.disabled && header.ariaDisabled === 'true' && !!header.why);
      rec.check('PDF controls while result is missing', { header, barRendered: bar.rendered, enabledDownloadControls: enabled, explanation, retryButtons: retry, download: !!dl, dialogs: dialogs.length },
        'no enabled Download PDF; header button hidden or disabled with a reason; visible "result unavailable" explanation with Retry; no download, no dialog',
        enabled.length === 0 && headerOk && !!explanation && retry === 1 && !dl && dialogs.length === 0, clean(errors));
    });
  });

  const KEY = 'title-analyzer:recent-jobs:v1';
  const now = Date.now();
  const mk = (i, extra = {}) => ({ id: `job_x${i}`, tractDescription: `Tract ${i}`, status: 'complete', documentCount: 3, lastViewedAt: now - i * 1000, ...extra });
  const seedScript = ([k, v]) => { try { localStorage.setItem(k, v); } catch {} };
  async function recent(name, seed, verdict, { init, hash = '#/jobs' } = {}) {
    await step(name, async () => {
      const inits = [];
      if (init) inits.push(init);
      await withPage(browser, { init: inits }, async ({ page, errors }) => {
        if (seed !== undefined) await page.addInitScript(seedScript, [KEY, seed]);
        await page.goto(srv.base + hash);
        await page.waitForTimeout(900);
        const st = await page.evaluate(() => {
          const vis = el => !!el && el.getBoundingClientRect().height > 0 && getComputedStyle(el).display !== 'none';
          return {
            rows: document.querySelectorAll('#view-history .recent-jobs-row').length,
            emptyShown: vis(document.querySelector('#view-history .recent-jobs-empty')),
            text: document.getElementById('view-history').innerText.replace(/\s+/g, ' ').slice(0, 140),
            xss: window.__xss === 1, imgs: document.querySelectorAll('#view-history img').length,
            toolbarDisabled: document.getElementById('recentJobsButton')?.getAttribute('aria-disabled') ?? null,
            toolbarVisible: vis(document.getElementById('recentJobsButton')),
            count: document.getElementById('recentJobsCount')?.innerText ?? null,
          };
        });
        const [pass, expected] = verdict(st);
        rec.check(name, st, expected, pass, clean(errors));
      });
    });
  }
  const empty = s => [s.rows === 0 && s.emptyShown, 'empty state shown, no rows, no crash'];
  await recent('recent: corrupt JSON', '{not json', empty);
  await recent('recent: JSON is an object', '{"a":1}', empty);
  await recent('recent: storage throws', undefined, empty, { init: () => { Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('denied', 'SecurityError'); } }); } });
  await recent('recent: 35 stored jobs', JSON.stringify(Array.from({ length: 35 }, (_, i) => mk(i))), s => [s.rows === 20, '20 rows max (limit 20)']);
  await recent('recent: HTML in stored name', JSON.stringify([mk(1, { tractDescription: '<img src=x onerror="window.__xss=1">Tract & "Q"' })]), s => [!s.xss && s.imgs === 0 && /<img src=x/.test(s.text) && /Tract &/.test(s.text), 'name shown as text, no element injected']);
  await recent('recent: entry without lastViewedAt (older format)', JSON.stringify([{ id: 'job_complete', tractDescription: 'Old entry', status: 'complete', documentCount: 2 }]), s => [s.rows === 0 && s.emptyShown, 'entry without a timestamp ignored; empty state, no crash']);
  await recent('recent: running job only -> toolbar', JSON.stringify([mk(1, { status: 'abstracting' })]), s => [s.toolbarVisible && s.toolbarDisabled === 'true', 'home toolbar shown but locked (aria-disabled) until a completed job exists'], { hash: '#/' });
  await recent('recent: running job only -> #/jobs', JSON.stringify([mk(1, { status: 'abstracting' })]), s => [s.rows === 1, 'the job is still listed on #/jobs']);
  await recent('recent: NaN documentCount', JSON.stringify([mk(1, { documentCount: 'abc' })]), s => [s.rows === 1 && /\b0 documents\b/.test(s.text), 'row listed with 0 documents']);

  await step('recent: entry that now 404s', async () => {
    await withPage(browser, {}, async ({ page, errors }) => {
      await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [KEY, JSON.stringify([mk(1, { id: 'job_gone', tractDescription: 'Deleted on server' })])]);
      await page.goto(srv.base + '#/jobs');
      await page.click('.recent-jobs-row a');
      await page.waitForTimeout(1200);
      const jobView = (await visibleText(page, '#view-job')).slice(0, 120);
      await page.evaluate(() => { location.hash = '#/jobs'; });
      await page.waitForSelector('#recentJobsRefreshBtn');
      await page.click('#recentJobsRefreshBtn');
      await page.waitForFunction(() => !document.getElementById('recentJobsRefreshBtn')?.disabled, null, { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(300);
      const marked = await page.evaluate(() => ({
        rows: document.querySelectorAll('#view-history .recent-jobs-row').length,
        missing: document.querySelectorAll('#view-history .recent-jobs-row--missing').length,
        badge: document.querySelector('#view-history .recent-jobs-row .status-badge')?.innerText || '',
        remove: document.querySelectorAll('#view-history [data-recent-remove]').length,
      }));
      if (marked.remove) await page.click('#view-history [data-recent-remove]');
      await page.waitForTimeout(300);
      const rowsAfterRemove = await page.locator('#view-history .recent-jobs-row').count();
      const stored = await page.evaluate(k => JSON.parse(localStorage.getItem(k) || '[]').length, KEY);
      rec.check('recent: entry that now 404s', { jobView, ...marked, rowsAfterRemove, stored },
        'job view says it cannot be found; Refresh marks the row missing; Remove clears it from the list and storage',
        !!jobView && marked.missing === 1 && marked.remove === 1 && rowsAfterRemove === 0 && stored === 0, clean(errors));
    });
  });

  await step('recent: list status vs server truth', async () => {
    await withPage(browser, {}, async ({ page, errors }) => {
      await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [KEY, JSON.stringify([mk(1, { id: 'job_complete', status: 'abstracting', tractDescription: 'NW/4 stale' })])]);
      await page.goto(srv.base + '#/jobs');
      await page.waitForTimeout(800);
      const badge = () => page.evaluate(() => document.querySelector('#view-history .recent-jobs-row .status-badge')?.innerText.trim() || '');
      const before = await badge();
      await page.click('#recentJobsRefreshBtn');
      await page.waitForFunction(() => !document.getElementById('recentJobsRefreshBtn')?.disabled, null, { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(300);
      const after = await badge();
      rec.check('recent: list status vs server truth', { before, after },
        'stale status labeled as last seen; after Refresh the badge shows the server status (no longer processing)',
        /last seen/i.test(before) && !/last seen/i.test(after) && !/reading|process|abstract|building/i.test(after) && !!after, clean(errors));
    });
  });
});
