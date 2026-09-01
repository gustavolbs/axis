export type TaskRoute = 'deterministic' | 'local' | 'local-supervised' | 'guidance';

export interface TaskClassificationInput {
  task: string;
  solutionKnown?: boolean;
  requiresDiscovery?: boolean;
  requiresArchitecture?: boolean;
  estimatedFiles?: number;
  validationKnown?: boolean;
  riskTags?: string[];
  sensitiveDecisionResolved?: boolean;
}

export interface TaskClassification {
  route: TaskRoute;
  confidence: number;
  reasons: string[];
  reviewPolicy: {
    mode: 'none' | 'compact' | 'full-diff';
    independentReviewRequired: boolean;
  };
  signals: {
    highRisk: string[];
    blockingRisk: string[];
    supervisedRisk: string[];
    localFriendly: string[];
    deterministic: string[];
  };
}

const BLOCKING_RISK_PATTERNS: Array<[RegExp, string]> = [
  [/\b(cryptography|cryptographic|encryption|decryption|decrypt|signing|key derivation|certificate validation)\b/i, 'cryptography design'],
  [/\b(migration|schema change|drop table|production data|backfill)\b/i, 'data migration'],
  [/\b(kubernetes|terraform|production infra|deployment pipeline|iam|cloudformation)\b/i, 'production infrastructure'],
  [/\b(race condition|deadlock|concurren|thread safety|atomicity)\b/i, 'concurrency'],
  [/\b(architecture|architectural|system design|cross-service|distributed transaction)\b/i, 'architecture'],
  [/\b(root cause unknown|investigate|diagnose unknown|incident)\b/i, 'open-ended debugging'],
  [/\b(subtle performance|memory leak|profiling|latency regression)\b/i, 'performance investigation']
];

const SUPERVISED_RISK_PATTERNS: Array<[RegExp, string]> = [
  [/\b(auth(?:entication|orization)?|oauth|permission|permissions|rbac|acl)\b/i, 'authentication/authorization'],
  [/\b(secret|secrets|credential|credentials|access token|refresh token|session token|api key)\b/i, 'sensitive credential handling']
];

const LOCAL_FRIENDLY_PATTERNS: Array<[RegExp, string]> = [
  [/\b(test|spec|vitest|jest|storybook|fixture|mock)\b/i, 'tests/fixtures/storybook'],
  [/\b(rename|mechanical refactor|boilerplate|adapter|mapper|serializer)\b/i, 'mechanical implementation'],
  [/\b(type error|typescript|lint fix|typed|interface implementation)\b/i, 'typed implementation'],
  [/\b(component|react|crud|wiring|validation|loading state|empty state)\b/i, 'bounded product code'],
  [/\b(add|update|change|implement|replace|remove|delete)\b/i, 'implementation verb']
];

const DETERMINISTIC_PATTERNS: Array<[RegExp, string]> = [
  [/^\s*(run|execute)\s+(the\s+)?(tests?|test suite|lint|typecheck|type check|build)\b/i, 'run existing command'],
  [/^\s*(format|prettify)\s+(the\s+)?(file|files|code|repository|repo)\b/i, 'formatter task'],
  [/^\s*(grep|search|find)\s+for\b/i, 'text search task'],
  [/^\s*(generate|regenerate)\s+using\s+(the\s+)?existing\s+(generator|codemod)\b/i, 'existing deterministic generator']
];

const BLOCKING_RISK_TAGS = new Set([
  'cryptography',
  'crypto-design',
  'migration',
  'production-infra',
  'concurrency',
  'architecture',
  'incident',
  'unknown-debugging'
]);

const SUPERVISED_RISK_TAGS = new Set([
  'security',
  'auth',
  'authentication',
  'authorization',
  'credentials',
  'credential',
  'permissions',
  'permission',
  'secrets',
  'sessions',
  'tokens'
]);

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function classification(
  route: TaskRoute,
  confidence: number,
  reasons: string[],
  signals: TaskClassification['signals']
): TaskClassification {
  return {
    route,
    confidence: clamp(confidence),
    reasons,
    reviewPolicy: {
      mode: route === 'local-supervised' ? 'full-diff' : route === 'local' ? 'compact' : 'none',
      independentReviewRequired: route === 'local' || route === 'local-supervised'
    },
    signals
  };
}

