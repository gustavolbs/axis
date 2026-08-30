export type TaskRoute = 'deterministic' | 'local' | 'claude';

export interface TaskClassificationInput {
  task: string;
  solutionKnown?: boolean;
  requiresDiscovery?: boolean;
  requiresArchitecture?: boolean;
  estimatedFiles?: number;
  validationKnown?: boolean;
  riskTags?: string[];
}

export interface TaskClassification {
  route: TaskRoute;
  confidence: number;
  reasons: string[];
  signals: {
    highRisk: string[];
    localFriendly: string[];
    deterministic: string[];
  };
}

const HIGH_RISK_PATTERNS: Array<[RegExp, string]> = [
  [/\b(auth(?:entication|orization)?|oauth|permission|rbac|acl)\b/i, 'authentication/authorization'],
  [/\b(secret|credential|token handling|cryptograph|encryption|signing)\b/i, 'security/cryptography'],
  [/\b(migration|schema change|drop table|production data|backfill)\b/i, 'data migration'],
  [/\b(kubernetes|terraform|production infra|deployment pipeline|iam|cloudformation)\b/i, 'production infrastructure'],
  [/\b(race condition|deadlock|concurren|thread safety|atomicity)\b/i, 'concurrency'],
  [/\b(architecture|architectural|system design|cross-service|distributed transaction)\b/i, 'architecture'],
  [/\b(root cause unknown|investigate|diagnose unknown|incident)\b/i, 'open-ended debugging'],
  [/\b(subtle performance|memory leak|profiling|latency regression)\b/i, 'performance investigation']
];

const LOCAL_FRIENDLY_PATTERNS: Array<[RegExp, string]> = [
  [/\b(test|spec|vitest|jest|storybook|fixture|mock)\b/i, 'tests/fixtures/storybook'],
  [/\b(rename|mechanical refactor|boilerplate|adapter|mapper|serializer)\b/i, 'mechanical implementation'],
  [/\b(type error|typescript|lint fix|typed|interface implementation)\b/i, 'typed implementation'],
  [/\b(component|react|crud|wiring|validation|loading state|empty state)\b/i, 'bounded product code'],
  [/\b(add|update|change|implement|replace)\b/i, 'implementation verb']
];

const DETERMINISTIC_PATTERNS: Array<[RegExp, string]> = [
  [/^\s*(run|execute)\s+(the\s+)?(tests?|test suite|lint|typecheck|type check|build)\b/i, 'run existing command'],
  [/^\s*(format|prettify)\s+(the\s+)?(file|files|code|repository|repo)\b/i, 'formatter task'],
  [/^\s*(grep|search|find)\s+for\b/i, 'text search task'],
  [/^\s*(generate|regenerate)\s+using\s+(the\s+)?existing\s+(generator|codemod)\b/i, 'existing deterministic generator']
];

const HIGH_RISK_TAGS = new Set([
  'security',
  'auth',
  'authorization',
  'cryptography',
  'secrets',
  'migration',
  'production-infra',
  'concurrency',
  'architecture',
  'incident',
  'unknown-debugging'
]);

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function classifyTask(input: TaskClassificationInput): TaskClassification {
  const task = input.task.trim();
  const highRisk = HIGH_RISK_PATTERNS.filter(([pattern]) => pattern.test(task)).map(([, label]) => label);
  const localFriendly = LOCAL_FRIENDLY_PATTERNS.filter(([pattern]) => pattern.test(task)).map(([, label]) => label);
  const deterministic = DETERMINISTIC_PATTERNS.filter(([pattern]) => pattern.test(task)).map(([, label]) => label);
  const riskTags = (input.riskTags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean);
  const taggedRisks = riskTags.filter((tag) => HIGH_RISK_TAGS.has(tag));
  highRisk.push(...taggedRisks.map((tag) => `risk-tag:${tag}`));

  const reasons: string[] = [];

  if (deterministic.length > 0 && highRisk.length === 0 && !input.requiresDiscovery && !input.requiresArchitecture) {
    reasons.push('The requested work is better handled by an existing deterministic tool than by an LLM.');
    return {
      route: 'deterministic',
      confidence: 0.92,
      reasons,
      signals: { highRisk, localFriendly, deterministic }
    };
  }

  if (input.requiresArchitecture) reasons.push('Architecture decisions are still required.');
  if (input.requiresDiscovery) reasons.push('The implementation still requires repository/problem discovery.');
  if (input.solutionKnown === false) reasons.push('The solution/approach is not known yet.');
  if ((input.estimatedFiles ?? 0) > 8) reasons.push('The estimated change spans more than 8 files.');
  if (highRisk.length > 0) reasons.push(`High-risk domain detected: ${highRisk.join(', ')}.`);

  if (reasons.length > 0) {
    const confidence = clamp(0.82 + Math.min(0.15, reasons.length * 0.03));
    return {
      route: 'claude',
      confidence,
      reasons,
      signals: { highRisk, localFriendly, deterministic }
    };
  }

  let score = 0;
  if (input.solutionKnown === true) score += 2;
  if (input.validationKnown === true) score += 1;
  if ((input.estimatedFiles ?? 0) > 0 && (input.estimatedFiles ?? 0) <= 5) score += 1;
  score += Math.min(2, localFriendly.length);

  if (score >= 3) {
    reasons.push('The task is bounded enough for local execution.');
    if (input.solutionKnown) reasons.push('The implementation approach is already known.');
    if (input.validationKnown) reasons.push('A concrete validation path is known.');
    if ((input.estimatedFiles ?? 0) > 0) reasons.push(`Estimated scope is ${input.estimatedFiles} file(s).`);
    if (localFriendly.length > 0) reasons.push(`Local-friendly signals: ${localFriendly.join(', ')}.`);

    return {
      route: 'local',
      confidence: clamp(0.72 + Math.min(0.22, score * 0.035)),
      reasons,
      signals: { highRisk, localFriendly, deterministic }
    };
  }

  reasons.push('The task is not clearly deterministic or safely bounded for the local executor.');
  reasons.push('Keep it in Claude until the implementation boundary is clearer.');
  return {
    route: 'claude',
    confidence: 0.64,
    reasons,
    signals: { highRisk, localFriendly, deterministic }
  };
}
