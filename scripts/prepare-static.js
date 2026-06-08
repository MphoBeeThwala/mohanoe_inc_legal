#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const sourceDir = path.join(repoRoot, 'frontend', 'build');
const targetDir = path.join(repoRoot, 'backend', 'public');

if (!fs.existsSync(sourceDir)) {
  console.error(`Frontend build directory not found: ${sourceDir}`);
  process.exit(1);
}

fs.rmSync(targetDir, { recursive: true, force: true });
fs.mkdirSync(path.dirname(targetDir), { recursive: true });
fs.cpSync(sourceDir, targetDir, { recursive: true });

console.log(`Copied frontend build to ${targetDir}`);
