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
    .replace(/[\u2018\u2019\u201B\u02BC]/g, "'")
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\b(\d+)(st|nd|rd|th)\b/g, '$1')
    .replace(/\b(jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b/g, month => MONTHS[month])
    .replace(/a\.d\./g, '')
    .replace(/\bvolume\b/g, 'vol')
    .replace(/\bpg\b/g, 'page')
    .replace(/[.,;:'"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const WORD = '[\\p{L}\\p{N}]';

function containsField(haystack, needle) {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lead = /^[\p{L}\p{N}]/u.test(needle) ? `(?<!${WORD})(?<!${WORD}-)` : '';
  const trail = /[\p{L}\p{N}]$/u.test(needle) ? `(?!${WORD})(?!-${WORD})` : '';
  return new RegExp(lead + escaped + trail, 'u').test(haystack);
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
  if (needle && containsField(haystack, needle)) tally.matched += 1;
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

const REQUIRED_IDENTITY_FIELDS = ['GRANTOR', 'GRANTEE', 'DATE EXECUTED', 'RECORDING REF', 'LEGAL DESC'];
const DATE_MONTHS = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};
const FULL_MONTH_NAMES = [
  '', 'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
const MONTH_PATTERN = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const ABSTAIN_FIELD_VALUE = /\b(illegible|not visible|verify manually|unclear|unreadable|unknown|not stated|not shown|not given|not legible|cannot be determined|omitted|missing|blank)\b/i;
const ABSTAIN_EXACT_VALUE = /^(n\/a|na|none|none stated|none noted|none specified|not specified|not recorded|unrecorded)$/i;
const NOT_APPLICABLE_VALUE = /^(?:not applicable)(?:\s*(?:\([^)]*\)|[-—:].*))?$/i;
const PLACEHOLDER_ONLY_VALUE = /^(?:\s*\[[^\]]+\]\s*|[-—–_?.]+)$/;
const UNCERTAIN_RECORDED_DATE = /\b(illegible|not visible|verify manually|unclear|unreadable|unknown|not legible)\b/i;
const BILATERAL_DOC_TYPE = /\b(deed|lease|assignment|conveyance|bill of sale|grant)\b/i;
const UNILATERAL_DOC_TYPE = /\b(release|affidavit|notice|order|decree|certificate|plat|termination|revocation|ratification)\b/i;
const NON_CONVEYANCE_DOC_TYPE = /\b(affidavit|order|decree|certificate|plat|notice|release|will|probate|death)\b/i;

export function parseAbstractFields(text) {
  const fields = Object.create(null);
  const cleaned = String(text || '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .replace(/^DOCUMENT\s*#\d+(?:\s*\([^)]*\))?\s*:?\s*/i, '');
  if (!cleaned) return fields;

  let field = null;
  for (const line of cleaned.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || /^```/.test(trimmed)) continue;
    const candidate = trimmed
      .replace(/^(?:[-*•]\s+)/, '')
      .replace(/^\*\*([^*:]+?)\*\*:/, '$1:')
      .replace(/^\*\*([^*:]+?:)\*\*\s*/, '$1 ');
    const match = candidate.match(/^([A-Z][A-Z /-]*[A-Z]):\s*(.*)$/);
    if (match) {
      field = match[1].trim();
      fields[field] = match[2].trim();
    } else if (field) {
      fields[field] = fields[field] ? `${fields[field]}\n${trimmed}` : trimmed;
    }
  }
  return fields;
}

function validCalendarDate(year, month, day) {
  if (!Number.isInteger(year) || year < 1700 || year > 2100) return false;
  if (month !== null && (!Number.isInteger(month) || month < 1 || month > 12)) return false;
  if (day !== null && (!Number.isInteger(day) || day < 1 || day > 31)) return false;
  return true;
}

export function extractCalendarDates(raw) {
  const value = String(raw || '').trim();
  if (!value) return [];

  const matches = [];
  const collect = (regex, extract) => {
    for (const match of value.matchAll(regex)) {
      const parsed = extract(match);
      if (parsed && validCalendarDate(parsed.year, parsed.month, parsed.day)) {
        matches.push({ index: match.index ?? 0, length: match[0].length, ...parsed });
      }
    }
  };

  collect(/\b((?:1[7-9]|20|21)\d{2})[/-](\d{1,2})[/-](\d{1,2})\b/g, m => ({
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
  }));
  collect(/\b(\d{1,2})[/-](\d{1,2})[/-]((?:1[7-9]|20|21)\d{2})\b/g, m => ({
    year: Number(m[3]),
    month: Number(m[1]),
    day: Number(m[2]),
  }));
  collect(
    new RegExp(`\\b(${MONTH_PATTERN})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*,)?\\s+(?:a\\.?\\s*d\\.?\\s*,?\\s*)?((?:1[7-9]|20|21)\\d{2})\\b`, 'gi'),
    m => ({
      year: Number(m[3]),
      month: DATE_MONTHS[m[1].toLowerCase()] ?? null,
      day: Number(m[2]),
    }),
  );
  collect(
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:day\\s+of\\s+)?(${MONTH_PATTERN})\\.?(?:\\s*,)?\\s+(?:a\\.?\\s*d\\.?\\s*,?\\s*)?((?:1[7-9]|20|21)\\d{2})\\b`, 'gi'),
    m => ({
      year: Number(m[3]),
      month: DATE_MONTHS[m[2].toLowerCase()] ?? null,
      day: Number(m[1]),
    }),
  );

  if (matches.length) {
    matches.sort((a, b) => a.index - b.index || b.length - a.length);
    const deduped = [];
    let lastEnd = -1;
    for (const item of matches) {
      if (item.index < lastEnd) continue;
      lastEnd = item.index + item.length;
      deduped.push({ year: item.year, month: item.month, day: item.day });
    }
    return deduped;
  }

  collect(
    new RegExp(`\\b(${MONTH_PATTERN})\\.?(?:\\s*,)?\\s+(?:a\\.?\\s*d\\.?\\s*,?\\s*)?((?:1[7-9]|20|21)\\d{2})\\b`, 'gi'),
    m => ({
      year: Number(m[2]),
      month: DATE_MONTHS[m[1].toLowerCase()] ?? null,
      day: null,
    }),
  );
  if (matches.length) {
    matches.sort((a, b) => a.index - b.index);
    return matches.map(({ year, month, day }) => ({ year, month, day }));
  }

  const bareYear = value.match(/^\s*((?:1[7-9]|20|21)\d{2})\s*$/);
  if (bareYear) {
    const year = Number(bareYear[1]);
    if (validCalendarDate(year, null, null)) {
      return [{ year, month: null, day: null }];
    }
  }
  return [];
}

export function isDateEarlier(recorded, executed) {
  if (!recorded || !executed) return false;
  if (recorded.year !== executed.year) return recorded.year < executed.year;
  if (recorded.month == null || executed.month == null) return false;
  if (recorded.month !== executed.month) return recorded.month < executed.month;
  if (recorded.day == null || executed.day == null) return false;
  return recorded.day < executed.day;
}

function compareDatePrecisionOrder(a, b) {
  return (a.year - b.year) || ((a.month ?? 0) - (b.month ?? 0)) || ((a.day ?? 0) - (b.day ?? 0));
}

function isGroundingAbstention(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return true;
  if (PLACEHOLDER_ONLY_VALUE.test(trimmed)) return true;
  if (ABSTAIN.test(trimmed)) return true;
  if (ABSTAIN_FIELD_VALUE.test(trimmed)) return true;
  if (ABSTAIN_EXACT_VALUE.test(trimmed)) return true;
  if (NOT_APPLICABLE_VALUE.test(trimmed)) return true;
  return false;
}

function normalizeRecordingRef(value) {
  return normalizeForMatch(value)
    .replace(/#/g, ' ')
    .replace(/\b(?:book|bk)\b/g, 'vol')
    .replace(/\b(?:pages|pp|p)\b/g, 'page')
    .replace(/\b(?:instrument|instr|inst|document|doc|reception|clerks?\s+file|file)\b/g, 'inst')
    .replace(/\b(?:number|num|no)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function dateMatchesDocumentText(rawDate, haystack, documentText) {
  const parsed = extractCalendarDates(rawDate);
  for (const date of parsed) {
    if (date.month == null || date.day == null) continue;
    const monthName = FULL_MONTH_NAMES[date.month];
    if (!monthName) continue;
    const phrasings = [
      `${monthName} ${date.day} ${date.year}`,
      `${date.day} day of ${monthName} ${date.year}`,
      `${date.day} ${monthName} ${date.year}`,
    ];
    if (phrasings.some(phrase => containsField(haystack, phrase))) return true;
    const mdy = new RegExp(`(?<!\\d)0?${date.month}[/-]0?${date.day}[/-]${date.year}(?!\\d)`);
    const ymd = new RegExp(`(?<!\\d)${date.year}[/-]0?${date.month}[/-]0?${date.day}(?!\\d)`);
    if (mdy.test(documentText) || ymd.test(documentText)) return true;
  }
  return false;
}

export function scoreAbstractAgainstText(documentText, fields) {
  if (typeof documentText !== 'string' || !documentText.trim()) {
    return { status: 'none', reason: 'no-document-text' };
  }
  const haystack = normalizeForMatch(documentText);
  let refHaystack = null;
  let matched = 0;
  let scored = 0;

  for (const name of IDENTITY_FIELDS) {
    const raw = fields?.[name];
    if (typeof raw !== 'string' || !raw.trim()) continue;
    if (isGroundingAbstention(raw)) continue;

    scored += 1;
    const needle = normalizeForMatch(raw);
    if (needle && containsField(haystack, needle)) {
      matched += 1;
      continue;
    }

    if (name === 'DATE EXECUTED' || name === 'DATE RECORDED') {
      if (dateMatchesDocumentText(raw, haystack, documentText)) {
        matched += 1;
      }
      continue;
    }

    if ((name === 'GRANTOR' || name === 'GRANTEE') && /[;\n]/.test(raw)) {
      const segments = raw
        .split(/[;\n]+/)
        .map(seg => seg.replace(/^(?:[-*•]\s+)/, '').trim())
        .filter(Boolean);
      if (
        segments.length >= 2
        && segments.every(seg => {
          const segNeedle = normalizeForMatch(seg);
          return Boolean(segNeedle) && containsField(haystack, segNeedle);
        })
      ) {
        matched += 1;
      }
      continue;
    }

    if (name === 'RECORDING REF') {
      if (refHaystack === null) refHaystack = normalizeRecordingRef(documentText);
      const refNeedle = normalizeRecordingRef(raw);
      if (refNeedle && containsField(refHaystack, refNeedle)) {
        matched += 1;
      }
    }
  }

  if (scored === 0) return { status: 'none', reason: 'no-fields' };
  return { status: 'scored', matched, scored, percent: Math.floor(100 * matched / scored) };
}

function isFieldAbstained(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return true;
  if (PLACEHOLDER_ONLY_VALUE.test(trimmed)) return true;
  if (ABSTAIN_FIELD_VALUE.test(trimmed)) return true;
  if (ABSTAIN_EXACT_VALUE.test(trimmed)) return true;
  return false;
}

export function validateAbstractQuality(text, options = {}) {
  const { documentText = null, minTextMatchPercent = 65 } = options || {};
  const fields = parseAbstractFields(text);
  const reasons = [];
  const docType = String(fields['DOC TYPE'] || '').trim();
  const isBilateral = BILATERAL_DOC_TYPE.test(docType) && !UNILATERAL_DOC_TYPE.test(docType);

  for (const field of REQUIRED_IDENTITY_FIELDS) {
    const raw = fields[field];
    if (typeof raw !== 'string' || !raw.trim()) {
      reasons.push(`missing_required_field:${field}`);
      continue;
    }
    const trimmed = raw.trim();
    if (NOT_APPLICABLE_VALUE.test(trimmed)) {
      if (field !== 'GRANTEE' || isBilateral) {
        reasons.push(`abstained_required_field:${field}`);
      }
      continue;
    }
    if (isFieldAbstained(trimmed)) {
      reasons.push(`abstained_required_field:${field}`);
    }
  }

  const dateRecorded = fields['DATE RECORDED'];
  if (typeof dateRecorded === 'string' && UNCERTAIN_RECORDED_DATE.test(dateRecorded)) {
    reasons.push('abstained_key_field:DATE RECORDED');
  }

  const executedDates = extractCalendarDates(fields['DATE EXECUTED']);
  const recordedDates = extractCalendarDates(dateRecorded);
  if (executedDates.length && recordedDates.length) {
    const earliestExecuted = executedDates.slice().sort(compareDatePrecisionOrder)[0];
    const latestRecorded = recordedDates.slice().sort(compareDatePrecisionOrder).at(-1);
    if (isDateEarlier(latestRecorded, earliestExecuted)) {
      reasons.push('inverted_dates');
    }
  }

  const minerals = String(fields['MINERALS'] || '').trim();
  if (/^yes\b/i.test(minerals)) {
    const fraction = String(fields['FRACTION CONVEYED'] || '').trim();
    const nonConveyance = NON_CONVEYANCE_DOC_TYPE.test(docType);
    const invalidFraction = !fraction
      || isFieldAbstained(fraction)
      || (NOT_APPLICABLE_VALUE.test(fraction) && !nonConveyance);
    if (invalidFraction) {
      reasons.push('minerals_without_fraction');
    }
  }

  let textMatch = null;
  if (typeof documentText === 'string' && documentText.trim()) {
    textMatch = scoreAbstractAgainstText(documentText, fields);
    if (textMatch.status === 'scored' && textMatch.scored >= 2 && textMatch.percent < minTextMatchPercent) {
      reasons.push('low_text_match');
    }
  }

  return {
    valid: reasons.length === 0,
    reasons,
    fields,
    textMatch,
  };
}
