import assert from 'node:assert/strict';
import test from 'node:test';

import type { LocalEngineerResult } from '../src/local-engineer.js';
import type { PremiumEngineerResult } from '../src/premium-agent.js';
import type { ProjectEngineerInput } from '../src/project-engineer-backend.js';
import { StandaloneJobManager } from '../src/standalone-job-manager.js';

function result(
  input: ProjectEngineerInput,
  status: LocalEngineerResult['status']
): LocalEngineerResult {
  return {
    status,
    phase: status === 'success' ? 'complete' : 'planning',
    workspace: input.workspace,
    goal: input.goal,
    summary: status === 'success' ? 'done' : 'decision needed',
    investigation: { searchQueries: [], evidenceFiles: [], researchRequests: [] },
    repairRounds: 0,
    changedFiles: [],
    diff: '',
    validation: [],
    modelCalls: []
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for standalone job state.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('standalone Project job reuses one budget job id across material-decision rounds', async () => {
  const calls: ProjectEngineerInput[] = [];
  const execution = {
    executeEngineer: async (input: ProjectEngineerInput): Promise<LocalEngineerResult> => {
      calls.push(structuredClone(input));
      if (calls.length === 1) {
        return {
          ...result(input, 'needs-guidance'),
          decisionRequest: {
            message: 'Choose the public behavior.',
            questions: [{
              id: 'behavior',
              question: 'Which behavior?',
              rationale: 'This changes a public contract.',
              options: [
                { id: 'a', label: 'A', tradeoff: 'Keep compatibility.' },
                { id: 'b', label: 'B', tradeoff: 'Use the new behavior.' }
              ],
              recommendedOptionId: 'a',
              blocking: true
            }]
          }
        } as PremiumEngineerResult;
      }
      return result(input, 'success');
    }
  };
  const manager = new StandaloneJobManager(execution);
  const created = manager.create({
    projectId: 'company-project',
    workspace: '/repo/company-project',
    goal: 'implement safely'
  });

  await waitFor(() => manager.get(created.id)?.status === 'waiting-decision');
  manager.submitDecision(created.id, { behavior: 'a' });
  await waitFor(() => manager.get(created.id)?.status === 'success');

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.projectId, 'company-project');
  assert.equal(calls[1]?.projectId, 'company-project');
  assert.equal(calls[0]?.budgetJobId, created.id);
  assert.equal(calls[1]?.budgetJobId, created.id);
  assert.equal(calls[0]?.workspace, '/repo/company-project');
  assert.equal(calls[1]?.workspace, '/repo/company-project');
  assert.match(calls[1]?.userGuidance ?? '', /behavior: a/);
});
