import * as z from 'zod/v4';

import type { LocalCoderConfig } from './config.js';
import type { CognitiveProfile } from './cognitive-policy.js';
import type { OllamaClient, OllamaGeneration } from './ollama.js';
import { reportProgress } from './progress-context.js';

type DeliberationModel = Pick<OllamaClient, 'chat'>;

const proposalSchema = z.object({
  summary: z.string().min(1).max(3000),
  proposals: z
    .array(
      z.object({
        id: z.string().min(1).max(60),
        approach: z.string().min(1).max(2000),
        strengths: z.array(z.string().min(1).max(1000)).max(8).default([]),
        weaknesses: z.array(z.string().min(1).max(1000)).max(8).default([]),
        assumptions: z.array(z.string().min(1).max(1000)).max(8).default([])
      })
    )
    .min(2)
    .max(4)
});

const critiqueSchema = z.object({
  summary: z.string().min(1).max(3000),
  critiques: z
    .array(
      z.object({
        proposalId: z.string().min(1).max(60),
        fatalFlaws: z.array(z.string().min(1).max(1200)).max(8).default([]),
        hiddenRisks: z.array(z.string().min(1).max(1200)).max(8).default([]),
        missingEvidence: z.array(z.string().min(1).max(1200)).max(8).default([]),
        score: z.number().min(0).max(100)
      })
    )
    .min(2)
    .max(4),
  crossCuttingConcerns: z.array(z.string().min(1).max(1200)).max(10).default([])
});

const judgeSchema = z.object({
  summary: z.string().min(1).max(4000),
  selectedProposalId: z.string().min(1).max(60),
  confidence: z.number().min(0).max(1),
  principles: z.array(z.string().min(1).max(1200)).max(12).default([]),
  rejectedAlternatives: z.array(z.string().min(1).max(1200)).max(8).default([]),
  researchRequests: z.array(z.string().min(1).max(1200)).max(8).default([]),
  unresolvedDecision: z
    .object({
      question: z.string().min(1).max(1200),
      rationale: z.string().min(1).max(1200),
      options: z
        .array(
          z.object({
            id: z.string().min(1).max(80),
            label: z.string().min(1).max(300),
            tradeoff: z.string().min(1).max(1000)
          })
        )
        .min(2)
        .max(6),
      recommendedOptionId: z.string().min(1).max(80).optional()
    })
    .optional()
});

const proposalFormat = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'proposals'],
  properties: {
    summary: { type: 'string' },
    proposals: {
      type: 'array', minItems: 2, maxItems: 4,
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'approach', 'strengths', 'weaknesses', 'assumptions'],
        properties: {
          id: { type: 'string' }, approach: { type: 'string' },
          strengths: { type: 'array', maxItems: 8, items: { type: 'string' } },
          weaknesses: { type: 'array', maxItems: 8, items: { type: 'string' } },
          assumptions: { type: 'array', maxItems: 8, items: { type: 'string' } }
        }
      }
    }
  }
} satisfies Record<string, unknown>;

const critiqueFormat = {
  type: 'object', additionalProperties: false, required: ['summary', 'critiques', 'crossCuttingConcerns'],
  properties: {
    summary: { type: 'string' },
    critiques: {
      type: 'array', minItems: 2, maxItems: 4,
      items: {
        type: 'object', additionalProperties: false,
        required: ['proposalId', 'fatalFlaws', 'hiddenRisks', 'missingEvidence', 'score'],
        properties: {
          proposalId: { type: 'string' },
          fatalFlaws: { type: 'array', maxItems: 8, items: { type: 'string' } },
          hiddenRisks: { type: 'array', maxItems: 8, items: { type: 'string' } },
          missingEvidence: { type: 'array', maxItems: 8, items: { type: 'string' } },
          score: { type: 'number', minimum: 0, maximum: 100 }
        }
      }
    },
    crossCuttingConcerns: { type: 'array', maxItems: 10, items: { type: 'string' } }
  }
} satisfies Record<string, unknown>;

const judgeFormat = {
  type: 'object', additionalProperties: false,
  required: ['summary', 'selectedProposalId', 'confidence', 'principles', 'rejectedAlternatives', 'researchRequests', 'unresolvedDecision'],
  properties: {
    summary: { type: 'string' }, selectedProposalId: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    principles: { type: 'array', maxItems: 12, items: { type: 'string' } },
    rejectedAlternatives: { type: 'array', maxItems: 8, items: { type: 'string' } },
    researchRequests: { type: 'array', maxItems: 8, items: { type: 'string' } },
    unresolvedDecision: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['question', 'rationale', 'options', 'recommendedOptionId'],
      properties: {
        question: { type: 'string' }, rationale: { type: 'string' },
        options: {
          type: 'array', minItems: 2, maxItems: 6,
          items: {
            type: 'object', additionalProperties: false,
            required: ['id', 'label', 'tradeoff'],
            properties: { id: { type: 'string' }, label: { type: 'string' }, tradeoff: { type: 'string' } }
          }
        },
        recommendedOptionId: { type: 'string' }
      }
    }
  }
} satisfies Record<string, unknown>;

const ARCHITECT_PROMPT = `You are Architect A in a deliberate software-engineering system.
Generate materially distinct implementation approaches grounded only in supplied repository evidence and user requirements.
Do not pick a winner yet. Avoid fake alternatives that differ only cosmetically. Surface assumptions explicitly.
Return only schema-valid JSON.`;

