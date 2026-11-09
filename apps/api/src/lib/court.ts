// Court case numbers, normalised so a matter can be matched with a court roll.
//
// Courts write the same number several ways: "34660/16", "034660/2016",
// "34660 / 2016", and Gauteng's newer "2016-034660". All become "34660/2016".

/** Normalised key (number/yyyy) for a court case number, or null if it isn't one. */
export function courtCaseKey(value: string | null | undefined, now = new Date()): string | null {
  if (!value) return null;
  const text = value.replace(/\s+/g, '').toUpperCase();
  let number: string | undefined;
  let year: string | undefined;
  const yearFirst = /^(\d{4})[-/](\d{1,8})$/.exec(text);
  const numberFirst = /^(?:[A-Z]{1,4}[-/]?)?(\d{1,8})[-/](\d{2}|\d{4})$/.exec(text);
  if (yearFirst) {
    [, year, number] = yearFirst;
  } else if (numberFirst) {
    [, number, year] = numberFirst;
  }
  if (!number || !year) return null;
  if (year.length === 2) {
    const century = now.getUTCFullYear() % 100 >= Number(year) ? 2000 : 1900;
    year = String(century + Number(year));
  }
  const n = String(Number(number));
  return n === '0' ? null : `${n}/${year}`;
}

/** Court case numbers in free text (e.g. a line of a court roll), normalised. */
export function courtCaseKeysIn(text: string, now = new Date()): string[] {
  const found = new Set<string>();
  // Not part of a date such as 13/07/2023: no slash or digit on either side.
  const pattern = /(?<![\w/-])(\d{4}-\d{3,8}|\d{1,8}\s*\/\s*(?:\d{4}|\d{2}))(?![\w/-])/g;
  for (const match of text.matchAll(pattern)) {
    const key = courtCaseKey(match[1], now);
    if (key) found.add(key);
  }
  return [...found];
}
