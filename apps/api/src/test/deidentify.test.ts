import { describe, expect, test } from 'vitest';
import { deidentify, reidentify, remainingIdentifiers } from '../services/deidentify';

const people = [
  {
    role: 'client' as const,
    name: 'Thandiwe Nkosi',
    identifiers: ['8503120123084', 'thandi.n@example.co.za', '082 555 1234'],
  },
  { role: 'opposing' as const, name: 'Pieter van der Merwe' },
  { role: 'related' as const, name: 'Lerato Nkosi' },
];

describe('de-identification', () => {
  test('known people become role tokens, by full name and by distinctive name part', () => {
    const { text, mapping } = deidentify(
      'Thandiwe Nkosi rents from Pieter van der Merwe. Later Thandiwe told Merwe she would pay. Her sister Lerato Nkosi agreed.',
      people,
    );
    expect(text).toBe(
      '[Client] rents from [Opposing party]. Later [Client] told [Opposing party] she would pay. Her sister [Related party] agreed.',
    );
    expect(mapping['[Client]']).toBe('Thandiwe Nkosi');
  });

  test('a family name two people share is not attributed to either', () => {
    const { text } = deidentify('The Nkosi family home was sold.', people);
    expect(text).toBe('The [Family name] family home was sold.');
  });

  test('listed details are removed however they are written', () => {
    const { text } = deidentify(
      'ID 850312 0123 084, call 0825551234 or THANDI.N@EXAMPLE.CO.ZA',
      people,
    );
    expect(text).not.toMatch(/850312|555|thandi/i);
  });

  test('pattern rules catch identifiers nobody listed', () => {
    const { text, replacements } = deidentify(
      [
        'His ID is 7001015009087 and his cell +27 (82) 123-4567.',
        'Card 4111 1111 1111 1111. Paid into account no. 62012345678.',
        'Company reg 2015/123456/07 at 14 Jacaranda Street, Erf 1234, PO Box 552.',
        'The matter is case 4521/2024 in the High Court; email a.b@mail.co.za.',
      ].join(' '),
    );
    expect(text).toBe(
      [
        'His ID is [ID number] and his cell [Phone].',
        'Card [Card number]. Paid into account no. [Account number].',
        'Company reg [Registration number] at [Address], [Erf number], [PO Box].',
        'The matter is case [Case number] in the High Court; email [Email].',
      ].join(' '),
    );
    expect(replacements.map((r) => r.kind).sort()).toEqual(
      [
        'address',
        'bank_account',
        'card_number',
        'case_number',
        'email',
        'erf',
        'id_number',
        'phone',
        'po_box',
        'registration_number',
      ].sort(),
    );
  });

  test('dates and amounts stay: they matter for prescription and claims', () => {
    const { text } = deidentify(
      'On 13/07/2023 he paid R12 000 under section 11 of Act 68 of 1969.',
    );
    expect(text).toBe('On 13/07/2023 he paid R12 000 under section 11 of Act 68 of 1969.');
  });

  test('titled people nobody listed are numbered consistently', () => {
    const { text } = deidentify('Dr Botha saw Mr Sipho Dube. Later Dr Botha wrote a report.');
    expect(text).toBe('[Person 1] saw [Person 2]. Later [Person 1] wrote a report.');
  });

  test('other name-like words are flagged for the attorney, not guessed at', () => {
    const { text, warnings } = deidentify(
      'When Sipho arrived at Jacaranda Properties in Pretoria, the High Court order was served in March.',
    );
    expect(text).toContain('Sipho');
    expect(warnings).toEqual(expect.arrayContaining(['Sipho', 'Jacaranda Properties']));
    expect(warnings.join(' ')).not.toMatch(/High Court|March|When|Pretoria/);
  });

  test('a clean brief has nothing left to remove, and names can be shown again to staff', () => {
    const { text, mapping } = deidentify('Thandiwe Nkosi was evicted.', people);
    expect(remainingIdentifiers(text, people)).toEqual([]);
    expect(remainingIdentifiers(`${text} Call 0825551234.`, people)).not.toEqual([]);
    expect(reidentify(text, mapping)).toBe('Thandiwe Nkosi was evicted.');
  });
});
