const IDENTITY_FIELDS = ['GRANTOR', 'GRANTEE', 'DATE EXECUTED', 'DATE RECORDED', 'RECORDING REF'];
const OPTIONAL_FIELDS = ['LEGAL DESC', 'FRACTION CONVEYED', 'RESERVATIONS'];
const MONTHS = {
  jan: 'january', feb: 'february', mar: 'march', apr: 'april', jun: 'june',
  jul: 'july', aug: 'august', sep: 'september', oct: 'october', nov: 'november', dec: 'december',
};
const ABSTAIN = /illegible|not visible|verify manually|unclear|^n\/a$|^none$|^none stated$|not applicable/i;

export function normalizeForMatch(value) {
  if (typeof value !== 'string') return '';
  return value
    .toLowerCase()
    .replace(/\b(\d+)(st|nd|rd|th)\b/g, '$1')
    .replace(/\b(jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b/g, month => MONTHS[month])
    .replace(/a\.d\./g, '')
    .replace(/\bvolume\b/g, 'vol')
    .replace(/\bpg\b/g, 'page')
    .replace(/[.,;:'"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function modelFailed(model) {
  return typeof model?.error === 'string' && model.error.length > 0;
}

function consider(model, name, required, haystack, tally) {
  const raw = model?.fields?.[name];
  if (typeof raw !== 'string' || raw.trim() === '') {
    if (required) tally.scored += 1;
    return;
  }
  if (ABSTAIN.test(raw.trim())) return;
  tally.scored += 1;
  const needle = normalizeForMatch(raw);
  if (needle && haystack.includes(needle)) tally.matched += 1;
}

export function scoreModel(documentText, model) {
  if (typeof documentText !== 'string' || documentText.trim() === '') return { status: 'none', reason: 'no-document-text' };
  if (modelFailed(model)) return { status: 'none', reason: 'model-failed' };
  const haystack = normalizeForMatch(documentText);
  const tally = { matched: 0, scored: 0 };
  for (const name of IDENTITY_FIELDS) consider(model, name, true, haystack, tally);
  for (const name of OPTIONAL_FIELDS) consider(model, name, false, haystack, tally);
  if (tally.scored === 0) return { status: 'none', reason: 'no-fields' };
  return { status: 'scored', matched: tally.matched, scored: tally.scored, percent: Math.floor(100 * tally.matched / tally.scored) };
}

function rankable(file) {
  return typeof file.documentText === 'string' && file.documentText.trim() !== '' && Array.isArray(file.models) && file.models.every(model => !modelFailed(model));
}

export function assessAccuracy(files) {
  const byFile = new Map();
  const totals = new Map();
  const order = [];
  let documentCount = 0;
  for (const file of files) {
    const models = Array.isArray(file.models) ? file.models.map(model => ({
      id: model.id,
      label: model.label,
      accuracy: scoreModel(file.documentText, model),
    })) : [];
    byFile.set(file.filename, { models });
    if (!rankable(file)) continue;
    documentCount += 1;
    file.models.forEach((model, index) => {
      if (!totals.has(model.id)) {
        totals.set(model.id, { id: model.id, label: model.label, matched: 0, scored: 0 });
        order.push(model.id);
      }
      const accuracy = models[index].accuracy;
      if (accuracy.status !== 'scored') return;
      const total = totals.get(model.id);
      total.matched += accuracy.matched;
      total.scored += accuracy.scored;
    });
  }
  const sorted = order.map(id => ({ ...totals.get(id) })).filter(row => row.scored > 0);
  sorted.sort((a, b) => b.matched * a.scored - a.matched * b.scored);
  let rank = 0;
  let previous = null;
  const rows = sorted.map((row, index) => {
    const tied = previous && previous.matched * row.scored === row.matched * previous.scored;
    if (!tied) rank = index + 1;
    previous = row;
    return { id: row.id, label: row.label, matched: row.matched, scored: row.scored, percent: Math.floor(100 * row.matched / row.scored), rank };
  });
  return { byFile, ranking: { documentCount, fieldCount: rows[0]?.scored ?? 0, rows } };
}
