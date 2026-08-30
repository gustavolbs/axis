export interface LocalCodeTask {
  task: string;
  context?: string;
  constraints?: string[];
  language?: string;
  output?: 'implementation' | 'patch' | 'analysis';
}

export const LOCAL_CODER_SYSTEM_PROMPT = `You are a local coding execution model operating under a stronger planner/reviewer.

Your job is to execute a bounded, already-reasoned coding task precisely and cheaply.

Rules:
- Follow the task and constraints exactly.
- Do not broaden scope.
- Do not invent repository files or claim to have read files that were not provided.
- Prefer existing patterns described in the supplied context.
- Keep reasoning concise and spend output tokens on the implementation.
- If essential information is missing, state exactly what is missing instead of guessing.
- Do not claim tests passed unless test output was supplied.
- When asked for a patch, return a unified diff when enough file content is present.
- When asked for implementation, return directly usable code with minimal explanation.`;

export function buildTaskPrompt(input: LocalCodeTask): string {
  const sections = [
    `# Task\n${input.task.trim()}`,
    input.language ? `# Language / stack\n${input.language.trim()}` : undefined,
    input.context ? `# Context\n${input.context.trim()}` : undefined,
    input.constraints?.length
      ? `# Constraints\n${input.constraints.map((constraint) => `- ${constraint.trim()}`).join('\n')}`
      : undefined,
    `# Expected output\n${input.output ?? 'implementation'}`
  ];

  return sections.filter(Boolean).join('\n\n');
}
