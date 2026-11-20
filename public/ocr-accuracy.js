const IDENTITY_FIELDS = ['GRANTOR', 'GRANTEE', 'DATE EXECUTED', 'DATE RECORDED', 'RECORDING REF'];
const OPTIONAL_FIELDS = ['LEGAL DESC', 'FRACTION CONVEYED', 'RESERVATIONS'];
const MONTHS = {
  jan: 'january', feb: 'february', mar: 'march', apr: 'april', jun: 'june',
  jul: 'july', aug: 'august', sep: 'september', oct: 'october', nov: 'november', dec: 'december',
};
const ABSTAIN = /illegible|not visible|verify manually|unclear|^n\/a$|^none$|^none stated$|^not stated$|^unrecorded$|not applicable/i;

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
  try {
    return new RegExp(lead + escaped + trail, 'u').test(haystack);
  } catch {
    return false; // a needle too long to compile cannot be a real field value
  }
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
const ILLEGIBLE_MARKER_RE = /ILLEGIBLE\s*[-—]\s*VERIFY MANUALLY/i;
const KEY_ILLEGIBLE_FIELDS = new Set([
  'DOC TYPE',
  'GRANTOR',
  'GRANTEE',
  'DATE EXECUTED',
  'DATE RECORDED',
  'RECORDING REF',
  'LEGAL DESC',
  'MINERALS',
  'ROYALTY/NPRI',
  'FRACTION CONVEYED',
  'RESERVATIONS',
]);
const UNRECORDED_VALUE = /^(?:unrecorded|not recorded)(?:\s*(?:\([^)]*\)|[-—:].*))?$/i;
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
// Read failures: these markers abstain wherever they appear in the value.
const HARD_ABSTAIN_MARKER = /\b(illegible|not visible|verify manually|unreadable|not legible|cannot be determined)\b/i;
// Strong soft words abstain anywhere in the value. "unknown" is handled after party-name phrases are masked.
const STRONG_SOFT_ABSTAIN = /\b(?:unclear|unknown|not stated|not shown|not given|omitted|missing)\b/i;
// A stated year with a missing day or month is a statement; these words describe what is absent.
const ABSENCE_ONLY_SOFT_ABSTAIN = /\b(?:not stated|not shown|not given|omitted|missing)\b/i;
const STATED_YEAR = /\b(?:1[7-9]|20|21)\d{2}\b/;
const DATE_FIELDS = new Set(['DATE EXECUTED', 'DATE RECORDED']);
// "blank" is also an ordinary word (a blank tract), so it abstains only as the status of a short value.
const BLANK_LEADING = /^[\s\[(\-—–:]*blank\b/i;
const BLANK_TRAILING = /(?:^|[-—–:,(\[])\s*(?:[\p{L}]+\s+){0,4}blank[\s)\].]*$/iu;
// "Unknown Heirs of ..." is a party name. Heirs-type nouns qualify when naming text follows;
// owner/party-type nouns only in the "Unknown Owners of <Name>" form.
const UNKNOWN_HEIR_NOUN = '(?:heirs?|devisees?|successors?|assigns?|claimants?|creditors?|beneficiaries|legatees?|lienholders?)';
const UNKNOWN_OWNER_NOUN = '(?:owners?|part(?:y|ies)|persons?|interests?|spouses?|trustees?|lessees?|lessors?)';
const UNKNOWN_PARTY_PHRASE = new RegExp(`\\bunknown\\s+(${UNKNOWN_HEIR_NOUN}|${UNKNOWN_OWNER_NOUN})\\b`, 'gi');
const UNKNOWN_HEIR_ONLY = new RegExp(`^${UNKNOWN_HEIR_NOUN}$`, 'i');
const UNFILLED_BLANK = /(?:_{2,}|\[[\s_.\-]*\]|\.{3,})/g;
const NAMING_STOPWORDS = new Set(['of', 'and', 'or', 'the', 'deceased', 'their', 'his', 'her', 'unknown', 'if', 'any']);
const ABSTAIN_EXACT_VALUE = /^(n\/a|na|none|none stated|none noted|none specified|not specified|not recorded|unrecorded)$/i;
const NOT_APPLICABLE_VALUE = /^(?:not applicable)(?:\s*(?:\([^)]*\)|[-—:].*))?$/i;
const NA_ABBREVIATION_VALUE = /^(?:n\/a|na)\.?$/i;
const NONE_VALUE = /^(?:none|none stated|none noted|none specified)\.?$/i;
const PLACEHOLDER_ONLY_VALUE = /^(?:\s*\[[^\]]+\]\s*|[-—–_?.]+)$/;
const UNCERTAIN_RECORDED_DATE = /\b(illegible|not visible|verify manually|unclear|unreadable|unknown|not legible)\b/i;

