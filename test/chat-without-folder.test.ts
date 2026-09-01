import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');
const lf = (value: string) => value.replace(/\r\n/g, '\n');

const runtime = read('src/app-runtime.ts');
const jobManager = read('src/standalone-job-manager.ts');
const engineerBackend = read('src/project-engineer-backend.ts');
const premiumAgent = read('src/premium-agent.ts');
const surface = read('app/src/AgentSurfaceV2.tsx');
const fixesCss = read('app/src/lc-fixes.css');

/**
 * Chat is one inference. executeDirectChat only echoes the workspace back in
 * its result — it never reads a file — so requiring a folder to say "hello"
 * was a gate with nothing behind it. Cowork acts on a folder and still needs
 * one. Each layer of the path had its own check.
 */

test('the chat fast path does not read the workspace', () => {
  // GitHub Actions checks out CRLF on Windows. Normalize before slicing the
  // TypeScript function so this contract test describes source semantics rather
  // than the runner's line-ending policy.
  const normalized = lf(premiumAgent);
  const chat = normalized.slice(normalized.indexOf('async function executeDirectChat'));
  const body = chat.slice(0, chat.indexOf('\n}\n'));
  // The only mention is echoing it into the result payload.
  assert.equal((body.match(/input\.workspace/g) ?? []).length, 1);
  assert.doesNotMatch(body, /resolveWorkspace|readFile|readdir/);
});

test('the runtime accepts a chat with no workspace and still demands one for cowork', () => {
  const post = runtime.slice(
    runtime.indexOf("method === 'POST' && pathname === '/jobs'"),
    runtime.indexOf('const jobMatch')
  );
  assert.match(post, /interactionMode === 'chat'/);
  assert.match(post, /optionalString\(body, 'workspace'\)/, 'chat: optional');
  assert.match(post, /requiredString\(body, 'workspace'\)/, 'cowork: required');
  // The mode is parsed once and reused, not parsed twice.
  assert.match(post, /const interactionMode = parseInteractionMode\(body\.interactionMode\)/);
  assert.match(post, /^\s+interactionMode,$/m);
});

test('the job manager only requires a folder for the engineering pipeline', () => {
  const create = jobManager.slice(jobManager.indexOf('create(input: StandaloneJobInput)'));
  const guard = create.slice(0, create.indexOf("goal is required"));
  assert.match(guard, /\(input\.interactionMode \?\? 'cowork'\) !== 'chat'/);
  assert.match(guard, /!input\.workspace\.trim\(\)/);
});

test('a project-less chat skips workspace resolution', () => {
  // resolveWorkspace throws on an empty path, and it runs whenever any project
  // exists — so a chat with no folder crashed there even though nothing
  // downstream of a chat reads the value.
  assert.match(engineerBackend, /interactionMode\?: 'chat' \| 'cowork'/, 'the type must carry the mode');
  const resolve = engineerBackend.slice(engineerBackend.indexOf('private async resolveProject'));
  const body = resolve.slice(0, resolve.indexOf('await resolveWorkspace'));
  assert.match(body, /input\.interactionMode === 'chat'/);
  assert.match(body, /!input\.workspace\.trim\(\)/);
});

test('the composer only blocks the send in Cowork', () => {
  const createJob = surface.slice(surface.indexOf('async function createJob'), surface.indexOf('async function cancelActive'));
  assert.match(createJob, /!effectiveWorkspace && mode === 'cowork'/);
  assert.match(createJob, /Cowork needs a folder to work in/);
  // The default workspace from Settings is still used when there is one.
  assert.match(createJob, /localStorage\.getItem\('local-coder\.workspace'\)/);
});

test('Browse stays inside the composer popover', () => {
  // width: 100% on a flex item becomes a 100% flex-basis, which pushed the
  // Browse button out of the popover and squeezed the input to nothing.
  assert.match(fixesCss, /\.path-field > input\s*\{[^}]*width:\s*auto/);
});
