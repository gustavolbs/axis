#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagePath = path.join(repoRoot, 'package.json');
const changelogPath = path.join(repoRoot, 'CHANGELOG.md');

function fail(message) {
  throw new Error(`[release metadata] ${message}`);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) fail(`Version ${JSON.stringify(value)} must be a stable SemVer x.y.z.`);
  return match.slice(1).map(Number);
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

export function changelogSection(changelog, version) {
  const heading = new RegExp(`^## \\[${escapeRegex(version)}\\] - (\\d{4}-\\d{2}-\\d{2})\\s*$`, 'm');
  const match = heading.exec(changelog);
  if (!match) fail(`CHANGELOG.md is missing "## [${version}] - YYYY-MM-DD".`);

  const date = match[1];
  if (Number.isNaN(Date.parse(`${date}T00:00:00Z`))) fail(`Changelog date ${date} is invalid.`);

  const bodyStart = match.index + match[0].length;
  const rest = changelog.slice(bodyStart);
  const nextHeading = rest.search(/^## \[/m);
  const body = rest.slice(0, nextHeading === -1 ? rest.length : nextHeading).trim();
  if (!body) fail(`CHANGELOG.md entry for ${version} is empty.`);

  return { date, body, heading: match[0] };
}

export function validateMetadata(packageJson, changelog) {
  const version = packageJson?.version;
  if (typeof version !== 'string') fail('package.json must contain a string version.');
  parseVersion(version);

  const firstEntry = /^## \[([^\]]+)\] - \d{4}-\d{2}-\d{2}\s*$/m.exec(changelog);
  if (!firstEntry) fail('CHANGELOG.md has no versioned entries.');
  if (firstEntry[1] !== version) {
    fail(`The first changelog entry (${firstEntry[1]}) must match package.json (${version}).`);
  }

  const section = changelogSection(changelog, version);
  return { version, ...section };
}

function readMetadata() {
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const changelog = fs.readFileSync(changelogPath, 'utf8');
  return validateMetadata(packageJson, changelog);
}

function main() {
  const command = process.argv[2] ?? 'validate';
  const metadata = readMetadata();

  if (command === 'validate') {
    console.log(`release metadata ok: Axis v${metadata.version} (${metadata.date})`);
    return;
  }
  if (command === 'version') {
    process.stdout.write(`${metadata.version}\n`);
    return;
  }
  if (command === 'notes') {
    process.stdout.write(`${metadata.body}\n`);
    return;
  }
  if (command === 'compare') {
    const baseVersion = process.argv[3];
    if (!baseVersion) fail('compare requires a base version argument.');
    if (compareVersions(metadata.version, baseVersion) <= 0) {
      fail(`package.json version ${metadata.version} must be greater than base version ${baseVersion}.`);
    }
    console.log(`version bump ok: ${baseVersion} -> ${metadata.version}`);
    return;
  }

  fail(`Unknown command: ${command}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
