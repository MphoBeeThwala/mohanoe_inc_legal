import { expect, test } from 'vitest';
import { indexValues, nameTokens } from '../services/party-index';

test('names normalise: case, accents, punctuation, company suffixes and titles', () => {
  expect(nameTokens('Ms. Zoë  van der Merwe')).toEqual(['zoe', 'van', 'der', 'merwe']);
  expect(nameTokens('ACME (Pty) Ltd')).toEqual(['acme']);
  expect(nameTokens('Acme Holdings Proprietary Limited')).toEqual(['acme', 'holdings']);
});

test('full names index word-order independent; numbers and contacts normalise', () => {
  const a = indexValues({ name: 'Thandi Nkosi' }).find((v) => v.field === 'name');
  const b = indexValues({ name: 'NKOSI, Thandi' }).find((v) => v.field === 'name');
  expect(a?.value).toBe(b?.value);
  const values = indexValues({
    idNumber: '800101 5009 087',
    registrationNumber: '2019/123456/07',
    email: ' Thandi@Example.com ',
    phone: '+27 82 123 4567',
  });
  expect(values).toEqual([
    { field: 'id_number', value: '8001015009087' },
    { field: 'reg_number', value: '201912345607' },
    { field: 'email', value: 'thandi@example.com' },
    { field: 'phone', value: '821234567' },
  ]);
  expect(indexValues({ phone: '0821234567' })[0]?.value).toBe('821234567');
});