// DOC TYPE classes are decided by the earliest instrument noun ("Deed of Release" is a deed),
// and any conveying word makes the instrument conveying whatever its head noun is.
const BILATERAL_NOUNS = /\b(deed|lease|assignment|conveyance|bill of sale|grant)\b/gi;
const NON_LAND_NOUNS = /\b(release|affidavit|notice|order|decree|certificate|plat|termination|revocation|ratification|power of attorney|judgment|will|probate|death|memorandum)\b/gi;
const CONVEYING_WORD = /\b(?:convey\w*|sale|transfer\w*|quitclaim\w*|assign\w*|grant\w*|warranty)\b/i;
// Instruments that do not convey a fraction: leases and security or unit instruments.
const NO_FRACTION_INSTRUMENT = /\b(?:lease|mortgage|deed of trust|lien|declaration of pool\w*|pooling|pooled unit|unit declaration|farm-?out|memorandum)\b/i;
const FRACTION_CONVEYING_NOUN = /\b(?:assignment|deed|conveyance|bill of sale)\b/i;

function firstIndex(regex, text) {
  regex.lastIndex = 0;
  const match = regex.exec(text);
  return match ? match.index : Infinity;
}

function nameBearingText(text) {
  return text.replace(UNFILLED_BLANK, ' ').replace(/\b(?:illegible|verify manually)\b/gi, ' ');
}

function hasNamingText(tail) {
  const words = nameBearingText(tail).match(/[\p{L}\p{N}]+/gu) || [];
  return words.some(word => !NAMING_STOPWORDS.has(word.toLowerCase()));
}

// Mask party-name phrases ("Unknown Heirs of Silas Brooks") so only real abstentions are left.
function maskUnknownParties(value) {
  return value.replace(UNKNOWN_PARTY_PHRASE, (phrase, noun, offset) => {
    const tail = value.slice(offset + phrase.length);
    if (/(?:_{2,}|\[[\s_.\-]*\]|\.{3,}|illegible[\s\]).]*)\s*$/i.test(tail)) return phrase;
    if (UNKNOWN_HEIR_ONLY.test(noun)) return hasNamingText(tail) ? ' ' : phrase;
    return /^\s+of\s+\S/i.test(tail) && hasNamingText(tail) ? ' ' : phrase;
  });
}

function hasSoftAbstention(value, field) {
  const rest = maskUnknownParties(value.replace(/\s+/g, ' ').trim()).replace(/\s+/g, ' ').trim();
  if (!rest) return false;
  if (DATE_FIELDS.has(field) && STATED_YEAR.test(rest)) {
    if (/\b(?:unclear|unknown)\b/i.test(rest)) return true;
    return false;
  }
  if (STRONG_SOFT_ABSTAIN.test(rest)) return true;
  if (!/\bblank\b/i.test(rest)) return false;
  if (BLANK_LEADING.test(rest) || BLANK_TRAILING.test(rest)) return true;
  return rest.split(' ').length <= 4;
}

function isNotApplicableValue(value) {
  return NOT_APPLICABLE_VALUE.test(value) || NA_ABBREVIATION_VALUE.test(value);
}

function isBilateralDocType(docType) {
  if (CONVEYING_WORD.test(docType)) return true;
  return firstIndex(BILATERAL_NOUNS, docType) < firstIndex(NON_LAND_NOUNS, docType);
}

function isNonLandDocType(docType) {
  return !isBilateralDocType(docType) && firstIndex(NON_LAND_NOUNS, docType) < Infinity;
}

