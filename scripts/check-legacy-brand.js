#!/usr/bin/env node
// Fails if the retired working-title brand reappears anywhere in the repo.
// The platform is white-label: firm names come from configuration only.

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
// Built from parts so this file does not match itself.
const BANNED = [
  new RegExp(['mo', 'hanoe'].join(''), 'i'),
  new RegExp(`\\b${['M', 'HL'].join('')}-`),
  new RegExp(['mhl', '_token'].join('')),
];
const SKIP_DIRS = new Set(['node_modules', '.git', 'build', 'dist', 'coverage']);
const SKIP_FILES = new Set(['package-lock.json']);
// Known, deliberate exceptions: identifiers of live infrastructure that would
// break if renamed. Remove each once that infrastructure is retired.
const ALLOWED_LINES = [{ file: 'render.yaml', contains: 'legacy Render service ID' }];
const TEXT_EXT = new Set([
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.json',
  '.md',
  '.html',
  '.css',
  '.sql',
  '.yaml',
  '.yml',
  '.svg',
  '.txt',
  '.example',
  '.nix',
  '.mjs',
  '.cjs',
  '',
]);

function walk(dir, hits) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        walk(path.join(dir, entry.name), hits);
      }
      continue;
    }

    if (SKIP_FILES.has(entry.name) || !TEXT_EXT.has(path.extname(entry.name))) {
      continue;
    }

    const file = path.join(dir, entry.name);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      const relative = path.relative(repoRoot, file);
      const allowed = ALLOWED_LINES.some(
        (rule) => rule.file === relative && line.includes(rule.contains),
      );
      if (!allowed && BANNED.some((pattern) => pattern.test(line))) {
        hits.push(`${relative}:${index + 1}: ${line.trim().slice(0, 120)}`);
      }
    });
  }
}

const hits = [];
walk(repoRoot, hits);

if (hits.length) {
  console.error('Retired brand name found. Branding must come from configuration:\n');
  hits.forEach((hit) => console.error(`  ${hit}`));
  process.exit(1);
}

console.log('Brand check passed: no retired brand references.');
