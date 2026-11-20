// Labeled corpus for the deterministic abstract quality checks. All data is fictional.
//   cleanCases:     correct abstracts, must NOT be flagged (with or without document text).
//   defectiveCases: one stated defect each, must be flagged with `reason` as the reason prefix.
//                   needsText: only detectable by comparing with the document text.
//   textGapCases:   defects the text comparison cannot see (documented limits, not asserted as flagged).
import { originalCleanCases } from './abstract-quality-original.js';

const ORDER = [
  'DOC TYPE', 'DATE EXECUTED', 'DATE RECORDED', 'RECORDING REF', 'GRANTOR', 'GRANTEE', 'LEGAL DESC',
  'SURFACE', 'MINERALS', 'ROYALTY/NPRI', 'TERM', 'AFTER-ACQUIRED TITLE', 'FRACTION CONVEYED',
  'RESERVATIONS', 'WARRANTY', 'ACKNOWLEDGMENT', 'ISSUES', 'CONFIDENCE',
];

const DEFAULTS = {
  'DOC TYPE': 'Warranty Deed',
  'DATE EXECUTED': 'March 3, 1952',
  'DATE RECORDED': 'March 10, 1952',
  'RECORDING REF': 'Vol. 412, Page 233',
  GRANTOR: 'John A. Smith and Mary B. Smith',
  GRANTEE: 'Robert L. Jones',
  'LEGAL DESC': 'NE/4 of Section 12, Township 5 North, Range 3 West, Garvin County, Oklahoma',
  SURFACE: 'yes',
  MINERALS: 'yes - all',
  'ROYALTY/NPRI': 'no',
  TERM: 'perpetual',
  'AFTER-ACQUIRED TITLE': 'no',
  'FRACTION CONVEYED': "All of grantor's interest",
  RESERVATIONS: 'none stated',
  WARRANTY: 'full',
  ACKNOWLEDGMENT: 'yes',
  ISSUES: 'none noted',
  CONFIDENCE: 'High - the instrument is fully legible.',
};

// overrides: value string, '' for a blank field, null to drop the line.
export function abstractOf(overrides = {}) {
  const merged = { ...DEFAULTS, ...overrides };
  return ORDER
    .filter(key => merged[key] !== null && merged[key] !== undefined)
    .map(key => `${key}: ${merged[key]}`)
    .join('\n');
}

export const DEED_TEXT = [
  'WARRANTY DEED',
  'KNOW ALL MEN BY THESE PRESENTS: That JOHN A. SMITH and wife, MARY B. SMITH, Grantors, convey to',
  'ROBERT L. JONES, Grantee, the NE/4 of Section 12, Township 5 North, Range 3 West, Garvin County, Oklahoma,',
  'together with all oil, gas and minerals.',
  'WITNESS our hands this 3rd day of March, 1952.',
  'Filed for record March 10, 1952 and recorded in Vol. 412, Page 233, Deed Records.',
].join('\n');

const clean = (name, overrides, text) => ({ name, abstract: abstractOf(overrides), text });

const LEASE = {
  'DOC TYPE': 'Oil and Gas Lease',
  'DATE EXECUTED': 'June 15, 1981',
  'DATE RECORDED': 'June 22, 1981',
  'RECORDING REF': 'Instrument No. 81-04417',
  GRANTOR: 'Eleanor R. Whitfield',
  GRANTEE: 'Sunbelt Energy Corporation',
  'LEGAL DESC': 'Section 3, Township 8 North, Range 4 East, Rogers County, Oklahoma',
  TERM: 'term - 3 years and as long thereafter as oil or gas is produced',
  'FRACTION CONVEYED': 'none stated',
  WARRANTY: 'special',
};
const LEASE_TEXT = [
  'OIL AND GAS LEASE',
  'AGREEMENT, made this 15th day of June, 1981, between Eleanor R. Whitfield, a widow, Lessor, and',
  'Sunbelt Energy Corporation, Lessee. Section 3, Township 8 North, Range 4 East, Rogers County, Oklahoma.',
  'Filed for record June 22, 1981. Instrument No. 81-04417',
].join('\n');