// A none/not-applicable fraction is a statement for leases, security and unit instruments and non-land instruments.
function acceptsNoFraction(docType) {
  if (isNonLandDocType(docType)) return true;
  const withoutTrustDeed = docType.replace(/\bdeed of trust\b/gi, ' ');
  return NO_FRACTION_INSTRUMENT.test(docType)
    && !FRACTION_CONVEYING_NOUN.test(withoutTrustDeed)
    && !CONVEYING_WORD.test(withoutTrustDeed);
}

// An explicit "Not applicable" is a statement, not a read failure, when the instrument has no such field.
function acceptsNotApplicable(field, docType) {
  if (field === 'GRANTEE') return !isBilateralDocType(docType);
  if (field === 'GRANTOR' || field === 'LEGAL DESC') return isNonLandDocType(docType);
  return false;
}

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

function isGroundingAbstention(raw, field) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return true;
  if (PLACEHOLDER_ONLY_VALUE.test(trimmed)) return true;
  if (HARD_ABSTAIN_MARKER.test(trimmed)) return true;
  if (hasSoftAbstention(trimmed, field)) return true;
  if (ABSTAIN_EXACT_VALUE.test(trimmed)) return true;
  if (/not applicable/i.test(trimmed)) return true;
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

function twoDigitYearDates(rawDate) {
  const dates = [];
  const regex = /(?<![\d/-])(\d{1,2})[/-](\d{1,2})[/-](\d{2})(?![\d/-])/g;
  for (const match of String(rawDate || '').matchAll(regex)) {
    const month = Number(match[1]);
    const day = Number(match[2]);
    for (const century of [18, 19, 20]) {
      const year = century * 100 + Number(match[3]);
      if (validCalendarDate(year, month, day)) dates.push({ year, month, day });
    }
  }
  return dates;
}

