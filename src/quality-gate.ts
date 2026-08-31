import type { CognitiveProfile } from './cognitive-policy.js';
import type { LocalEngineerResult } from './local-engineer.js';

export type QualityBand = 'excellent' | 'strong' | 'guarded' | 'weak';

export interface QualitySignal {
  name: string;
  delta: number;
  detail: string;
}

export interface QualityAssessment {
  score: number;
  band: QualityBand;
  threshold: number;
  passed: boolean;
  signals: QualitySignal[];
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function assessEngineeringQuality(
  result: LocalEngineerResult,
  cognitive: CognitiveProfile | undefined,
  threshold = 80
): QualityAssessment {
  let score = 45;
  const signals: QualitySignal[] = [];
  const add = (name: string, delta: number, detail: string) => {
    score += delta;
    signals.push({ name, delta, detail });
  };

  if (result.status === 'success') add('completed', 8, 'The bounded engineering pipeline reached success.');
  else add('not-complete', -35, `Pipeline status is ${result.status}.`);

  if (result.plan) {
    const delta = Math.round((result.plan.confidence - 0.5) * 20);
    add('plan-confidence', delta, `Planner confidence ${(result.plan.confidence * 100).toFixed(0)}%.`);
    if (result.plan.tasks.length > 1) {
      add('decomposition', 4, `${result.plan.tasks.length} bounded tasks were planned.`);
    }
  } else if (result.changedFiles.length > 0) {
    add('missing-plan', -8, 'Files changed without an attached engineering plan.');
  }

  if (result.validation.length > 0) {
    const passed = result.validation.filter((item) => item.ok).length;
    const failed = result.validation.length - passed;
    if (failed === 0) add('deterministic-validation', 18, `${passed} deterministic checks passed.`);
    else add('deterministic-validation', -30, `${failed} deterministic checks failed.`);
  } else if (result.changedFiles.length > 0) {
    add('no-validation', -12, 'No deterministic validation evidence was available for changed code.');
  }

  if (result.review) {
    if (result.review.verdict === 'pass') {
      add(
        'adversarial-review',
        Math.round(8 + result.review.confidence * 8),
        `Adversarial review passed at ${(result.review.confidence * 100).toFixed(0)}% confidence.`
      );
    } else {
      add('adversarial-review', -25, `Review verdict is ${result.review.verdict}.`);
    }
    const high = result.review.issues.filter((issue) => issue.severity === 'high').length;
    if (high > 0) add('high-review-issues', -10 * high, `${high} high-severity review issue(s) remain recorded.`);
  }

  if (result.execution) {
    const total = Math.max(1, result.execution.totals.tasks);
    const ratio = result.execution.totals.successfulTasks / total;
    add('task-completion', Math.round((ratio - 0.5) * 12), `${result.execution.totals.successfulTasks}/${total} tasks succeeded.`);
  }

  if (result.repairRounds > 0) {
    add('repair-cost', -4 * result.repairRounds, `${result.repairRounds} repair round(s) were required.`);
  }

  if (cognitive) {
    if (cognitive.effort === 'high') add('deep-deliberation', 4, 'High-effort pre-implementation deliberation was selected.');
    if (cognitive.effort === 'max') add('max-deliberation', 7, 'Maximum local test-time compute was selected.');
    if (cognitive.reviewPasses >= 2) add('independent-review', 5, `${cognitive.reviewPasses} independent review perspectives were requested.`);
  }

  if (result.investigation.evidenceFiles.length >= 3) {
    add('repository-evidence', 4, `${result.investigation.evidenceFiles.length} repository evidence files supported the run.`);
  }
  if (result.investigation.researchRequests.length > 0) {
    add('external-uncertainty', -5, 'The run encountered external knowledge dependencies.');
  }

  score = clamp(score);
  const band: QualityBand =
    score >= 90 ? 'excellent' : score >= 80 ? 'strong' : score >= 65 ? 'guarded' : 'weak';
  return { score, band, threshold, passed: score >= threshold, signals };
}