const ASSIGNMENT = {
  'DOC TYPE': 'Assignment of Oil and Gas Lease',
  'DATE EXECUTED': 'October 1, 1994',
  'DATE RECORDED': 'October 12, 1994',
  'RECORDING REF': 'Vol. 1190, Page 77',
  GRANTOR: 'Sunbelt Energy Corporation',
  GRANTEE: 'Redbud Production Company, L.P.',
  'LEGAL DESC': 'E/2 NW/4, Section 3, Township 8 North, Range 4 East, Rogers County, Oklahoma',
  'FRACTION CONVEYED': "An undivided 50% of Assignor's working interest",
};
const ASSIGNMENT_TEXT = [
  'ASSIGNMENT OF OIL AND GAS LEASE',
  'Sunbelt Energy Corporation, Assignor, assigns to Redbud Production Company, L.P., Assignee, an undivided 50%',
  'of its working interest in the E/2 NW/4, Section 3, Township 8 North, Range 4 East, Rogers County, Oklahoma.',
  'Executed October 1, 1994. Recorded October 12, 1994, Vol. 1190, Page 77.',
].join('\n');

const RELEASE = {
  'DOC TYPE': 'Release of Oil and Gas Lease',
  'DATE EXECUTED': 'May 14, 1987',
  'DATE RECORDED': 'May 20, 1987',
  'RECORDING REF': 'Book 301, Page 12',
  GRANTOR: 'Sunbelt Energy Corporation',
  GRANTEE: 'Eleanor R. Whitfield',
  'LEGAL DESC': 'E/2 NW/4, Section 3, Township 8 North, Range 4 East, Rogers County, Oklahoma',
  MINERALS: 'no',
  'FRACTION CONVEYED': 'not applicable',
};

const NOTE_TEXT = (title, body) => [title, body, 'Recorded in the county records.'].join('\n');

