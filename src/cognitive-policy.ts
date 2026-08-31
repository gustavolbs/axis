import type { CognitiveMode } from './config.js';
import type { LocalEngineerInput } from './local-engineer.js';

export type CognitiveEffort = 'low' | 'medium' | 'high' | 'max';

export interface CognitiveSignals {
  repositoryFiles: number;
  relevantFiles: number;
  packageScripts: number;
  repoFamiliarity?: number;
}

export interface CognitiveProfile {
  effort: CognitiveEffort;
  score: number;
  reasons: string[];
  deliberationPasses: number;
  reviewPasses: number;
  independentAudit: boolean;
}

const HIGH_IMPACT = /\b(?:architecture|architectural|migration|distributed|concurren|race condition|transaction|database|schema|authentication|authorization|permission|security|cache invalidation|queue|event[- ]driven|multi[- ]service|cross[- ]cutting|platform|public api|breaking change|performance|scalab|reliab|offline|sync|billing|payment)\b/i;
const VERY_HIGH_IMPACT = /\b(?:cryptograph|encryption|destructive migration|production data|production iam|root credentials?|multi-region|consensus|distributed transaction|zero downtime migration)\b/i;
const LARGE_SCOPE = /\b(?:entire|whole|complete|end[- ]to[- ]end|large feature|new feature|dashboard|workflow|system|redesign|replatform|rewrite|across the repo|across the application)\b/i;
const AMBIGUITY = /\b(?:choose|decide|which approach|trade[- ]off|not sure|unsure|best way|how should|architecture choice|strategy)\b/i;
const SIMPLE_CHANGE = /\b(?:rename|typo|copy change|small test|add test|single component|single endpoint|small fix|minor fix)\b/i;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function forcedProfile(mode: CognitiveMode): CognitiveProfile | undefined {
  if (mode === 'adaptive') return undefined;
  if (mode === 'fast') {
    return {
      effort: 'low',
      score: 10,
      reasons: ['Cognitive mode forced to fast.'],
      deliberationPasses: 0,
      reviewPasses: 1,
      independentAudit: false
    };
  }
  if (mode === 'deep') {
    return {
      effort: 'high',
      score: 60,
      reasons: ['Cognitive mode forced to deep.'],
      deliberationPasses: 2,
      reviewPasses: 2,
      independentAudit: true
    };
  }
  return {
    effort: 'max',
    score: 90,
    reasons: ['Cognitive mode forced to max.'],
    deliberationPasses: 3,
    reviewPasses: 3,
    independentAudit: true
  };
}

export function assessCognitiveEffort(
  input: Pick<LocalEngineerInput, 'goal' | 'context' | 'constraints'>,
  signals: CognitiveSignals,
  mode: CognitiveMode = 'adaptive',
  maxDeliberationPasses = 3
): CognitiveProfile {
  const forced = forcedProfile(mode);
  if (forced) {
    return {
      ...forced,
      deliberationPasses: Math.min(forced.deliberationPasses, maxDeliberationPasses)
    };
  }

  const text = [input.goal, input.context ?? '', ...(input.constraints ?? [])].join('\n');
  const reasons: string[] = [];
  let score = 10;

  if (HIGH_IMPACT.test(text)) {
    score += 22;
    reasons.push('The request contains high-impact architecture/runtime concerns.');
  }
  if (VERY_HIGH_IMPACT.test(text)) {
    score += 28;
    reasons.push('The request contains very-high-impact or difficult-to-reverse concerns.');
  }
  if (LARGE_SCOPE.test(text)) {
    score += 14;
    reasons.push('The requested scope appears cross-cutting or feature-sized.');
  }
  if (AMBIGUITY.test(text)) {
    score += 10;
    reasons.push('The request contains an explicit architecture/product ambiguity.');
  }
  if (text.length > 2_000) {
    score += 8;
    reasons.push('The goal/context is unusually detailed and likely multi-constraint.');
  }
  if ((input.constraints?.length ?? 0) >= 6) {
    score += 8;
    reasons.push('Many explicit constraints increase coordination complexity.');
  }
  if (signals.relevantFiles >= 8) {
    score += 10;
    reasons.push('Repository evidence spans many relevant files.');
  }
  if (signals.repositoryFiles >= 500) {
    score += 8;
    reasons.push('The repository is large enough to increase hidden-impact risk.');
  }
  if (signals.packageScripts >= 8) {
    score += 4;
    reasons.push('The repository exposes a broad validation/build surface.');
  }
  if (typeof signals.repoFamiliarity === 'number' && signals.repoFamiliarity >= 0.75) {
    score -= 8;
    reasons.push('Strong repository familiarity reduces discovery uncertainty.');
  }
  if (SIMPLE_CHANGE.test(text) && !HIGH_IMPACT.test(text) && signals.relevantFiles <= 4) {
    score -= 12;
    reasons.push('The request looks bounded and follows a small-change pattern.');
  }

  score = clamp(score, 0, 100);
  const effort: CognitiveEffort =
    score >= 72 ? 'max' : score >= 48 ? 'high' : score >= 25 ? 'medium' : 'low';
  const deliberationPasses = Math.min(
    maxDeliberationPasses,
    effort === 'max' ? 3 : effort === 'high' ? 2 : 0
  );
  const reviewPasses = effort === 'max' ? 3 : effort === 'high' ? 2 : 1;

  return {
    effort,
    score,
    reasons: reasons.length ? reasons : ['Bounded request with no strong complexity signals.'],
    deliberationPasses,
    reviewPasses,
    independentAudit: effort === 'high' || effort === 'max'
  };
}
