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

async function fetchJson(path, expectedStatus = 200) {
  const response = await fetch(new URL(path, baseUrl));

  if (response.status !== expectedStatus) {
    throw new Error(`${path} returned ${response.status}, expected ${expectedStatus}`);
  }

  return response.json();
}

(async () => {
  const results = [];
  results.push(await check('/health'));
  results.push(await check('/ready'));
  results.push(await check('/', 200, '<div id="root"></div>'));
  results.push(await check('/manifest.json', 200, '"short_name"'));

  // Vite injects the hashed entry script into index.html.
  const html = await (await fetch(new URL('/', baseUrl))).text();
  const mainJsPath = html.match(/<script[^>]+src="([^"]+\.js)"/)?.[1];

  if (!mainJsPath) {
    throw new Error('index.html did not reference a JavaScript entry bundle');
  }

  results.push(await check(mainJsPath, 200));
  const branding = await fetchJson('/api/tenant/branding');
  if (!branding.firmName) {
    throw new Error('/api/tenant/branding did not return a firm name');
  }
  results.push({ path: '/api/tenant/branding', status: 200, firmName: branding.firmName });
  console.log(JSON.stringify({ ok: true, results }, null, 2));
})().catch((error) => {
  console.error(JSON.stringify({ ok: false, message: error.message }, null, 2));
  process.exit(1);
});