function dateMatchesDocumentText(rawDate, haystack, documentText) {
  const parsed = [...extractCalendarDates(rawDate), ...twoDigitYearDates(rawDate)];
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

// Party names in an abstract carry role tags and capacity phrases the document may word differently.
// Only bounded forms are dropped; anything that names another party stays and is checked against the text.
const MAX_DECORATED_LENGTH = 2000;
const SIMPLE_ROLE = '(?:an?\\s+(?:single|married|unmarried|widowed|divorced|legally separated)?\\s*(?:man|woman|widow|widower|person|individual|minor)|(?:his|her)\\s+(?:wife|husband)|husband\\s+and\\s+wife|wife\\s+and\\s+husband|wife|husband|spouses?|affiant|principal|testator|testatrix|decedent|deceased|(?:successor\\s+)?trustee|executor|executrix|administrator|administratrix)';
const CAPACITY_NOUN = '(?:(?:successor|independent|substitute|special|co)[\\s-]+)*(?:trustee|executor|executrix|administrator|administratrix|guardian|attorney-in-fact|agent|personal\\s+representative)';
const ROLE_TAG = '(?:lessors?|lessees?|assignors?|assignees?|grantors?|grantees?|mortgagors?|mortgagees?|trustors?|beneficiary|beneficiaries|obligors?|obligees?|optionors?|optionees?|borrowers?|lenders?|vendors?|vendees?|sellers?|buyers?|owners?|surviving\\s+spouse|et\\s+ux|et\\s+vir)';
const ROLE_WORD = `(?:the\\s+)?(?:${ROLE_TAG}|${SIMPLE_ROLE}|${CAPACITY_NOUN}|individually)`;
const ROLE_PARENTHETICAL = new RegExp(`^${ROLE_WORD}(?:\\s*(?:,|/|&|and)\\s*${ROLE_WORD})*\\.?$`, 'i');
const ALIAS_PARENTHETICAL = /^(?:a\/k\/a|f\/k\/a|n\/k\/a|aka|fka|also\s+known\s+as|formerly(?:\s+known\s+as)?|now\s+known\s+as)\s+(.+)$/i;
const PARENTHETICAL = /\(([^()]{0,200})\)/g;
const NAME_WORDS = "[\\p{L}][\\p{L}.'\u2019-]*";
const AS_CAPACITY = new RegExp(
  `(?:\\s*,)?\\s+as\\s+(?:the\\s+)?${CAPACITY_NOUN}`
  + `(?:\\s+(?:of|for)\\s+(?:the\\s+)?(?:estate\\s+of\\s+(?<estate>${NAME_WORDS}(?:\\s+(?!and\\b|deceased\\b)${NAME_WORDS}){0,3})`
  + `|(?<trust>(?:(?!and\\b)${NAME_WORDS}\\s+){0,5}?(?:trust|estate|will)\\b)))?`,
  'giu',
);
const INDIVIDUALLY = /(?:\s*,)?\s+individually\b(?:\s+and(?=\s+as\b))?/gi;
const CAPACITY_CLAUSE = new RegExp(`\\s*,\\s*${SIMPLE_ROLE}\\s*\\.?\\s*$`, 'i');
const ET_ABBREVIATION = /,?\s+et\s+(?:ux|al|vir)\.?/gi;
const LEADING_SPOUSE = /^(?:and\s+)?(?:(?:his|her)\s+)?(?:wife|husband)\s*,?\s+/i;
const PARTY_SEPARATOR = /\s+and\s+|\s*&\s*/i;

// Returns the bare name plus what the document must also contain: named entities (a trust, an estate,
// an unexplained parenthetical) and, separately, aliases where either spelling is enough.
function stripPartyDecorations(raw) {
  let value = String(raw || '').replace(/\s+/g, ' ').trim();
  const requires = [];
  const aliases = [];
  if (value.length > MAX_DECORATED_LENGTH) return { name: value, requires, aliases };

  value = value.replace(PARENTHETICAL, (_, inner) => {
    const text = inner.trim();
    if (!text || ROLE_PARENTHETICAL.test(text)) return ' ';
    const alias = text.match(ALIAS_PARENTHETICAL);
    if (alias) aliases.push(alias[1].trim());
    else requires.push(text);
    return ' ';
  });
  value = value.replace(INDIVIDUALLY, ' ');
  value = value.replace(AS_CAPACITY, (...args) => {
    const groups = args.at(-1);
    const entity = groups.estate || groups.trust;
    if (entity) requires.push(entity.replace(/^the\s+/i, ''));
    return ' ';
  });
  value = value.replace(ET_ABBREVIATION, ' ').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3; i += 1) {
    const next = value.replace(/[,;]+$/, '').replace(CAPACITY_CLAUSE, '').replace(LEADING_SPOUSE, '').trim();
    if (next === value) break;
    value = next;
  }
  return { name: value.replace(/[,;]+$/, '').trim(), requires, aliases };
}

function nameInText(name, haystack) {
  const needle = normalizeForMatch(name);
  return Boolean(needle) && containsField(haystack, needle);
}

function decoratedPresent(decorated, haystack) {
  if (!decorated.requires.every(required => nameInText(required, haystack))) return false;
  return nameInText(decorated.name, haystack) || decorated.aliases.some(alias => nameInText(alias, haystack));
}

function partyNamePresent(part, haystack) {
  return nameInText(part, haystack) || decoratedPresent(stripPartyDecorations(part), haystack);
}

