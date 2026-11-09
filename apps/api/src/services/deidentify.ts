// De-identification of text before it goes to an AI model (roadmap §7.2).
//
// 1. Known people (intake client, matter parties) become role tokens:
//    [Client], [Opposing party], [Witness 2]... Their listed details (ID and
//    registration numbers, email, phone, address) are removed verbatim, and
//    their names are matched in full and by distinctive name parts.
// 2. Pattern rules remove identifiers nobody listed: SA ID numbers (also
//    spaced), phone numbers, email addresses, card and bank account numbers,
//    company registration numbers, court case numbers, street addresses, erf
//    numbers and PO boxes.
// 3. People named with a title (Mr, Ms, Dr, Adv...) become [Person 1]...
// 4. Other capitalised name-like phrases are not guessed at: they are listed
//    as warnings so the attorney checks the brief before it is sent.
//
// The token -> original mapping never leaves the server.

export type PersonRole =
  'client' | 'opposing' | 'opposing_attorney' | 'related' | 'witness' | 'other';

export interface KnownPerson {
  role: PersonRole;
  name: string;
  /** Other identifiers listed for the person, removed verbatim. */
  identifiers?: Array<string | null | undefined>;
}

export interface Replacement {
  token: string;
  kind: string;
  count: number;
}

export interface DeidentifiedText {
  text: string;
  replacements: Replacement[];
  /** Name-like phrases left in the text, for the attorney to check. */
  warnings: string[];
  /** token -> original value (server-side only). */
  mapping: Record<string, string>;
}

const ROLE_LABEL: Record<PersonRole, string> = {
  client: 'Client',
  opposing: 'Opposing party',
  opposing_attorney: 'Opposing attorney',
  related: 'Related party',
  witness: 'Witness',
  other: 'Person',
};

/** Words that appear in names but also everywhere else: never matched alone. */
const COMMON_NAME_PARTS = new Set(
  [
    'the',
    'and',
    'van',
    'von',
    'der',
    'den',
    'de',
    'du',
    'le',
    'la',
    'mr',
    'mrs',
    'ms',
    'dr',
    'pty',
    'ltd',
    'inc',
    'cc',
    'npc',
    'soc',
    'trust',
    'company',
    'holdings',
    'group',
    'services',
    'properties',
    'investments',
    'trading',
    'enterprises',
    'solutions',
    'south',
    'africa',
    'african',
    'bank',
    'municipality',
    'city',
    'department',
    'minister',
    'court',
    'estate',
    'late',
    'attorneys',
    'incorporated',
    'law',
  ].map((word) => word.toLowerCase()),
);

/** Capitalised phrases that are legal vocabulary, not names. */
const LEGAL_PHRASES = new Set(
  [
    'High Court',
    'Magistrates Court',
    "Magistrate's Court",
    'Labour Court',
    'Labour Appeal Court',
    'Constitutional Court',
    'Supreme Court',
    'Supreme Court of Appeal',
    'Land Claims Court',
    'Equality Court',
    'Small Claims Court',
    'Regional Court',
    'Divorce Court',
    'Children’s Court',
    "Children's Court",
    'Maintenance Court',
    'South Africa',
    'Republic of South Africa',
    'Gauteng Division',
    'Western Cape',
    'Eastern Cape',
    'Northern Cape',
    'Free State',
    'KwaZulu Natal',
    'KwaZulu-Natal',
    'North West',
    'Road Accident Fund',
    'Deeds Office',
    'Master of the High Court',
    'Sheriff of the Court',
    'Legal Practice Council',
    'Rental Housing Tribunal',
    'Consumer Protection Act',
    'National Credit Act',
    'Labour Relations Act',
    'Basic Conditions of Employment Act',
    'Children’s Act',
    "Children's Act",
    'Divorce Act',
    'Maintenance Act',
    'Prescription Act',
    'Constitution',
    'Bill of Rights',
    'CCMA',
    'POPIA',
    'SARS',
    'SAPS',
  ].map((phrase) => phrase.toLowerCase()),
);

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Letters and digits on both sides of a match must not continue the word. */
const bounded = (pattern: string) => `(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`;

