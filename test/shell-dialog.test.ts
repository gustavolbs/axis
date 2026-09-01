import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');
/** CI checks out CRLF on Windows; normalize before slicing source. */
const lf = (value: string) => value.replace(/\r\n/g, '\n');

const dialog = lf(read('app/src/ShellDialog.tsx'));
const appRoot = lf(read('app/src/AppRoot.tsx'));
const panels = lf(read('app/src/SettingsPanels.tsx'));
const cancel = lf(read('app/src/RunCancellationControl.tsx'));
const css = lf(read('app/src/lc-fixes.css'));

const renderers = fs.readdirSync(path.join(root, 'app/src')).filter((file) => file.endsWith('.tsx'));

test('nothing asks through a system sheet any more', () => {
  // window.prompt and window.confirm render as OS sheets: unstyled, positioned
  // by the system, and visibly a different program. They also block the
  // renderer, so nothing updates underneath.
  for (const file of renderers) {
    const source = read(`app/src/${file}`).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.doesNotMatch(source, /window\.(prompt|confirm)\s*\(/, `${file} still asks through a system sheet`);
  }
});

test('one dialog serves every caller', () => {
  assert.match(dialog, /export function ShellDialog/);
  assert.match(dialog, /export type ShellDialogRequest/);
  // Three separate components ask, so the dialog cannot live in one of them.
  for (const [name, source] of [['AppRoot', appRoot], ['SettingsPanels', panels], ['RunCancellationControl', cancel]] as const) {
    assert.match(source, /from '\.\/ShellDialog\.js'/, `${name} must use the shared dialog`);
    assert.match(source, /<ShellDialog request=\{dialog\} onClose=\{\(\) => setDialog\(undefined\)\}/, `${name} must render it`);
  }
});

test('the prompt seeds and selects the current value', () => {
  // Seeding at mount would pre-fill the previous rename: the same instance is
  // reused for the next request.
  assert.match(dialog, /\}, \[request\]\);/);
  assert.match(dialog, /setValue\(request\.value\)/);
  assert.match(dialog, /input\.select\(\)/, 'typing should replace the old name');
  // An empty name is not a rename.
  assert.match(dialog, /value\.trim\(\)\.length > 0/);
  assert.match(dialog, /disabled=\{!canConfirm\}/);
});

test('Escape closes, and confirming closes before the work starts', () => {
  assert.match(dialog, /event\.key === 'Escape'/);
  assert.match(dialog, /addEventListener\('keydown'/);
  assert.match(dialog, /removeEventListener\('keydown'/, 'the listener must be torn down');
  // onConfirm kicks off an async mutation; holding the dialog open until it
  // resolves reads as a stuck button.
  const submit = dialog.slice(dialog.indexOf('function submit('));
  const body = submit.slice(0, submit.indexOf('\n  }'));
  assert.ok(body.indexOf('onClose()') < body.indexOf('request.onConfirm'), 'close before confirming');
});

test('destructive confirmations are marked as such', () => {
  assert.match(dialog, /request\.danger \? 'danger' : ''/);
  assert.match(css, /\.shell-dialog \.btn-primary\.danger/);
  // Every delete path asks first, and says archiving is the reversible option.
  assert.match(appRoot, /title: 'Delete chat'/);
  assert.match(appRoot, /archive it instead/);
  assert.match(appRoot, /title: 'Delete project'/);
  assert.match(panels, /title: 'Remove API key'/);
  assert.match(cancel, /title: 'Cancel run'/);
});

test('the dialog reuses the existing modal chrome', () => {
  // A rename and a project creation should look like the same application.
  assert.match(dialog, /className="lc-shell-modal-backdrop"/);
  assert.match(dialog, /className="lc-shell-modal-title"/);
  assert.match(dialog, /className="lc-shell-modal-actions"/);
  assert.match(dialog, /role="dialog"/);
  assert.match(dialog, /aria-modal="true"/);
  assert.match(css, /\.shell-dialog \{/);
});

test('asking is separated from doing, so the action can be retried', () => {
  // The confirm handler must not be the action itself: the callers keep their
  // async function and the dialog only decides whether to run it.
  assert.match(cancel, /function requestCancel\(\)/);
  assert.match(cancel, /onConfirm: \(\) => void cancelSelected\(\)/);
  assert.match(panels, /function requestRemove\(credentialId: string\)/);
  assert.match(panels, /onConfirm: \(\) => void remove\(credentialId\)/);
});
