import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Personal catalog excludes every non-local corporate connection regardless of auth kind', () => {
  const source = fs.readFileSync('src/provider-connections.ts', 'utf8');
  assert.match(source, /if \(view\.organizationId !== PERSONAL_ORGANIZATION_ID\) continue;/);
  assert.match(source, /view\.organizationId !== PERSONAL_ORGANIZATION_ID &&\s*view\.organizationId !== LOCAL_ORGANIZATION_ID/);
  assert.doesNotMatch(source, /Subscription\s+accounts are explicit user-selectable identities and may be used in a\s+project-less Chat/);
});

test('new conversations receive server-owned Company scope instead of trusting the request body', () => {
  const source = fs.readFileSync('src/app-runtime.ts', 'utf8');
  assert.match(source, /const input: StandaloneJobInput & \{ companyId: string \} = \{/);
  assert.match(source, /companyId: project\?\.organizationId \?\? PERSONAL_COMPANY_ID/);
  assert.doesNotMatch(source, /companyId:\s*optionalString\(body, 'companyId'\)/);
});

test('Personal history hides legacy projectless corporate conversations without deleting them', () => {
  const source = fs.readFileSync('src/app-runtime.ts', 'utf8');
  assert.match(source, /job\.input\.modelSelection\?\.mode === 'explicit'/);
  assert.match(source, /connection && connection\.auth !== 'local'/);
  assert.match(source, /scoped\.input\.projectId \|\| scoped\.input\.companyId === PERSONAL_COMPANY_ID/);
  assert.match(source, /this\.jobs\.list\(\)\.map\(\(job\) => this\.personalVisibleJob\(job\)\)\.filter\(Boolean\)/);
  assert.match(source, /belongs to company scope .* and is not available in Personal/);
});

test('corporate projectless jobs cannot re-enter Personal through live events or follow-up', () => {
  const source = fs.readFileSync('src/app-runtime.ts', 'utf8');
  assert.match(source, /const visible = runtime\.personalVisibleJob\(job\);\s*if \(visible\) runtime\.emit/);
  assert.match(source, /const current = this\.requirePersonalJobAccess\(followUpMatch\[1\]\)/);
  assert.match(source, /const current = this\.requirePersonalJobAccess\(turnRetryMatch\[1\]\)/);
});
