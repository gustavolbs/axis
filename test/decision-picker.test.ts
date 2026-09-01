import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

const surface = read('app/src/AgentSurfaceV2.tsx');
const css = read('app/src/lc-fixes.css');

/**
 * Every declaration applied to exactly this selector, in source order — the
 * set the cascade resolves. Matching a selector as a substring would also pick
 * up `.decision-picker-head`, which is a different rule.
 */
function declarationsFor(selector: string): string {
  const bodies: string[] = [];
  for (const [, head, body] of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (head.split(',').map((part) => part.trim()).includes(selector)) bodies.push(body);
  }
  assert.notEqual(bodies.length, 0, `no rule for ${selector}`);
  return bodies.join('\n');
}

/**
 * Text of one function declaration, so assertions cannot drift into a
 * neighbouring function the way a lazy `[\s\S]*?` match does.
 *
 * The parameter list has to be skipped first: an inline props type
 * (`function F(props: { … })`) contributes balanced braces, and its closing
 * brace sits in column zero, so neither "first `{`" nor "first `\n}`" finds
 * the body.
 */
function functionBody(source: string, name: string): string {
  const start = source.search(new RegExp(`\\bfunction ${name}\\s*\\(`));
  assert.notEqual(start, -1, `${name} not found`);

  let index = source.indexOf('(', start);
  for (let parens = 0; index < source.length; index++) {
    if (source[index] === '(') parens++;
    else if (source[index] === ')' && --parens === 0) break;
  }

  const bodyStart = source.indexOf('{', index);
  assert.notEqual(bodyStart, -1, `${name} has no body`);
  for (let i = bodyStart, depth = 0; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

test('the picker is keyboard-first: arrows, digits, Enter and Escape', () => {
  const picker = functionBody(surface, 'DecisionPicker');
  assert.match(picker, /ArrowDown/);
  assert.match(picker, /ArrowUp/);
  assert.match(picker, /event\.key === 'Enter'/);
  assert.match(picker, /event\.key === 'Escape'/);
  // Number keys jump straight to an option, as in the reference picker.
  assert.match(picker, /Number\.parseInt\(event\.key, 10\)/);
  assert.match(picker, /digit >= 1 && digit <= count/);
  // Wrapping arithmetic, so ArrowUp from the first row lands on the last.
  assert.match(picker, /% count/);
});

test('the picker renders a numbered row per option plus a free-text row', () => {
  const picker = functionBody(surface, 'DecisionPicker');
  assert.match(picker, /\{position \+ 1\}/, 'each row shows its own number');
  assert.match(picker, /role="listbox"/);
  assert.match(picker, /role="option"/);
  assert.match(picker, /aria-selected=\{!customFocused && position === active\}/);
  assert.match(picker, /<CornerDownLeft/, 'the active row shows the Enter hint');
  assert.match(picker, /decision-picker-custom/);
  assert.match(picker, /aria-label="Answer in your own words"/);
  // Skip turns into Send once something is typed.
  assert.match(picker, /custom\.trim\(\) \? 'Send' : 'Skip'/);
});

test('the card matches the reference: no border, inset active pill, bare input', () => {
  const card = declarationsFor('.decision-picker');
  assert.doesNotMatch(card, /border:\s*1px/, 'the reference card has no outline');
  assert.match(card, /border-radius:\s*16px/);

  // Rows are inset so the active pill and the separators stop short of the edge.
  const row = declarationsFor('.decision-picker-options > button');
  assert.match(row, /margin-inline:\s*8px/);
  assert.match(row, /border-radius:\s*10px/);
  assert.match(row, /border-top:\s*1px solid/);
  // A separator under the active pill would cut its rounded corner.
  assert.match(css, /\.decision-picker-options > button\.active \+ button/);
  assert.match(css, /\.decision-picker-options > button\.active\s*\{[^}]*border-top-color:\s*transparent/);

  // The free-text row is text, not a form field.
  const input = declarationsFor('.decision-picker-custom input');
  assert.match(input, /border:\s*0/);
  assert.match(input, /background:\s*transparent/);
  // Filled pill, not an outlined secondary button.
  assert.match(declarationsFor('.decision-picker-custom button'), /background:\s*var\(--lc-surface-3\)/);
});

test('rows fill the row width and the dividers are visible', () => {
  // A flex <button> with no width shrinks to its label, which left the active
  // pill only as wide as its text. The grid container stretches its children.
  assert.match(declarationsFor('.decision-picker-options'), /display:\s*grid/);
  const row = declarationsFor('.decision-picker-options > button');
  assert.doesNotMatch(row, /width:\s*auto/);
  // --lc-border-soft was too faint to read as a divider.
  assert.match(row, /border-top:\s*1px solid var\(--lc-border\)/);
});

test('the number badge reads lighter than the row it sits on', () => {
  // --lc-surface is darker than --lc-surface-3, so using it for the badge on an
  // active row inverted the relationship the reference has.
  const badge = declarationsFor('.decision-picker-options > button.active > i');
  assert.match(badge, /background:\s*color-mix\(in srgb, var\(--lc-text\)/);
  assert.doesNotMatch(badge, /background:\s*var\(--lc-surface\)\s*;/);
});

test('only one row is highlighted at a time', () => {
  const picker = functionBody(surface, 'DecisionPicker');
  // With the free-text row focused, an option row also carrying .active meant
  // two highlighted rows at once, which reads as a rendering glitch.
  assert.match(picker, /const \[customFocused, setCustomFocused\] = useState\(false\)/);
  assert.match(picker, /className=\{!customFocused && position === active \? 'active' : ''\}/);
  assert.match(picker, /aria-selected=\{!customFocused && position === active\}/);
  assert.match(picker, /onFocus=\{\(\) => setCustomFocused\(true\)\}/);
  assert.match(picker, /onBlur=\{\(\) => setCustomFocused\(false\)\}/);
  // Moving the mouse back onto an option hands the highlight back.
  assert.match(picker, /onMouseEnter=\{\(\) => \{ setCustomFocused\(false\); setActive\(position\); \}\}/);
});

test('the caret has room so the first character is not clipped', () => {
  // At padding 0 the caret is painted on the box edge and half of it is cut off.
  const input = declarationsFor('.decision-picker-custom input');
  assert.match(input, /padding:\s*0 2px/);
  // The negative margin keeps the text aligned with the option labels above.
  assert.match(input, /margin-inline:\s*-2px/);
});

test('the free-text row shows focus on the row, not as a ring on the input', () => {
  // lc-app.css sets the global focus ring with !important, so opting out needs
  // !important too — and the row keeps the state visible for keyboard users.
  const focus = declarationsFor('.decision-picker-custom input:focus');
  assert.match(focus, /outline:\s*none\s*!important/);
  assert.match(focus, /box-shadow:\s*none\s*!important/);
  assert.match(declarationsFor('.decision-picker-custom:focus-within'), /background:/);
});

test('the shortcut legend sits below the composer, not inside the card', () => {
  // "or type below" refers to the composer, so the legend cannot be above it.
  assert.match(surface, /function DecisionHint/);
  const picker = functionBody(surface, 'DecisionPicker');
  assert.doesNotMatch(picker, /decision-picker-hint/, 'the legend moved out of the card');
  const hintAt = surface.indexOf('<DecisionHint');
  const composerAt = surface.indexOf('<Composer');
  assert.ok(composerAt > 0 && hintAt > composerAt, 'the legend must render after the composer');
  // And it replaces the suggestion chips while a decision is open.
  assert.match(surface, /!active && !pendingDecision && mode === 'chat' \? <Suggestions/);
});

test('typing in the free-text row does not trigger the list shortcuts', () => {
  const picker = functionBody(surface, 'DecisionPicker');
  // Without this, typing "2" in the input would select option 2 and submit.
  assert.match(picker, /event\.stopPropagation\(\)/);
});

test('a new question resets the cursor instead of pointing at the old row', () => {
  const picker = functionBody(surface, 'DecisionPicker');
  assert.match(picker, /useEffect\(\(\) => \{[\s\S]*?setActive\(/);
  assert.match(picker, /recommendedOptionId/, 'start on the recommended option when there is one');
});

test('/mock-decision renders the shipping component without touching the backend', () => {
  assert.match(surface, /MOCK_DECISION_COMMAND = \/\^\\\/mock\[-\\s\]\?decision\$\/i/);
  const createJob = functionBody(surface, 'createJob');
  assert.match(createJob, /MOCK_DECISION_COMMAND\.test\(goal\.trim\(\)\)/);
  // The mock must short-circuit before the POST.
  const guard = createJob.indexOf('MOCK_DECISION_COMMAND');
  const post = createJob.indexOf("'/api/jobs'");
  assert.ok(guard > 0 && post > guard, 'the mock must return before creating a job');

  // One render site, so the mock exercises the same component as a real request.
  assert.match(surface, /const pendingDecision = mockDecision/);
  assert.match(surface, /active\?\.status === 'waiting-decision'/);
  assert.equal(surface.match(/<DecisionPicker/g)?.length, 1, 'exactly one render site');
  assert.match(surface, /decision-picker-echo/, 'the mock shows what it would have sent');
});

test('the composer invites a written answer while a decision is open', () => {
  assert.match(surface, /placeholder=\{pendingDecision \? 'Or answer directly…' : undefined\}/);
});

test('the retired decision markup is gone', () => {
  assert.doesNotMatch(surface, /function DecisionMessage/);
  assert.doesNotMatch(surface, /inline-choice-list/);
  // TaskThread no longer receives the decision props it stopped using.
  const thread = functionBody(surface, 'TaskThread');
  assert.doesNotMatch(thread, /decisionSelections/);
});

test('the picker has its own styles', () => {
  for (const selector of [
    '.decision-picker',
    '.decision-picker-head',
    '.decision-picker-options',
    '.decision-picker-custom',
    '.decision-picker-hint',
    '.decision-picker-echo'
  ]) {
    assert.ok(css.includes(`${selector} `) || css.includes(`${selector} {`) || css.includes(`${selector},`), `missing ${selector}`);
  }
});

test('a chat with no project uses the default workspace instead of reopening the picker', () => {
  const createJob = functionBody(surface, 'createJob');
  assert.match(createJob, /localStorage\.getItem\('local-coder\.workspace'\)/, 'Settings has a default workspace for exactly this');
  assert.match(createJob, /workspace\.trim\(\) \|\| defaultWorkspace/);
  // The old behaviour reopened the project menu with no message, which read as
  // the picker jumping for no reason.
  assert.match(createJob, /setProjectMenu\(false\)/);
  assert.match(createJob, /needs a folder to work in/);
});
