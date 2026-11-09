// PayFast (payfast.io): the platform's payment gateway for firm subscriptions.
//
// - Checkout: a signed form the browser POSTs to PayFast (recurring billing,
//   subscription_type 1). PayFast collects the card or EFT details; this
//   platform never sees them.
// - ITN (Instant Transaction Notification): PayFast POSTs each payment to
//   /api/payfast/notify. A notification counts only if its signature matches,
//   it came from a PayFast host, PayFast confirms it (/eng/query/validate)
//   and it is for our merchant account.
// - Subscription API (api.payfast.co.za): change the amount, cancel.
//
// Configuration (platform-level, Ahava on 88's merchant account):
// PAYFAST_MERCHANT_ID, PAYFAST_MERCHANT_KEY, PAYFAST_PASSPHRASE (required for
// recurring billing) and PAYFAST_SANDBOX=true for the sandbox.
import { createHash } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { httpError } from '../lib/http';

export interface PayFastConfig {
  merchantId: string;
  merchantKey: string;
  passphrase: string;
  sandbox: boolean;
}

export function payfastConfig(env: NodeJS.ProcessEnv = process.env): PayFastConfig | null {
  const merchantId = String(env.PAYFAST_MERCHANT_ID || '').trim();
  const merchantKey = String(env.PAYFAST_MERCHANT_KEY || '').trim();
  const passphrase = String(env.PAYFAST_PASSPHRASE || '').trim();
  if (!merchantId || !merchantKey || !passphrase) {
    return null;
  }
  return {
    merchantId,
    merchantKey,
    passphrase,
    sandbox: String(env.PAYFAST_SANDBOX || '').toLowerCase() === 'true',
  };
}

export function requirePayfast(): PayFastConfig {
  const config = payfastConfig();
  if (!config) {
    throw httpError(
      'Online payment is not set up yet. Please contact platform support to subscribe.',
      503,
    );
  }
  return config;
}

const siteHost = (config: PayFastConfig) =>
  config.sandbox ? 'sandbox.payfast.co.za' : 'www.payfast.co.za';

export const processUrl = (config: PayFastConfig) => `https://${siteHost(config)}/eng/process`;
const validateUrl = (config: PayFastConfig) => `https://${siteHost(config)}/eng/query/validate`;

/** PHP's urlencode(), which PayFast's signatures are defined with. */
export function phpUrlEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/%20/g, '+')
    .replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

const md5 = (value: string) => createHash('md5').update(value).digest('hex');

/** key=value pairs in the given order, empty values left out, values trimmed. */
export function paramString(pairs: Array<[string, string]>): string {
  return pairs
    .filter(([, value]) => value.trim() !== '')
    .map(([key, value]) => `${key}=${phpUrlEncode(value.trim())}`)
    .join('&');
}

/** Signature for checkout forms and ITNs: fields in order, then the passphrase. */
export function formSignature(pairs: Array<[string, string]>, passphrase: string): string {
  const base = paramString(pairs);
  return md5(passphrase ? `${base}&passphrase=${phpUrlEncode(passphrase)}` : base);
}

/** Signature for API calls: headers, body and passphrase, sorted by name. */
export function apiSignature(values: Record<string, string>, passphrase: string): string {
  const all: Record<string, string> = { ...values, passphrase };
  const pairs = Object.keys(all)
    .sort()
    .map((key): [string, string] => [key, String(all[key])]);
  return md5(paramString(pairs));
}

// ------------------------------------------------------------------ checkout

/** PayFast frequency codes. */
export const FREQUENCY = { monthly: '3', annual: '6' } as const;

export interface CheckoutInput {
  paymentId: string;
  amountCents: number;
  itemName: string;
  itemDescription?: string;
  /** First charge date (YYYY-MM-DD, South African time). */
  billingDate: string;
  frequency: keyof typeof FREQUENCY;
  returnUrl: string;
  cancelUrl: string;
  notifyUrl: string;
  /** Echoed back in every ITN: identifies the firm. */
  firmId: string;
}

export const rands = (cents: number) => (cents / 100).toFixed(2);

/** The signed fields, in the order PayFast defines for checkout signatures. */
export function checkoutFields(
  config: PayFastConfig,
  input: CheckoutInput,
): Array<[string, string]> {
  const fields: Array<[string, string]> = [
    ['merchant_id', config.merchantId],
    ['merchant_key', config.merchantKey],
    ['return_url', input.returnUrl],
    ['cancel_url', input.cancelUrl],
    ['notify_url', input.notifyUrl],
    ['m_payment_id', input.paymentId],
    ['amount', rands(input.amountCents)],
    ['item_name', input.itemName.slice(0, 100)],
    ['item_description', (input.itemDescription ?? '').slice(0, 255)],
    ['custom_str1', input.firmId],
    ['subscription_type', '1'],
    ['billing_date', input.billingDate],
    ['recurring_amount', rands(input.amountCents)],
    ['frequency', FREQUENCY[input.frequency]],
    ['cycles', '0'],
  ];
  const signed = fields.filter(([, value]) => value.trim() !== '');
  return [...signed, ['signature', formSignature(signed, config.passphrase)]];
}

