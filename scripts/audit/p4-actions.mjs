import { runProbe, withPage, json, clean, visibleText, fileObjs } from './lib/harness.mjs';

const ACTION_PATHS = /\/(retry-failed|synthesis\/start|cancel)$/;

function actionRoute(id, mode, next, posts, jobs) {
  return [u => u.pathname.startsWith(`/api/jobs/${id}/`), async r => {
    const req = r.request();
    if (req.method() !== 'POST') return r.fallback();
    const p = new URL(req.url()).pathname;
    posts.push(p.replace(`/api/jobs/${id}`, ''));
    if (!ACTION_PATHS.test(p)) return json(r, 200, { ok: true });
    const status = await mode(r);
    if (status && status < 300 && next) jobs[id].job = { ...jobs[id].job, status: next, updatedAt: new Date().toISOString() };
  }];
}
const ok = async r => { await json(r, 200, { ok: true }); return 200; };
const fail = (status, body) => async r => { await json(r, status, body); return status; };
const html500 = async r => { await r.fulfill({ status: 500, contentType: 'text/html', body: '<h1>bad gateway</h1>' }); return 500; };
const abort = async r => { await r.abort('connectionreset'); return 0; };

async function jobState(page) {
  return page.evaluate(() => {
    const vis = el => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0;
    return {
      hash: location.hash,
      badge: document.querySelector('#jobHeader .status-badge')?.innerText.trim() || '',
      buttons: [...document.querySelectorAll('#jobActions button')].map(b => ({ label: b.innerText.trim(), disabled: b.disabled, visible: vis(b) })),
      reason: (document.querySelector('#jobStatusDetail .job-reason, .job-reason')?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      opinionShown: vis(document.querySelector('#jobResults .rd-dashboard, #jobResults .analysis-card')),
    };
  });
}
const usable = s => s.buttons.length > 0 && s.buttons.every(b => !b.disabled && b.visible);

const SUCCESSOR_UI = {
  abstracting: { badge: 'Reading documents…', controls: ['Cancel job'] },
  synthesizing: { badge: 'Building chain of title…', controls: ['Cancel job'] },
  canceled: { badge: 'Canceled', controls: [] },
};
const showsSuccessor = (s, next) => {
  const want = SUCCESSOR_UI[next];
  const shown = s.buttons.filter(b => b.visible);
  return !!want && s.badge === want.badge && shown.every(b => !b.disabled)
    && want.controls.every(l => shown.some(b => b.label === l))
    && (want.controls.length > 0 || shown.length === 0);
};

await runProbe('p4-actions', async ({ rec, step, srv, browser }) => {
  const cases = [
    ['partial: Retry failed -> 200', 'job_partial', /^Retry 4 failed$/, '/retry-failed', ok, 'abstracting'],
    ['partial: Retry failed -> 409', 'job_partial', /^Retry 4 failed$/, '/retry-failed', fail(409, { error: 'Job is busy.' }), null],
    ['partial: Retry failed -> 500 HTML', 'job_partial', /^Retry 4 failed$/, '/retry-failed', html500, null],
    ['partial: Retry failed -> abort', 'job_partial', /^Retry 4 failed$/, '/retry-failed', abort, null],
    ['partial: Rebuild opinion -> 200', 'job_partial', /rebuild opinion/i, '/synthesis/start', ok, 'synthesizing'],
    ['partial: Rebuild opinion -> 500', 'job_partial', /rebuild opinion/i, '/synthesis/start', fail(500, { error: 'Worker unavailable' }), null],
    ['failed: Retry synthesis -> 200', 'job_failed', /^Retry synthesis$/, '/synthesis/start', ok, 'synthesizing'],
    ['failed: Retry synthesis -> 500', 'job_failed', /^Retry synthesis$/, '/synthesis/start', fail(500, { error: 'Worker unavailable' }), null],
    ['running: Cancel job -> 200', 'job_running', /^Cancel job$/, '/cancel', ok, 'canceled'],
    ['running: Cancel job -> 500', 'job_running', /^Cancel job$/, '/cancel', fail(500, { error: 'Cancel failed' }), null],
  ];
  for (const [name, id, label, endpoint, mode, next] of cases) {
    await step(name, async () => {
      const posts = [];
      await withPage(browser, {}, async ({ page, errors, dialogs, jobs }) => {
        await page.route(...actionRoute(id, mode, next, posts, jobs));
        await page.goto(srv.base + '#/job/' + id);
        await page.waitForSelector('#jobActions button');
        await page.waitForTimeout(300);
        const before = await jobState(page);
        const btn = page.locator('#jobActions button', { hasText: label });
        const found = await btn.count();
        if (found !== 1) {
          rec.check(name, { buttons: before.buttons.map(b => b.label) }, `exactly one action button matching ${label}`, false, clean(errors));
          return;
        }
        await btn.click();
        if (next) await page.waitForFunction(b => document.querySelector('#jobHeader .status-badge')?.innerText.trim() === b, SUCCESSOR_UI[next].badge, { timeout: 5000 }).catch(() => {});
        else await page.waitForFunction(() => (document.getElementById('jobActionError')?.innerText || '').trim(), null, { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(400);
        const after = await jobState(page);
        const actionPosts = posts.filter(p => ACTION_PATHS.test(p));
        const errorText = await visibleText(page, '#jobActionError');
        const observed = { posts, dialogs: dialogs.map(d => d.type), badge: `${before.badge} -> ${after.badge}`, error: errorText, buttons: after.buttons.map(b => b.label + (b.disabled ? '(disabled)' : '')), hash: after.hash };
        const onePost = actionPosts.length === 1 && actionPosts[0] === endpoint;
        const noAlerts = dialogs.every(d => d.type === 'confirm');
        let pass;
        let expected;
        if (next) {
          const want = SUCCESSOR_UI[next];
          expected = `one POST ${endpoint}; badge "${want.badge}"; ${want.controls.length ? `enabled ${want.controls.join(', ')}` : 'no action controls'}; no error line; stays on job`;
          pass = onePost && noAlerts && showsSuccessor(after, next) && !errorText && after.hash === '#/job/' + id;
        } else {
          const stillUsable = usable(after);
          if (stillUsable) {
            await page.locator('#jobActions button', { hasText: label }).click();
            await page.waitForTimeout(800);
          }
          observed.secondClickPosts = posts.filter(p => ACTION_PATHS.test(p)).length;
          expected = `one POST ${endpoint}; visible inline error; status unchanged; controls enabled (second click POSTs again)`;
          pass = onePost && noAlerts && !!errorText && after.badge === before.badge && stillUsable && observed.secondClickPosts === 2;
        }
        rec.check(name, observed, expected, pass, clean(errors));
      });
    });
  }

  await step('partial: Rebuild opinion confirm dismissed', async () => {
    const posts = [];
    await withPage(browser, { dialog: 'dismiss' }, async ({ page, errors, dialogs, jobs }) => {
      await page.route(...actionRoute('job_partial', ok, 'synthesizing', posts, jobs));
      await page.goto(srv.base + '#/job/job_partial');
      await page.waitForSelector('#jobActions button');
      await page.waitForTimeout(300);
      const btn = page.locator('#jobActions button', { hasText: /rebuild opinion/i });
      if (await btn.count() !== 1) { rec.check('partial: Rebuild opinion confirm dismissed', 'no Rebuild opinion button', 'one Rebuild opinion button', false, clean(errors)); return; }
      await btn.click();
      await page.waitForTimeout(800);
      const s = await jobState(page);
      rec.check('partial: Rebuild opinion confirm dismissed', { posts, dialogs: dialogs.map(d => d.type), opinionShown: s.opinionShown, buttons: s.buttons.map(b => b.label + (b.disabled ? '(disabled)' : '')) },
        'one confirm, no POST, opinion still shown, controls enabled', dialogs.length === 1 && dialogs[0].type === 'confirm' && posts.length === 0 && s.opinionShown && usable(s), clean(errors));
    });
  });

  await step('double click Retry failed', async () => {
    const posts = [];
    const slowOk = async r => { await new Promise(x => setTimeout(x, 800)); await json(r, 200, { ok: true }); return 200; };
    await withPage(browser, {}, async ({ page, errors, jobs }) => {
      await page.route(...actionRoute('job_partial', slowOk, null, posts, jobs));
      await page.goto(srv.base + '#/job/job_partial');
      await page.waitForSelector('#jobActions button');
      await page.locator('#jobActions button', { hasText: /^Retry 4 failed$/ }).dblclick();
      await page.waitForTimeout(1500);
      const s = await jobState(page);
      rec.check('double click Retry failed', { posts, buttons: s.buttons.map(b => b.label + (b.disabled ? '(disabled)' : '')) }, '1 POST; controls enabled afterwards',
        posts.filter(p => ACTION_PATHS.test(p)).length === 1 && usable(s), clean(errors));
    });
  });

  await step('Cancel job from job view keeps staged home files', async () => {
    const posts = [];
    await withPage(browser, {}, async ({ page, errors, dialogs, jobs }) => {
      await page.route(...actionRoute('job_running', ok, 'canceled', posts, jobs));
      await page.goto(srv.base);
      await page.setInputFiles('#fileInput', fileObjs(2));
      await page.waitForFunction(() => document.querySelectorAll('#fileList .file-item').length === 2 && !document.getElementById('analyzeBtn').disabled, null, { timeout: 5000 }).catch(() => {});
      const staged = await page.locator('#fileList .file-item').count();
      await page.evaluate(() => { location.hash = '#/job/job_running'; });
      await page.waitForSelector('#jobActions button');
      const before = await jobState(page);
      await page.locator('#jobActions button', { hasText: /^Cancel job$/ }).click();
      await page.waitForFunction(b => document.querySelector('#jobHeader .status-badge')?.innerText.trim() === b, SUCCESSOR_UI.canceled.badge, { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(300);
      const after = await jobState(page);
      const cancelShown = showsSuccessor(after, 'canceled');
      await page.evaluate(() => { location.hash = '#/'; });
      await page.waitForSelector('#view-home', { state: 'visible' });
      await page.waitForTimeout(300);
      const homeStaged = await page.locator('#fileList .file-item:visible').count();
      const buildEnabled = await page.evaluate(() => !document.getElementById('analyzeBtn').disabled);
      rec.check('Cancel job from job view keeps staged home files',
        { staged, homeStagedAfter: homeStaged, buildEnabled, posts, dialogs: dialogs.map(d => d.type), badge: `${before.badge} -> ${after.badge}`, reason: after.reason, hashAfterCancel: after.hash },
        'one POST /cancel; job view badge "Canceled" with no action controls and stays on the job; home still lists the staged file with Build enabled',
        staged === 2 && homeStaged === staged && buildEnabled && posts.filter(p => ACTION_PATHS.test(p)).join() === '/cancel' && cancelShown && after.hash === '#/job/job_running', clean(errors));
    });
  });

  const patchRoute = (store, mode) => [u => u.pathname === '/api/jobs/job_complete', async r => {
    const req = r.request();
    if (req.method() !== 'PATCH') return r.fallback();
    const body = JSON.parse(req.postData() || '{}');
    store.push(body);
    if (mode === 'ok') return json(r, 200, { job: { id: 'job_complete', status: 'complete', subjectTract: body.subjectTract, totalDocuments: 400, completedDocuments: 400 } });
    if (mode === '409') return json(r, 409, { error: 'Name already used.' });
    if (mode === '500html') return r.fulfill({ status: 500, contentType: 'text/html', body: '<h1>x</h1>' });
    if (mode === 'abort') return r.abort('connectionreset');
  }];
  async function renameCase(name, mode, act, verdict) {
    await step(name, async () => {
      const patches = [];
      await withPage(browser, { overrides: [patchRoute(patches, mode)] }, async ({ page, errors, dialogs }) => {
        await page.goto(srv.base + '#/job/job_complete');
        await page.waitForSelector('#jobRenameBtn');
        const originalTitle = (await page.locator('#jobTitleText').innerText()).trim();
        await page.click('#jobRenameBtn');
        await act(page);
        await page.waitForTimeout(900);
        const st = await page.evaluate(() => ({
          editorOpen: !!document.getElementById('jobNameInput'),
          inputValue: document.getElementById('jobNameInput')?.value ?? null,
          saveDisabled: document.getElementById('jobNameSaveBtn')?.disabled ?? null,
          title: (document.getElementById('jobTitleText')?.innerText || '').trim(),
          xss: window.__xss === 1,
          imgs: document.querySelectorAll('#jobHeader img').length,
          overflowX: document.documentElement.scrollWidth - innerWidth,
        }));
        st.error = await visibleText(page, '#jobNameError');
        st.originalTitle = originalTitle;
        const [pass, expected] = verdict(st, patches, dialogs);
        rec.check(name, { ...st, title: st.title.slice(0, 40), inputValue: st.inputValue?.slice(0, 40) ?? null, patches: patches.length, dialogs: dialogs.length }, expected, pass && dialogs.length === 0, clean(errors));
      });
    });
  }
  const failedSave = (st, pa) => [pa.length === 1 && st.editorOpen && !!st.error && st.saveDisabled === false && st.inputValue === 'X',
    'one PATCH; editor stays open with the typed name; visible inline error; Save enabled; no dialog'];
  await renameCase('rename: Cancel button', 'ok', p => p.click('#jobNameCancelBtn'), (s, pa) => [!s.editorOpen && s.title === s.originalTitle && pa.length === 0, 'editor closes, old title back, no PATCH']);
  await renameCase('rename: Escape key', 'ok', p => p.press('#jobNameInput', 'Escape'), (s, pa) => [!s.editorOpen && s.title === s.originalTitle && pa.length === 0, 'editor closes, old title back, no PATCH']);
  await renameCase('rename: Save valid name', 'ok', async p => { await p.fill('#jobNameInput', 'Renamed Tract A'); await p.click('#jobNameSaveBtn'); }, (s, pa) => [!s.editorOpen && s.title === 'Renamed Tract A' && pa.length === 1, 'one PATCH, editor closes, title = Renamed Tract A']);
  await renameCase('rename: Save via Enter', 'ok', async p => { await p.fill('#jobNameInput', 'Renamed Tract B'); await p.press('#jobNameInput', 'Enter'); }, (s, pa) => [!s.editorOpen && s.title === 'Renamed Tract B' && pa.length === 1, 'one PATCH, editor closes, new title']);
  await renameCase('rename: empty', 'ok', async p => { await p.fill('#jobNameInput', '   '); await p.click('#jobNameSaveBtn'); }, (s, pa) => [pa.length === 0 && s.editorOpen && !!s.error && s.saveDisabled === false, 'no PATCH; editor open with a visible inline error; no dialog']);
  await renameCase('rename: 500 chars', 'ok', async p => { await p.fill('#jobNameInput', 'W'.repeat(500)); await p.click('#jobNameSaveBtn'); }, (s, pa) => [s.overflowX <= 0 && !s.editorOpen && pa.length === 1, 'one PATCH, no horizontal overflow, editor closed']);
  await renameCase('rename: HTML name', 'ok', async p => { await p.fill('#jobNameInput', '"><img src=x onerror="window.__xss=1"> A&B'); await p.click('#jobNameSaveBtn'); }, (s) => [!s.xss && s.imgs === 0 && !s.editorOpen && s.title.includes('<img'), 'shown as text, no element injected, editor closes']);
  await renameCase('rename: PATCH 409', '409', async p => { await p.fill('#jobNameInput', 'X'); await p.click('#jobNameSaveBtn'); }, failedSave);
  await renameCase('rename: PATCH 500 HTML', '500html', async p => { await p.fill('#jobNameInput', 'X'); await p.click('#jobNameSaveBtn'); }, failedSave);
  await renameCase('rename: PATCH abort', 'abort', async p => { await p.fill('#jobNameInput', 'X'); await p.click('#jobNameSaveBtn'); }, failedSave);
  await renameCase('rename: double Save click', 'ok', async p => { await p.fill('#jobNameInput', 'Twice'); await p.dblclick('#jobNameSaveBtn'); }, (s, pa) => [pa.length === 1 && s.title === 'Twice', '1 PATCH, new title']);
});