export function classifyTask(input: TaskClassificationInput): TaskClassification {
  const task = input.task.trim();
  const blockingRisk = BLOCKING_RISK_PATTERNS.filter(([pattern]) => pattern.test(task)).map(([, label]) => label);
  const supervisedRisk = SUPERVISED_RISK_PATTERNS.filter(([pattern]) => pattern.test(task)).map(([, label]) => label);
  const localFriendly = LOCAL_FRIENDLY_PATTERNS.filter(([pattern]) => pattern.test(task)).map(([, label]) => label);
  const deterministic = DETERMINISTIC_PATTERNS.filter(([pattern]) => pattern.test(task)).map(([, label]) => label);
  const riskTags = (input.riskTags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean);

  blockingRisk.push(
    ...riskTags.filter((tag) => BLOCKING_RISK_TAGS.has(tag)).map((tag) => `risk-tag:${tag}`)
  );
  supervisedRisk.push(
    ...riskTags.filter((tag) => SUPERVISED_RISK_TAGS.has(tag)).map((tag) => `risk-tag:${tag}`)
  );

  const highRisk = [...blockingRisk, ...supervisedRisk];
  const signals: TaskClassification['signals'] = {
    highRisk,
    blockingRisk,
    supervisedRisk,
    localFriendly,
    deterministic
  };
  const reasons: string[] = [];

  if (deterministic.length > 0 && !input.requiresDiscovery && !input.requiresArchitecture) {
    reasons.push('The requested work is better handled by an existing deterministic tool than by an LLM.');
    return classification('deterministic', 0.92, reasons, signals);
  }

  if (input.requiresArchitecture) reasons.push('Architecture decisions are still required.');
  if (input.requiresDiscovery) reasons.push('The implementation still requires repository/problem discovery.');
  if (input.solutionKnown === false) reasons.push('The solution/approach is not known yet.');
  if ((input.estimatedFiles ?? 0) > 8) reasons.push('The estimated change spans more than 8 files.');
  if (blockingRisk.length > 0) reasons.push(`Blocking risk detected: ${blockingRisk.join(', ')}.`);

  if (reasons.length > 0) {
    reasons.push('Resolve the missing decision/evidence through the standalone guidance checkpoint before bounded implementation.');
    return classification(
      'guidance',
      0.82 + Math.min(0.15, reasons.length * 0.03),
      reasons,
      signals
    );
  }

  if (supervisedRisk.length > 0) {
    const unresolved: string[] = [];
    if (input.sensitiveDecisionResolved !== true) {
      unresolved.push('The sensitive behavior has not been explicitly marked as resolved.');
    }
    if (input.solutionKnown !== true) {
      unresolved.push('The implementation approach is not explicitly known.');
    }
    if (input.validationKnown !== true) {
      unresolved.push('A concrete validation path is not explicitly known.');
    }
    if ((input.estimatedFiles ?? 0) <= 0 || (input.estimatedFiles ?? 0) > 8) {
      unresolved.push('The sensitive implementation is not explicitly bounded to 1-8 editable files.');
    }

    if (unresolved.length > 0) {
      reasons.push(`Sensitive domain detected: ${supervisedRisk.join(', ')}.`);
      reasons.push(...unresolved);
      reasons.push(
        'The standalone agent must obtain the bounded sensitive decision before implementation resumes with sensitiveDecisionResolved=true.'
      );
      return classification('guidance', 0.9, reasons, signals);
    }

    reasons.push(`Sensitive domain detected but its decisions are already resolved: ${supervisedRisk.join(', ')}.`);
    reasons.push('Only bounded implementation remains for the local executor.');
    reasons.push('Full independent diff review is mandatory after local execution.');
    return classification('local-supervised', 0.9, reasons, signals);
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

    return classification(
      'local',
      0.72 + Math.min(0.22, score * 0.035),
      reasons,
      signals
    );
  }

  reasons.push('The task is not clearly deterministic or safely bounded for the local executor.');
  reasons.push('Request bounded guidance until the implementation boundary is clear.');
  return classification('guidance', 0.64, reasons, signals);
}
