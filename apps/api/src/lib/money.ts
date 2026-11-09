// Money is stored as integer cents. The API accepts and returns rand amounts
// (numbers with up to two decimals) and converts at the boundary.

export function toCents(rands: number): number {
  return Math.round(rands * 100);
}

export function fromCents(cents: number): number {
  return cents / 100;
}

export const DEFAULT_VAT_RATE = 0.15;

/** VAT rate from VAT_RATE (e.g. 0.15), defaulting to South Africa's 15%. */
export function vatRate(): number {
  const configured = Number(process.env.VAT_RATE);
  return Number.isFinite(configured) && configured >= 0 && configured < 1
    ? configured
    : DEFAULT_VAT_RATE;
}