/** A literal value, tolerant of extra whitespace and case. */
const literal = (value: string) => value.trim().split(/\s+/).map(escapeRegExp).join('\\s+');

interface Rule {
  kind: string;
  label: string;
  pattern: RegExp;
  /** Replace only this capture group (keeps a label such as "account no."). */
  group?: number;
}

/** Pattern rules, most specific first. */
const RULES: Rule[] = [
  {
    kind: 'email',
    label: 'Email',
    pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu,
  },
  {
    kind: 'registration_number',
    label: 'Registration number',
    pattern: new RegExp(bounded('(?:19|20)\\d{2}\\s?\\/\\s?\\d{6}\\s?\\/\\s?\\d{2}'), 'gu'),
  },
  {
    kind: 'card_number',
    label: 'Card number',
    pattern: new RegExp(bounded('\\d{4}(?:[ -]?\\d{4}){3}'), 'gu'),
  },
  {
    kind: 'id_number',
    label: 'ID number',
    // YYMMDD SSSS C A Z, with or without spaces.
    pattern: new RegExp(bounded('\\d{2}[01]\\d[0-3]\\d[ -]?\\d{4}[ -]?\\d{2}[ -]?\\d'), 'gu'),
  },
  {
    kind: 'phone',
    label: 'Phone',
    pattern: new RegExp(bounded('(?:\\+27|0027|0)[ -]?\\(?\\d{2}\\)?(?:[ -]?\\d){7}'), 'gu'),
  },
  {
    kind: 'bank_account',
    label: 'Account number',
    pattern:
      /((?:bank\s+)?(?:account|acc|acct|a\/c)(?:\s+(?:no|number|nr))?\.?\s*[:#]?\s*)(\d(?:[ -]?\d){5,15})/giu,
    group: 2,
  },
  {
    kind: 'case_number',
    label: 'Case number',
    pattern: /(?<![\w/-])(?:[A-Z]{1,6}[ -]?)?\d{1,7}\/(?:19|20)\d{2}(?![\w/-])/gu,
  },
  {
    kind: 'address',
    label: 'Address',
    pattern: new RegExp(
      bounded(
        "\\d{1,5}[A-Za-z]?\\s+(?:[A-Z][\\p{L}'-]+\\s+){1,4}(?:Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Lane|Ln|Crescent|Cres|Close|Way|Boulevard|Blvd|Place|Pl|Square|Sq|Terrace|Highway)\\.?",
      ),
      'gu',
    ),
  },
  {
    kind: 'erf',
    label: 'Erf number',
    pattern: /\b(?:Erf|Portion|Stand)\s+(?:No\.?\s*)?\d+(?:\s*\/\s*\d+)?/giu,
  },
  {
    kind: 'po_box',
    label: 'PO Box',
    pattern: /\b(?:P\.?\s?O\.?\s*Box|Postnet\s+Suite|Private\s+Bag)\s+[A-Z]?\d+/giu,
  },
];

const TITLE = '(?:Mr|Mrs|Ms|Miss|Mx|Dr|Prof|Adv|Advocate|Rev|Pastor|Chief|Kgosi|Inkosi)\\.?';
const CAP_WORD = "[A-Z][\\p{Ll}'’-]+(?:-[A-Z][\\p{Ll}'’-]+)?";

/** Mr Dlamini, Adv. Thandi Mokoena... (first name optional). */
const TITLED_PERSON = new RegExp(`\\b${TITLE}\\s+(${CAP_WORD}(?:\\s+${CAP_WORD}){0,2})`, 'gu');

const TOKEN = /\[[A-Z][A-Za-z0-9 ]*\]/g;

/** Capitalised words that are not names: sentence starters, dates, legal vocabulary. */
const NOT_NAMES = new Set([
  'mr',
  'mrs',
  'ms',
  'miss',
  'dr',
  'prof',
  'adv',
  'rev',
  'a',
  'an',
  'the',
  'in',
  'on',
  'at',
  'by',
  'for',
  'from',
  'to',
  'of',
  'and',
  'or',
  'but',
  'if',
  'when',
  'after',
  'before',
  'during',
  'since',
  'until',
  'while',
  'then',
  'also',
  'i',
  'we',
  'he',
  'she',
  'they',
  'it',
  'my',
  'our',
  'his',
  'her',
  'their',
  'its',
  'this',
  'that',
  'these',
  'those',
  'there',
  'here',
  'yes',
  'no',
  'please',
  'dear',
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'christmas',
  'easter',
  'act',
  'acts',
  'section',
  'sections',
  'rule',
  'rules',
  'regulation',
  'regulations',
  'court',
  'courts',
  'judge',
  'magistrate',
  'tribunal',
  'commission',
  'council',
  'master',
  'sheriff',
  'registrar',
  'plaintiff',
  'defendant',
  'applicant',
  'respondent',
  'appellant',
  'accused',
  'state',
  'client',
  'clients',
  'attorney',
  'advocate',
  'constitution',
  'republic',
  'province',
  'provincial',
  'national',
  'city',
  'town',
  'municipality',
  'metro',
  'department',
  'minister',
  'government',
  'police',
  'station',
  'bank',
  'company',
  'trust',
  'estate',
  'deceased',
  'school',
  'hospital',
  'clinic',
  'english',
  'afrikaans',
  'isizulu',
  'isixhosa',
  'sesotho',
  'setswana',
  'notice',
  'summons',
  'order',
  'agreement',
  'contract',
  'lease',
  'will',
  'deed',
  'division',
  'high',
  'labour',
  'supreme',
  'appeal',
  'constitutional',
  'magistrates',
  'regional',
  'district',
  'small',
  'claims',
  'south',
  'africa',
  'african',
  'gauteng',
  'western',
  'eastern',
  'northern',
  'cape',
  'free',
  'kwazulu',
  'natal',
  'north',
  'west',
  'limpopo',
  'mpumalanga',
  'johannesburg',
  'pretoria',
  'tshwane',
  'durban',
  'ethekwini',
]);

/** Name-like phrases left in the text, with non-name words trimmed away. */
function nameWarnings(text: string): string[] {
  const found = new Set<string>();
  const words = text.replace(TOKEN, ' . ').split(/(\s+)/);
  let sentenceStart = true;
  let current: string[] = [];
  const flush = () => {
    const kept = current.filter((word) => !NOT_NAMES.has(word.toLowerCase()));
    const phrase = current.join(' ');
    if (kept.length && !LEGAL_PHRASES.has(phrase.toLowerCase())) {
      found.add(kept.join(' '));
    }
    current = [];
  };
  for (const raw of words) {
    if (!raw.trim()) continue;
    const word = raw.replace(/^[("'“‘]+|[)"'”’,;:.!?]+$/gu, '');
    const capitalised = /^[A-Z][\p{Ll}'’-]+$/u.test(word);
    if (capitalised && (!sentenceStart || current.length)) {
      current.push(word);
    } else if (capitalised && sentenceStart) {
      // A capitalised sentence opener may still start a name ("Thabo said").
      current.push(word);
    } else {
      flush();
    }
    if (/[.!?]["')\]]*$/.test(raw)) {
      flush();
      sentenceStart = true;
    } else {
      sentenceStart = false;
    }
  }
  flush();
  return [...found];
}

export function deidentify(input: string, people: KnownPerson[] = []): DeidentifiedText {
  let text = String(input ?? '');
  const counts = new Map<string, Replacement>();
  const mapping: Record<string, string> = {};

  const record = (token: string, kind: string, original: string) => {
    const entry = counts.get(token) ?? { token, kind, count: 0 };
    entry.count += 1;
    counts.set(token, entry);
    mapping[token] ??= original.trim();
  };
  const replace = (pattern: RegExp, token: string, kind: string, group?: number) => {
    text = text.replace(pattern, (...args: unknown[]) => {
      const match = String(args[0]);
      if (group) {
        const captured = args[group] as string | undefined;
        if (!captured) return match;
        record(token, kind, captured);
        return match.replace(captured, token);
      }
      record(token, kind, match);
      return token;
    });
  };

  // 1. Known people: tokens by role, numbered when a role repeats.
  const byRole = new Map<PersonRole, number>();
  for (const person of people) {
    byRole.set(person.role, (byRole.get(person.role) ?? 0) + 1);
  }
  const seen = new Map<PersonRole, number>();
  const named = people
    .filter((person) => person.name.trim())
    .map((person) => {
      const index = (seen.get(person.role) ?? 0) + 1;
      seen.set(person.role, index);
      const label = ROLE_LABEL[person.role];
      const token = (byRole.get(person.role) ?? 0) > 1 ? `[${label} ${index}]` : `[${label}]`;
      return { ...person, token };
    });

  // Listed identifiers first (exact values beat patterns).
  for (const person of named) {
    for (const value of person.identifiers ?? []) {
      const trimmed = String(value ?? '').trim();
      if (trimmed.length < 4) continue;
      const digits = trimmed.replace(/\D/g, '');
      const pattern =
        digits.length >= 6 && digits.length === trimmed.replace(/[\s()+-]/g, '').length
          ? // A number: match it with any spacing.
            new RegExp(bounded(digits.split('').join('[ ()+-]*')), 'gu')
          : new RegExp(bounded(literal(trimmed)), 'giu');
      replace(pattern, `${person.token.slice(0, -1)} details]`, 'listed_detail');
    }
  }

  // Full names, longest first, then distinctive name parts.
  const fullNames = named
    .map((person) => ({ token: person.token, name: person.name.trim() }))
    .sort((a, b) => b.name.length - a.name.length);
  for (const { token, name } of fullNames) {
    replace(new RegExp(bounded(literal(name)), 'giu'), token, 'person');
  }
  const parts = new Map<string, string>();
  for (const { token, name } of fullNames) {
    for (const part of name.split(/[\s,()]+/)) {
      const clean = part.replace(/[^\p{L}'’-]/gu, '');
      if (clean.length < 3 || COMMON_NAME_PARTS.has(clean.toLowerCase())) continue;
      // A part shared by two people (a family name) points at neither alone.
      parts.set(clean, parts.has(clean) && parts.get(clean) !== token ? '' : token);
    }
  }
  for (const [part, token] of [...parts.entries()].sort((a, b) => b[0].length - a[0].length)) {
    if (!token) continue;
    // Capitalised only: "Rose" the person, not "rose" the verb.
    replace(new RegExp(bounded(escapeRegExp(part)), 'gu'), token, 'person');
  }
  for (const [part, token] of parts.entries()) {
    if (token) continue;
    replace(new RegExp(bounded(escapeRegExp(part)), 'gu'), '[Family name]', 'person');
  }

  // 2. Pattern rules.
  for (const rule of RULES) {
    replace(rule.pattern, `[${rule.label}]`, rule.kind, rule.group);
  }

  // 3. Titled people nobody listed.
  const others = new Map<string, string>();
  text = text.replace(TITLED_PERSON, (match: string, name: string) => {
    const key = name.toLowerCase();
    let token = others.get(key);
    if (!token) {
      token = `[Person ${others.size + 1}]`;
      others.set(key, token);
    }
    record(token, 'person', name);
    return token;
  });

  // 4. Warnings: name-like words and phrases left in the text.
  const warnings = nameWarnings(text);

  return {
    text: text.replace(/[ \t]+/g, ' ').trim(),
    replacements: [...counts.values()],
    warnings: warnings.slice(0, 50),
    mapping,
  };
}

/** What de-identification would still remove: empty means the text is clean. */
export function remainingIdentifiers(text: string, people: KnownPerson[] = []): Replacement[] {
  return deidentify(text, people).replacements;
}

/** Puts names back for display to staff who may see the matter (never for the model). */
export function reidentify(text: string, mapping: Record<string, string>): string {
  return text.replace(TOKEN, (token) => mapping[token] ?? token);
}