// ----------------------------------------------------------------------- ITN

/** Hosts PayFast sends notifications from (their documented list). */
const PAYFAST_HOSTS = [
  'www.payfast.co.za',
  'sandbox.payfast.co.za',
  'w1w.payfast.co.za',
  'w2w.payfast.co.za',
];

export interface PayFastNetwork {
  fetch: typeof fetch;
  /** IPv4 addresses PayFast notifications may come from. */
  payfastAddresses: () => Promise<Set<string>>;
}

let cachedAddresses: { at: number; addresses: Set<string> } | null = null;

async function resolvePayfastAddresses(): Promise<Set<string>> {
  if (cachedAddresses && Date.now() - cachedAddresses.at < 10 * 60_000) {
    return cachedAddresses.addresses;
  }
  const addresses = new Set<string>();
  for (const host of PAYFAST_HOSTS) {
    try {
      for (const address of await dns.resolve4(host)) {
        addresses.add(address);
      }
    } catch {
      // A host that doesn't resolve contributes no addresses.
    }
  }
  if (addresses.size) {
    cachedAddresses = { at: Date.now(), addresses };
  }
  return addresses;
}

const defaultNetwork: PayFastNetwork = {
  fetch: (...args) => fetch(...args),
  payfastAddresses: resolvePayfastAddresses,
};
let network: PayFastNetwork = defaultNetwork;

/** Tests replace PayFast's servers; there is no switch to skip the checks. */
export function setPayFastNetwork(replacement: PayFastNetwork | null): void {
  network = replacement ?? defaultNetwork;
}

/** Form pairs in the order they were sent (signatures depend on it). */
export function parseForm(body: string): Array<[string, string]> {
  return [...new URLSearchParams(body).entries()];
}

export interface VerifiedItn {
  fields: Record<string, string>;
}

const normaliseIp = (ip: string) => ip.replace(/^::ffff:/, '');

/**
 * Checks a notification as PayFast prescribes: signature, merchant, source
 * address and PayFast's own confirmation. Throws a 400 for anything else.
 */
export async function verifyItn(
  config: PayFastConfig,
  rawBody: string,
  sourceIp: string,
): Promise<VerifiedItn> {
  const pairs = parseForm(rawBody);
  const fields = Object.fromEntries(pairs);
  const unsigned = pairs.filter(([key]) => key !== 'signature');

  if (!fields.signature || formSignature(unsigned, config.passphrase) !== fields.signature) {
    throw httpError('Invalid signature', 400);
  }
  if (fields.merchant_id !== config.merchantId) {
    throw httpError('Unknown merchant', 400);
  }
  const allowed = await network.payfastAddresses();
  if (!allowed.has(normaliseIp(sourceIp))) {
    throw httpError('Notification did not come from PayFast', 400);
  }
  const confirmation = await network.fetch(validateUrl(config), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: paramString(unsigned),
    signal: AbortSignal.timeout(15_000),
  });
  const answer = (await confirmation.text()).trim();
  if (!confirmation.ok || answer !== 'VALID') {
    throw httpError('PayFast did not confirm the notification', 400);
  }
  return { fields };
}

export const toCents = (amount: string | undefined): number | null => {
  if (!amount || !/^-?\d+(\.\d{1,2})?$/.test(amount.trim())) {
    return null;
  }
  return Math.round(Number(amount) * 100);
};

// ----------------------------------------------------- subscription API calls

const API = 'https://api.payfast.co.za';

/** ISO 8601 in South African time, as the API expects. */
function apiTimestamp(now = new Date()): string {
  const sast = new Date(now.getTime() + 2 * 3_600_000);
  return `${sast.toISOString().slice(0, 19)}+02:00`;
}

async function apiCall(
  config: PayFastConfig,
  method: 'GET' | 'PUT' | 'PATCH',
  path: string,
  body: Record<string, string> = {},
): Promise<unknown> {
  const headers: Record<string, string> = {
    'merchant-id': config.merchantId,
    version: 'v1',
    timestamp: apiTimestamp(),
  };
  headers.signature = apiSignature({ ...headers, ...body }, config.passphrase);
  const url = `${API}${path}${config.sandbox ? '?testing=true' : ''}`;
  const response = await network.fetch(url, {
    method,
    headers: {
      ...headers,
      ...(Object.keys(body).length ? { 'content-type': 'application/json' } : {}),
    },
    body: Object.keys(body).length ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  if (!response.ok) {
    // PayFast's message, never our request (it holds no personal information,
    // but the signature has no place in logs).
    throw httpError(`PayFast refused the change (${response.status}). Please try again.`, 502);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Changes what each future period costs (PayFast API amounts are in cents). */
export async function updateSubscriptionAmount(
  config: PayFastConfig,
  token: string,
  amountCents: number,
): Promise<void> {
  await apiCall(config, 'PATCH', `/subscriptions/${encodeURIComponent(token)}/update`, {
    amount: String(amountCents),
  });
}

export async function cancelSubscription(config: PayFastConfig, token: string): Promise<void> {
  await apiCall(config, 'PUT', `/subscriptions/${encodeURIComponent(token)}/cancel`);
}
