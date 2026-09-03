import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Personal catalog excludes every non-local corporate connection regardless of auth kind', () => {
  const source = fs.readFileSync('src/provider-connections.ts', 'utf8');
  assert.match(source, /if \(view\.organizationId !== PERSONAL_ORGANIZATION_ID\) continue;/);
  assert.match(source, /view\.organizationId !== PERSONAL_ORGANIZATION_ID &&\s*view\.organizationId !== LOCAL_ORGANIZATION_ID/);
  assert.doesNotMatch(source, /Subscription\s+accounts are explicit user-selectable identities and may be used in a\s+project-less Chat/);
});

test('new conversations receive server-owned canonical Company scope instead of trusting the request body', () => {
  const app = fs.readFileSync('src/app-runtime.ts', 'utf8');
  const composition = fs.readFileSync('src/agent-product-runtime.ts', 'utf8');
  assert.match(app, /companyId: projectId \? this\.companyForProject\(projectId\) : PERSONAL_COMPANY_ID,/);
  assert.match(app, /const input: StandaloneJobInput & \{ companyId: string \} = \{/);
  assert.doesNotMatch(app, /companyId:\s*optionalString\(body, 'companyId'\)/);
  assert.match(composition, /const companyId = canonicalCompanyId\(snapshot, project, input\.companyId\);/);
  assert.match(composition, /companyForProject\(snapshot, project\.id\)/);
  assert.match(composition, /Session Company .* does not match canonical/);
});

test('Personal history hides projectless corporate conversations through canonical session scope without deleting them', () => {
  const source = fs.readFileSync('src/app-runtime.ts', 'utf8');
  assert.match(source, /const companyId = job\.input\.projectId\s*\? this\.companyForProject\(job\.input\.projectId\)\s*: existing \|\| PERSONAL_COMPANY_ID;/);
  assert.match(source, /scoped\.input\.projectId \|\| scoped\.input\.companyId === PERSONAL_COMPANY_ID/);
  assert.match(source, /this\.jobs\.list\(\)\s*\.map\(\(job\) => this\.personalVisibleJob\(job\)\)\s*\.filter\(Boolean\)/);
  assert.match(source, /belongs to company scope .* and is not available in Personal/);
  assert.doesNotMatch(source, /connection && connection\.auth !== 'local'\) companyId = connection\.organizationId/);
});

test('corporate projectless jobs cannot re-enter Personal through live events, follow-up or direct mutation', () => {
  const source = fs.readFileSync('src/app-runtime.ts', 'utf8');
  assert.match(source, /const visible = runtime\.personalVisibleJob\(job\);\s*if \(visible\) runtime\.emit/);
  assert.match(source, /const current = this\.requirePersonalJobAccess\(followUpMatch\[1\]\)/);
  assert.match(source, /const current = this\.requirePersonalJobAccess\(turnRetryMatch\[1\]\)/);
  assert.match(source, /this\.requirePersonalJobAccess\(id\);/);
  assert.match(source, /this\.requirePersonalJobAccess\(jobMatch\[1\]\);/);
  assert.match(source, /this\.requirePersonalJobAccess\(cancelMatch\[1\]\);/);
  assert.match(source, /this\.requirePersonalJobAccess\(decisionMatch\[1\]\);/);
  assert.match(source, /this\.requirePersonalJobAccess\(guidanceMatch\[1\]\);/);
  assert.match(source, /this\.requirePersonalJobAccess\(escalationMatch\[1\]\);/);
});