const CRITIC_PROMPT = `You are an adversarial architecture critic. You did not author the proposals.
Try to falsify each proposal against the original goal, repository evidence, contracts, validation surface and long-term maintenance.
Look for hidden blast radius, missing evidence, edge cases, reversibility problems and unnecessary novelty.
Score proposals independently. Return only schema-valid JSON.`;

const JUDGE_PROMPT = `You are the final architecture judge in a deliberate software-engineering system.
Select the approach best supported by repository evidence after considering the independent critique.
Prefer existing conventions and the smallest coherent reversible change. Do not invent user preferences.
If two viable approaches remain and the choice materially changes product/UX/architecture/maintenance, return one unresolvedDecision instead of guessing.
Put any current external facts still required in researchRequests. Return only schema-valid JSON.`;

export interface DeliberationOutcome {
  summary: string;
  selectedProposalId: string;
  confidence: number;
  principles: string[];
  rejectedAlternatives: string[];
  researchRequests: string[];
  unresolvedDecision?: z.infer<typeof judgeSchema>['unresolvedDecision'];
  generations: OllamaGeneration[];
  passes: number;
}

function compact(value: unknown, limit = 18_000): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > limit ? `${text.slice(0, limit)}\n[truncated]` : text;
}

export async function runArchitecturalDeliberation(
  model: DeliberationModel,
  config: LocalCoderConfig,
  profile: CognitiveProfile,
  input: { goal: string; context?: string; constraints?: string[]; guidance?: string },
  repositoryEvidence: string
): Promise<DeliberationOutcome | undefined> {
  if (profile.deliberationPasses <= 0) return undefined;

  reportProgress({
    phase: 'deliberation',
    action: 'Generating independent architecture candidates',
    detail: `Cognitive effort ${profile.effort}; ${profile.deliberationPasses} deliberate passes requested.`,
    reasoningSummary:
      'Hard tasks buy extra local test-time compute before implementation. Claude tokens are not being used.'
  });

  const common = [
    `# GOAL\n${input.goal}`,
    input.context ? `# CONTEXT\n${input.context}` : '',
    input.constraints?.length ? `# CONSTRAINTS\n${input.constraints.map((item) => `- ${item}`).join('\n')}` : '',
    input.guidance ? `# RESOLVED USER/PREMIUM GUIDANCE\n${input.guidance}` : '',
    `# REPOSITORY EVIDENCE\n${repositoryEvidence}`
  ].filter(Boolean).join('\n\n');

  const generations: OllamaGeneration[] = [];
  const proposalGeneration = await model.chat(ARCHITECT_PROMPT, common, proposalFormat, {
    model: config.model,
    numCtx: config.ollamaNumCtx ?? 16_384,
    keepAlive: config.fastModelKeepAlive ?? '90s',
    think: profile.effort === 'max' ? 'high' : 'medium',
    maxTokens: Math.min(config.planningMaxTokens ?? 3_072, 2_800)
  });
  generations.push(proposalGeneration);
  const proposals = proposalSchema.parse(JSON.parse(proposalGeneration.content) as unknown);

  const critiques: z.infer<typeof critiqueSchema>[] = [];
  const critiquePasses = Math.max(1, Math.min(profile.deliberationPasses - 1, 2));
  for (let pass = 0; pass < critiquePasses; pass += 1) {
    reportProgress({
      phase: 'deliberation',
      action: `Adversarial architecture critique ${pass + 1}/${critiquePasses}`,
      reasoningSummary:
        'A fresh critic context is trying to disprove the candidate approaches instead of defending the first idea.'
    });
    const critiqueGeneration = await model.chat(
      CRITIC_PROMPT,
      `${common}\n\n# CANDIDATE PROPOSALS\n${compact(proposals)}\n\n# CRITIC PERSPECTIVE\n${pass === 0 ? 'Correctness, hidden impact and missing evidence.' : 'Regression risk, maintainability, operational failure modes and reversibility.'}`,
      critiqueFormat,
      {
        model: config.model,
        numCtx: config.ollamaNumCtx ?? 16_384,
        keepAlive: config.fastModelKeepAlive ?? '90s',
        think: profile.effort === 'max' ? 'high' : 'medium',
        maxTokens: Math.min(config.planningMaxTokens ?? 3_072, 2_600)
      }
    );
    generations.push(critiqueGeneration);
    critiques.push(critiqueSchema.parse(JSON.parse(critiqueGeneration.content) as unknown));
  }

  reportProgress({
    phase: 'deliberation',
    action: 'Judging architecture candidates against evidence',
    reasoningSummary:
      'The judge receives candidate summaries and independent critiques, not the hidden reasoning text of prior calls.'
  });
  const judgeGeneration = await model.chat(
    JUDGE_PROMPT,
    `${common}\n\n# CANDIDATE PROPOSALS\n${compact(proposals)}\n\n# INDEPENDENT CRITIQUES\n${compact(critiques)}`,
    judgeFormat,
    {
      model: config.model,
      numCtx: config.ollamaNumCtx ?? 16_384,
      keepAlive: config.fastModelKeepAlive ?? '90s',
      think: profile.effort === 'max' ? 'high' : 'medium',
      maxTokens: Math.min(config.planningMaxTokens ?? 3_072, 2_800)
    }
  );
  generations.push(judgeGeneration);
  const judged = judgeSchema.parse(JSON.parse(judgeGeneration.content) as unknown);

  return {
    summary: judged.summary,
    selectedProposalId: judged.selectedProposalId,
    confidence: judged.confidence,
    principles: judged.principles,
    rejectedAlternatives: judged.rejectedAlternatives,
    researchRequests: judged.researchRequests,
    unresolvedDecision: judged.unresolvedDecision ?? undefined,
    generations,
    passes: generations.length
  };
}
