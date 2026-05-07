#!/usr/bin/env node

const baseUrl = process.argv[2];

if (!baseUrl) {
  console.error('Usage: node scripts/smoke-test.js <base-url>');
  process.exit(1);
}

async function check(path, expectedStatus = 200, contains = null) {
  const response = await fetch(new URL(path, baseUrl));
  const text = await response.text();

  if (response.status !== expectedStatus) {
    throw new Error(`${path} returned ${response.status}, expected ${expectedStatus}`);
  }

  if (contains && !text.includes(contains)) {
    throw new Error(`${path} did not contain expected text: ${contains}`);
  }

  return {
    path,
    status: response.status,
  };
}

(async () => {
  const results = [];
  results.push(await check('/health'));
  results.push(await check('/ready'));
  results.push(await check('/', 200, 'Legal practice management'));
  console.log(JSON.stringify({ ok: true, results }, null, 2));
})().catch((error) => {
  console.error(JSON.stringify({ ok: false, message: error.message }, null, 2));
  process.exit(1);
});