// Every party named in the abstract must appear in the document text.
function allPartiesPresent(raw, haystack) {
  const segments = String(raw)
    .split(/[;\n]+/)
    .map(seg => seg.replace(/^(?:[-*•]\s+)/, '').trim())
    .filter(Boolean);
  if (!segments.length) return false;
  return segments.every(segment => {
    if (partyNamePresent(segment, haystack)) return true;
    const whole = stripPartyDecorations(segment);
    if (segment.length > MAX_DECORATED_LENGTH || !whole.requires.every(required => nameInText(required, haystack))) return false;
    const fragments = whole.name.split(PARTY_SEPARATOR).map(p => p.trim()).filter(Boolean).map(stripPartyDecorations);
    if (fragments.length < 2) return false;
    const tokens = fragments.map(fragment => fragment.name.split(' ').filter(Boolean));
    return fragments.every((fragment, i) => {
      let name = fragment.name;
      if (tokens[i].length === 1) {
        // A lone first name takes the surname of the adjacent full name (next first, else previous).
        const neighbor = [tokens[i + 1], tokens[i - 1]].find(t => t && t.length > 1);
        if (neighbor) name = `${name} ${neighbor.at(-1)}`;
      }
      return decoratedPresent({ ...fragment, name }, haystack);
    });
  });
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
    if (isGroundingAbstention(raw, name)) continue;

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

    if (name === 'GRANTOR' || name === 'GRANTEE') {
      if (allPartiesPresent(raw, haystack)) matched += 1;
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

export function isFieldAbstained(value, field) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return true;
  if (PLACEHOLDER_ONLY_VALUE.test(trimmed)) return true;
  if (HARD_ABSTAIN_MARKER.test(trimmed)) return true;
  if (hasSoftAbstention(trimmed, field)) return true;
  if (ABSTAIN_EXACT_VALUE.test(trimmed)) return true;
  return false;
}

export function hasKeyIllegibleMarker(text) {
  const value = String(text || '').trim();
  if (!value || !ILLEGIBLE_MARKER_RE.test(value)) return false;

  let sawTemplateField = false;
  let currentField = null;
  for (const rawLine of value.replace(/\r\n?/g, '\n').split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed || /^```/.test(trimmed)) continue;
    if (/^DOCUMENT\s*#\d+(?:\s*\([^)]*\))?\s*:?/i.test(trimmed) || /^\[[^\]]+\]$/.test(trimmed)) {
      currentField = null;
      continue;
    }
    const candidate = trimmed
      .replace(/^(?:[-*•]\s+)/, '')
      .replace(/^\*\*([^*:]+?)\*\*:/, '$1:')
      .replace(/^\*\*([^*:]+?:)\*\*\s*/, '$1 ');
    const match = candidate.match(/^([A-Z][A-Z /-]*[A-Z]):\s*(.*)$/);
    if (match) {
      sawTemplateField = true;
      currentField = match[1].trim();
      if (KEY_ILLEGIBLE_FIELDS.has(currentField) && ILLEGIBLE_MARKER_RE.test(match[2])) {
        return true;
      }
    } else if (currentField && KEY_ILLEGIBLE_FIELDS.has(currentField) && ILLEGIBLE_MARKER_RE.test(trimmed)) {
      return true;
    }
  }
  return !sawTemplateField;
}

export function validateAbstractQuality(text, options = {}) {
  const { documentText = null, minTextMatchPercent = 65 } = options || {};
  const fields = parseAbstractFields(text);
  const reasons = [];
  const docType = String(fields['DOC TYPE'] || '').trim();
  const dateRecorded = fields['DATE RECORDED'];
  const dateRecordedUncertain = typeof dateRecorded === 'string' && UNCERTAIN_RECORDED_DATE.test(dateRecorded);
  const recordedDates = extractCalendarDates(dateRecorded);

  for (const field of REQUIRED_IDENTITY_FIELDS) {
    const raw = fields[field];
    if (typeof raw !== 'string' || !raw.trim()) {
      reasons.push(`missing_required_field:${field}`);
      continue;
    }
    const trimmed = raw.trim();
    const statesNotApplicable = !HARD_ABSTAIN_MARKER.test(trimmed)
      && (isNotApplicableValue(trimmed) || (field === 'GRANTEE' && NONE_VALUE.test(trimmed)));
    if (statesNotApplicable) {
      if (!acceptsNotApplicable(field, docType)) reasons.push(`abstained_required_field:${field}`);
      continue;
    }
    if (field === 'RECORDING REF' && UNRECORDED_VALUE.test(trimmed) && !recordedDates.length && !dateRecordedUncertain) {
      continue;
    }
    if (isFieldAbstained(trimmed, field)) {
      reasons.push(`abstained_required_field:${field}`);
    }
  }

  if (dateRecordedUncertain) {
    reasons.push('abstained_key_field:DATE RECORDED');
  }

  const executedDates = extractCalendarDates(fields['DATE EXECUTED']);
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
    const statesNone = !HARD_ABSTAIN_MARKER.test(fraction) && (isNotApplicableValue(fraction) || NONE_VALUE.test(fraction));
    const invalidFraction = !fraction
      || (statesNone ? !acceptsNoFraction(docType) : isFieldAbstained(fraction, 'FRACTION CONVEYED'));
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
