// Blind-index hashes for parties (clients, opposing parties …), so they can
// be searched and conflict-checked without decrypting the register.
// Each value is normalised, prefixed with its field, and hashed with the
// firm's index key (privacy.service blindIndex).
import { blindIndex } from './privacy.service';

export interface PartySearchInput {
  name?: string;
  idNumber?: string;
  registrationNumber?: string;
  email?: string;
  phone?: string;
}

export type IndexField = 'name' | 'token' | 'id_number' | 'reg_number' | 'email' | 'phone';

export interface IndexEntry {
  field: IndexField;
  hash: string;
  /** The normalised value (never stored; used to explain matches). */
  value: string;
}

/** Words that say nothing about who a party is. */
const NOISE = new Set([
  'the',
  'and',
  'of',
  'pty',
  'ltd',
  'limited',
  'proprietary',
  'inc',
  'incorporated',
  'cc',
  'npc',
  'soc',
  'trust',
  'company',
  'co',
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'adv',
]);

export function normaliseName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function nameTokens(name: string): string[] {
  return [...new Set(normaliseName(name).split(' '))].filter(
    (token) => token.length >= 2 && !NOISE.has(token),
  );
}

function digits(value: string): string {
  return value.replace(/\D/g, '');
}

/** The normalised values to index (or search) for a party. */
export function indexValues(input: PartySearchInput): Array<{ field: IndexField; value: string }> {
  const values: Array<{ field: IndexField; value: string }> = [];
  if (input.name?.trim()) {
    const tokens = nameTokens(input.name);
    if (tokens.length) {
      values.push({ field: 'name', value: tokens.slice().sort().join(' ') });
    }
    for (const token of tokens) {
      values.push({ field: 'token', value: token });
    }
  }
  if (input.idNumber && digits(input.idNumber).length >= 6) {
    values.push({ field: 'id_number', value: digits(input.idNumber) });
  } else if (input.idNumber?.trim()) {
    values.push({ field: 'id_number', value: input.idNumber.trim().toLowerCase() });
  }
  if (input.registrationNumber?.trim()) {
    values.push({
      field: 'reg_number',
      value: input.registrationNumber.toLowerCase().replace(/[^a-z0-9]/g, ''),
    });
  }
  if (input.email?.trim()) {
    values.push({ field: 'email', value: input.email.trim().toLowerCase() });
  }
  if (input.phone && digits(input.phone).length >= 9) {
    // Last nine digits: 0821234567 and +27821234567 match.
    values.push({ field: 'phone', value: digits(input.phone).slice(-9) });
  }
  return values;
}

export async function indexEntries(input: PartySearchInput): Promise<IndexEntry[]> {
  return Promise.all(
    indexValues(input).map(async ({ field, value }) => ({
      field,
      value,
      hash: await blindIndex(`party:${field}:${value}`),
    })),
  );
}