export const extraCleanCases = [
  clean('V01 capacity suffix: a single man', {
    GRANTOR: 'John A. Smith, a single man',
  }, DEED_TEXT.replace('JOHN A. SMITH and wife, MARY B. SMITH, Grantors', 'JOHN A. SMITH, a single man, Grantor')),
  clean('V02 two grantors joined with &, husband and wife', {
    GRANTOR: 'Opal Ferris & Clyde Ferris, husband and wife',
    GRANTEE: 'Prairie Minerals Trust',
    'DOC TYPE': 'Royalty Deed',
  }, [
    'ROYALTY DEED',
    'Clyde Ferris and Opal Ferris, husband and wife, Grantors, convey to Prairie Minerals Trust a royalty interest',
    'in the NE/4 of Section 12, Township 5 North, Range 3 West, Garvin County, Oklahoma.',
    'Dated March 3, 1952. Filed March 10, 1952, Vol. 412, Page 233.',
  ].join('\n')),
  clean('V03 grantee Unknown Heirs (short form)', {
    GRANTEE: 'Unknown Heirs of Silas Brooks',
  }, DEED_TEXT.replace('ROBERT L. JONES, Grantee', 'the Unknown Heirs of Silas Brooks, Grantee')),
  clean('V04 grantee The Unknown Heirs, Devisees, Successors and Assigns', {
    GRANTEE: 'The Unknown Heirs, Devisees, Successors and Assigns of Silas Brooks, deceased',
  }, DEED_TEXT.replace('ROBERT L. JONES, Grantee', 'The Unknown Heirs, Devisees, Successors and Assigns of Silas Brooks, deceased, Grantee')),
  clean('V05 affidavit, grantee and legal not applicable', {
    'DOC TYPE': 'Affidavit of Heirship',
    GRANTOR: 'Patricia Ann Moreno, affiant',
    GRANTEE: 'Not applicable',
    'LEGAL DESC': 'Not applicable',
    MINERALS: 'unclear',
    'FRACTION CONVEYED': 'not applicable',
  }, NOTE_TEXT('AFFIDAVIT OF HEIRSHIP', 'Before me on this 3rd day of March, 1952, personally appeared Patricia Ann Moreno, who states that Frank Moreno died intestate.\nFiled March 10, 1952, Vol. 412, Page 233.')),
  clean('V06 revocation of power of attorney, N/A and None', {
    'DOC TYPE': 'Revocation of Power of Attorney',
    GRANTOR: 'Dorothy L. Nash, principal',
    GRANTEE: 'None',
    'LEGAL DESC': 'N/A',
    MINERALS: 'no',
    'FRACTION CONVEYED': 'N/A',
  }, NOTE_TEXT('REVOCATION OF POWER OF ATTORNEY', 'I, Dorothy L. Nash, revoke the power of attorney given to my agent. Signed this 3rd day of March, 1952.\nFiled March 10, 1952, Vol. 412, Page 233.')),
  clean('V07 two-digit year dates with dashes', {
    'DOC TYPE': 'Quitclaim Deed',
    'DATE EXECUTED': '3-14-52',
    'DATE RECORDED': '3-20-52',
    GRANTOR: 'Nell Pruitt',
    GRANTEE: 'Walter Pruitt',
  }, [
    'QUITCLAIM DEED',
    'Nell Pruitt, Grantor, quitclaims to Walter Pruitt, Grantee, the NE/4 of Section 12, Township 5 North, Range 3 West.',
    'Signed the 14th day of March, 1952. Filed for record the 20th day of March, 1952, Vol. 412, Page 233.',
  ].join('\n')),
  clean('V08 lease with (Lessor) tag and none stated fraction', {
    ...LEASE,
    GRANTOR: 'Delmar Ranch Holdings, LLC (Lessor)',
    GRANTEE: 'Cimarron Exploration, Inc. (Lessee)',
  }, LEASE_TEXT
    .replace('Eleanor R. Whitfield, a widow, Lessor', 'Delmar Ranch Holdings, LLC, Lessor')
    .replace('Sunbelt Energy Corporation, Lessee', 'Cimarron Exploration, Inc., Lessee')),
  clean('V09 lease with et ux and none fraction', {
    ...LEASE,
    GRANTOR: 'Harold Pike et ux',
    'FRACTION CONVEYED': 'None',
  }, LEASE_TEXT.replace('Eleanor R. Whitfield, a widow, Lessor', 'Harold Pike and Doris Pike, Lessor')),
  clean('V10 assignment with role tags', {
    ...ASSIGNMENT,
    GRANTOR: 'Sunbelt Energy Corporation (Assignor)',
    GRANTEE: 'Redbud Production Company, L.P. (Assignee)',
  }, ASSIGNMENT_TEXT),
  clean('V11 termination of lease, grantee None', {
    ...RELEASE,
    'DOC TYPE': 'Termination of Oil and Gas Lease',
    GRANTEE: 'None',
  }, [
    'TERMINATION OF OIL AND GAS LEASE',
    'Sunbelt Energy Corporation terminates the lease covering the E/2 NW/4, Section 3, Township 8 North, Range 4 East, Rogers County, Oklahoma.',
    'Executed May 14, 1987. Filed May 20, 1987, Book 301, Page 12.',
  ].join('\n')),
  clean('V12 individually and as trustee suffix', {
    GRANTOR: 'Mary Pike, individually and as Trustee of the Pike Family Trust',
  }, DEED_TEXT.replace('JOHN A. SMITH and wife, MARY B. SMITH, Grantors', 'Mary Pike, Trustee of the Pike Family Trust, Grantor')),
  clean('V13 last will and testament, testator and not applicable', {
    'DOC TYPE': 'Last Will and Testament',
    GRANTOR: 'Ruth Ames, testator',
    GRANTEE: 'Not applicable',
    'LEGAL DESC': 'Not applicable - no real property described',
    MINERALS: 'unclear',
    'FRACTION CONVEYED': 'Not applicable',
  }, NOTE_TEXT('LAST WILL AND TESTAMENT', 'I, Ruth Ames, being of sound mind, make this will on the 3rd day of March, 1952.\nFiled March 10, 1952, Vol. 412, Page 233.')),
  clean('V14 plat, grantee n/a', {
    'DOC TYPE': 'Plat of Highland Addition',
    GRANTOR: 'Highland Development Company',
    GRANTEE: 'N/A',
    'LEGAL DESC': 'Highland Addition to the City of Ada, Pontotoc County, Oklahoma',
    MINERALS: 'no',
    'FRACTION CONVEYED': 'N/A',
  }, NOTE_TEXT('PLAT OF HIGHLAND ADDITION', 'Highland Development Company platted the Highland Addition to the City of Ada, Pontotoc County, Oklahoma, on March 3, 1952.\nFiled for record March 10, 1952, Vol. 412, Page 233.')),
  clean('V15 two-digit year with slashes and a wife-style capacity', {
    'DOC TYPE': 'Quitclaim Deed',
    'DATE EXECUTED': '3/14/52',
    'DATE RECORDED': '3/20/52',
    GRANTOR: 'Nell Pruitt, his wife',
    GRANTEE: 'Walter Pruitt',
  }, [
    'QUITCLAIM DEED',
    'Nell Pruitt, Grantor, quitclaims to Walter Pruitt, Grantee, the NE/4 of Section 12, Township 5 North, Range 3 West.',
    'Signed the 14th day of March, 1952. Filed for record the 20th day of March, 1952, Vol. 412, Page 233.',
  ].join('\n')),
  clean('W01 sheriff deed with a full conveyance', {
    'DOC TYPE': "Sheriff's Deed pursuant to Order of Sale",
    GRANTOR: 'Sheriff of Garvin County',
    GRANTEE: 'Robert L. Jones',
  }, DEED_TEXT.replace('WARRANTY DEED', "SHERIFF'S DEED pursuant to Order of Sale").replace('JOHN A. SMITH and wife, MARY B. SMITH, Grantors', 'Sheriff of Garvin County')),
  clean('W02 memorandum of lease, fraction not applicable', {
    ...LEASE, 'DOC TYPE': 'Memorandum of Oil and Gas Lease', 'FRACTION CONVEYED': 'not applicable',
  }, LEASE_TEXT.replace('OIL AND GAS LEASE', 'MEMORANDUM OF OIL AND GAS LEASE')),
  clean('W03 mortgage, minerals yes, fraction not applicable', {
    'DOC TYPE': 'Mortgage', 'FRACTION CONVEYED': 'Not applicable',
  }, DEED_TEXT.replace('WARRANTY DEED', 'MORTGAGE')),
  clean('W04 declaration of pooled unit, fraction none', {
    'DOC TYPE': 'Declaration of Pooled Unit', 'FRACTION CONVEYED': 'none',
  }, DEED_TEXT.replace('WARRANTY DEED', 'DECLARATION OF POOLED UNIT')),
  clean('W05 abstract of judgment, legal desc not applicable', {
    ...RELEASE, 'DOC TYPE': 'Abstract of Judgment', 'LEGAL DESC': 'Not applicable',
  }, NOTE_TEXT('ABSTRACT OF JUDGMENT', 'Sunbelt Energy Corporation obtained a judgment against Eleanor R. Whitfield. Release of record by Sunbelt Energy Corporation to Eleanor R. Whitfield.\nExecuted May 14, 1987. Filed May 20, 1987, Book 301, Page 12.')),
  clean('W06 partial date with a stated year', {
    'DATE EXECUTED': 'ca. 1952 (day and month not stated)',
  }, DEED_TEXT),
  clean('W07 legal description that contains the word blank', {
    'LEGAL DESC': 'The blank 5-acre tract in the NE/4 of Section 12, Township 5 North, Range 3 West, Garvin County, Oklahoma',
  }, DEED_TEXT.replace('the NE/4 of Section 12', 'the blank 5-acre tract in the NE/4 of Section 12')),
  clean('W08 unknown owners of the minerals under a section', {
    GRANTEE: 'Unknown owners of the minerals under Section 12',
  }, DEED_TEXT.replace('ROBERT L. JONES, Grantee', 'Unknown owners of the minerals under Section 12, Grantee')),
  clean('W09 trustee of a named trust, trust named in the text', {
    GRANTOR: 'John A. Smith, as Trustee of the Smith Family Trust',
  }, DEED_TEXT.replace('JOHN A. SMITH and wife, MARY B. SMITH, Grantors', 'JOHN A. SMITH, Trustee of the Smith Family Trust, Grantor')),
  clean('W10 two-digit year dates', {
    'DATE EXECUTED': '3/3/52', 'DATE RECORDED': '3/10/52',
  }, DEED_TEXT),
];

