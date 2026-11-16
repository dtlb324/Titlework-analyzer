const short = value => (typeof value === 'string' ? value : JSON.stringify(value));

export function formatRow(row) {
  const errs = row.errors.length ? row.errors.join(' // ').slice(0, 300) : '-';
  return `${row.pass ? 'PASS' : 'FAIL'} ${row.name} | ${short(row.observed)} | ${short(row.expected)} | ${errs}`;
}

export function createRecorder(probe, { log = console.log } = {}) {
  const rows = [];
  const add = row => { rows.push(row); log(formatRow(row)); return row; };
  return {
    rows,
    check(name, observed, expected, pass, errors = []) {
      const errs = [...errors];
      return add({ name, observed, expected, pass: pass === true && !errs.some(e => e.startsWith('pageerror:')), errors: errs });
    },
    crash(name, err) {
      return add({ name, observed: 'crashed', expected: 'probe runs to completion', pass: false, errors: [String(err?.stack || err).split('\n').slice(0, 3).join(' ')] });
    },
    summary() {
      const passed = rows.filter(r => r.pass).length;
      return { probe, total: rows.length, passed, failed: rows.length - passed, rows };
    },
  };
}

export function exitCodeFor(summaries) {
  if (!summaries.length) return 1;
  return summaries.every(s => s.total > 0 && s.failed === 0) ? 0 : 1;
}