export const cleanCases = [...originalCleanCases, ...extraCleanCases];

const defect = (name, reason, overrides, extra = {}) => ({
  name, reason, abstract: abstractOf(overrides), text: DEED_TEXT, ...extra,
});
const withBase = (base, name, reason, overrides, text, extra = {}) => ({
  name, reason, abstract: abstractOf({ ...base, ...overrides }), text, ...extra,
});

export const defectiveCases = [
  defect('D01 GRANTOR blank', 'missing_required_field:GRANTOR', { GRANTOR: '' }),
  defect('D02 GRANTEE blank', 'missing_required_field:GRANTEE', { GRANTEE: '' }),
  defect('D03 LEGAL DESC blank', 'missing_required_field:LEGAL DESC', { 'LEGAL DESC': '' }),
  defect('D04 ILLEGIBLE marker inside a name', 'abstained_required_field:GRANTOR', { GRANTOR: 'JOHN [ILLEGIBLE - VERIFY MANUALLY] SMITH' }),
  defect('D05 Not applicable GRANTOR on warranty deed', 'abstained_required_field:GRANTOR', { GRANTOR: 'Not applicable' }),
  defect('D06 Not applicable GRANTEE on warranty deed', 'abstained_required_field:GRANTEE', { GRANTEE: 'Not applicable' }),
  defect('D07 Not applicable LEGAL DESC on warranty deed', 'abstained_required_field:LEGAL DESC', { 'LEGAL DESC': 'Not applicable' }),
  withBase(LEASE, 'D08 Not applicable GRANTEE on lease', 'abstained_required_field:GRANTEE', { GRANTEE: 'Not applicable' }, LEASE_TEXT),
  withBase(LEASE, 'D09 Not applicable LEGAL DESC on lease', 'abstained_required_field:LEGAL DESC', { 'LEGAL DESC': 'Not applicable - lease' }, LEASE_TEXT),
  withBase(ASSIGNMENT, 'D10 Not applicable GRANTOR on assignment', 'abstained_required_field:GRANTOR', { GRANTOR: 'Not applicable' }, ASSIGNMENT_TEXT),
  defect('D11 GRANTEE None on deed', 'abstained_required_field:GRANTEE', { GRANTEE: 'None' }),
  defect('D12 Unknown alone as a party', 'abstained_required_field:GRANTEE', { GRANTEE: 'Unknown' }),
  defect('D13 Unknown - cannot read as a party', 'abstained_required_field:GRANTOR', { GRANTOR: 'Unknown - cannot read' }),
  defect('D14 Name unclear as a party', 'abstained_required_field:GRANTEE', { GRANTEE: 'Name unclear' }),
  defect('D15 DATE EXECUTED missing', 'missing_required_field:DATE EXECUTED', { 'DATE EXECUTED': null }),
  defect('D16 DATE EXECUTED Not applicable', 'abstained_required_field:DATE EXECUTED', { 'DATE EXECUTED': 'Not applicable' }),
  defect('D17 RECORDING REF missing', 'missing_required_field:RECORDING REF', { 'RECORDING REF': null }),
  defect('D18 RECORDING REF Not applicable', 'abstained_required_field:RECORDING REF', { 'RECORDING REF': 'Not applicable' }),
  defect('D19 DATE RECORDED illegible', 'abstained_key_field:DATE RECORDED', { 'DATE RECORDED': 'ILLEGIBLE - VERIFY MANUALLY' }),
  defect('D20 recorded before executed', 'inverted_dates', { 'DATE RECORDED': 'March 1, 1952' }),
  defect('D21 MINERALS yes, blank fraction on deed', 'minerals_without_fraction', { 'FRACTION CONVEYED': '' }),
  defect('D22 MINERALS yes, ILLEGIBLE fraction on deed', 'minerals_without_fraction', { 'FRACTION CONVEYED': 'ILLEGIBLE - VERIFY MANUALLY' }),
  withBase(LEASE, 'D23 MINERALS yes, blank fraction on lease', 'minerals_without_fraction', { 'FRACTION CONVEYED': '' }, LEASE_TEXT),
  withBase(LEASE, 'D24 MINERALS yes, ILLEGIBLE fraction on lease', 'minerals_without_fraction', { 'FRACTION CONVEYED': 'ILLEGIBLE - VERIFY MANUALLY' }, LEASE_TEXT),
  defect('D25 MINERALS yes, n/a fraction on deed', 'minerals_without_fraction', { 'FRACTION CONVEYED': 'Not applicable' }),
  withBase(ASSIGNMENT, 'D26 MINERALS yes, none fraction on assignment', 'minerals_without_fraction', { 'FRACTION CONVEYED': 'none' }, ASSIGNMENT_TEXT),
  defect('D27 DATE EXECUTED Not stated', 'abstained_required_field:DATE EXECUTED', { 'DATE EXECUTED': 'Not stated' }),
  withBase({ ...RELEASE, 'DOC TYPE': 'Order Admitting Will to Probate' }, 'D28 ILLEGIBLE LEGAL DESC on probate order', 'abstained_required_field:LEGAL DESC', { 'LEGAL DESC': '[ILLEGIBLE - VERIFY MANUALLY]' }, DEED_TEXT),
  defect('D29 GRANTEE N/A on mineral deed', 'abstained_required_field:GRANTEE', { 'DOC TYPE': 'Mineral Deed', GRANTEE: 'N/A' }),
  withBase({ ...RELEASE }, 'D30 ILLEGIBLE GRANTEE on release', 'abstained_required_field:GRANTEE', { GRANTEE: 'ILLEGIBLE - VERIFY MANUALLY' }, DEED_TEXT),
  withBase({ ...RELEASE, 'DOC TYPE': 'Affidavit of Heirship' }, 'D31 empty-bracket placeholder GRANTOR on affidavit', 'abstained_required_field:GRANTOR', { GRANTOR: '[name]' }, DEED_TEXT),
  // Review round: compound instrument types, sentence-form abstentions, bare unknown parties.
  ...[
    ["Sheriff's Deed pursuant to Order of Sale", 'GRANTOR'],
    ["Executor's Deed pursuant to Decree", 'LEGAL DESC'],
    ['Mineral Deed pursuant to Order of Court', 'GRANTOR'],
    ['Quitclaim Deed and Release', 'LEGAL DESC'],
    ['Release and Assignment', 'GRANTOR'],
    ['Oil and Gas Lease with Ratification', 'GRANTEE'],
    ['Deed of Release', 'GRANTOR'],
    ['Order Conveying Mineral Interest', 'LEGAL DESC'],
    ['Power of Attorney to convey minerals', 'GRANTOR'],
    ['Probate Order Approving Sale of Mineral Interest', 'LEGAL DESC'],
    ["Executor's Deed in Probate", 'GRANTOR'],
  ].map(([docType, field], i) => defect(`D${32 + i} Not applicable ${field} on compound type: ${docType}`, `abstained_required_field:${field}`, { 'DOC TYPE': docType, [field]: 'Not applicable' })),
  defect('D43 mineral deed, none fraction', 'minerals_without_fraction', { 'DOC TYPE': 'Mineral Deed', 'FRACTION CONVEYED': 'none' }),
  defect("D44 Executor's Deed pursuant to Decree, n/a fraction", 'minerals_without_fraction', { 'DOC TYPE': "Executor's Deed pursuant to Decree", 'FRACTION CONVEYED': 'N/A' }),
  defect('D45 GRANTEE not shown on this page', 'abstained_required_field:GRANTEE', { GRANTEE: 'Grantee not shown on this page' }),
  defect('D46 LEGAL DESC missing from the page', 'abstained_required_field:LEGAL DESC', { 'LEGAL DESC': 'Legal description missing from the page provided' }),
  defect('D47 DATE EXECUTED not stated on the face', 'abstained_required_field:DATE EXECUTED', { 'DATE EXECUTED': 'Date not stated on the face of the instrument' }),
  defect('D48 RECORDING REF stamp missing', 'abstained_required_field:RECORDING REF', { 'RECORDING REF': 'recording stamp is missing from the scanned page' }),
  defect('D49 party with first name unclear', 'abstained_required_field:GRANTOR', { GRANTOR: 'Smith (first name unclear) and Jones' }),
  defect('D50 grantor name unclear, guess follows', 'abstained_required_field:GRANTOR', { GRANTOR: 'Grantor name unclear, appears to be J. Smith' }),
  defect('D51 township unclear inside a legal description', 'abstained_required_field:LEGAL DESC', { 'LEGAL DESC': 'Section 12, Township unclear, Range 3 West, Garvin County, Oklahoma' }),
  defect('D52 bare Unknown owner', 'abstained_required_field:GRANTOR', { GRANTOR: 'Unknown owner' }),
  defect('D53 bare Unknown party', 'abstained_required_field:GRANTEE', { GRANTEE: 'Unknown party' }),
  defect('D54 unknown heirs of a blank', 'abstained_required_field:GRANTEE', { GRANTEE: 'The unknown heirs of ____' }),
  defect('D55 lone Unknown heirs', 'abstained_required_field:GRANTOR', { GRANTOR: 'Unknown heirs' }),
  defect('D56 Unknown grantor', 'abstained_required_field:GRANTOR', { GRANTOR: 'Unknown grantor' }),
  // Text-dependent: two or more identity fields disagree with the document, so the match is under 65%.
  defect('T01 hallucinated grantor and grantee', 'low_text_match', { GRANTOR: 'Zebra Land Corp', GRANTEE: 'Omega Trust' }, { needsText: true }),
  defect('T02 hallucinated grantor plus recording ref not in text', 'low_text_match', { GRANTOR: 'Zebra Land Corp', 'RECORDING REF': 'Vol. 999, Page 1' }, { needsText: true }),
  defect('T03 one wrong surname among several grantors plus wrong ref', 'low_text_match', { GRANTOR: 'John A. Smith and Mary B. Jones', 'RECORDING REF': 'Vol. 999, Page 1' }, { needsText: true }),
  defect('T04 recording ref and recorded date not in text', 'low_text_match', { 'RECORDING REF': 'Vol. 999, Page 1', 'DATE RECORDED': 'April 20, 1953' }, { needsText: true }),
  {
    name: 'T05 names only as substrings of longer different words',
    reason: 'low_text_match',
    abstract: abstractOf({ GRANTOR: 'Ann Moor', GRANTEE: 'Ed Cole' }),
    text: DEED_TEXT.replace('JOHN A. SMITH and wife, MARY B. SMITH', 'Ann Moore').replace('ROBERT L. JONES', 'Ed Coleman'),
    needsText: true,
  },
  defect('T06 wrong surname among grantors on the ampersand form plus wrong ref', 'low_text_match', { GRANTOR: 'John A. Smith & Mary B. Jones, husband and wife', 'RECORDING REF': 'Vol. 999, Page 1' }, { needsText: true }),
];

// Single-field defects: one scored field in five is 80%, above the 65% threshold, so the match
// is not flagged by design. `matchedOf` pins the field-level result (grounding still sees it).
export const singleFaultCases = [
  defect('S01 hallucinated grantor only', 'unmatched', { GRANTOR: 'Zebra Land Corp' }),
  defect('S02 one wrong surname among several grantors only', 'unmatched', { GRANTOR: 'John A. Smith and Mary B. Jones' }),
  defect('S03 recording ref not in text only', 'unmatched', { 'RECORDING REF': 'Vol. 999, Page 1' }),
  {
    name: 'S04 name present only inside a longer different word',
    reason: 'unmatched',
    abstract: abstractOf({ GRANTEE: 'Ed Cole' }),
    text: DEED_TEXT.replace('ROBERT L. JONES', 'Ed Coleman'),
  },
];

// Defects the containment check cannot see at all.
export const undetectableCases = [
  defect('G01 grantor and grantee swapped', 'none', { GRANTOR: 'Robert L. Jones', GRANTEE: 'John A. Smith and Mary B. Smith' }),
];
