export interface PreparedInferencePrompt {
  userPrompt: string;
  originalUserPromptChars: number;
  truncated: boolean;
}

export function isPlanningSystemPrompt(systemPrompt: string): boolean {
  return systemPrompt
    .toLowerCase()
    .includes('reasoning/planning stage of a local software-engineering agent');
}

export function preparePromptForInference(
  systemPrompt: string,
  userPrompt: string,
  numCtx = 16_384
): PreparedInferencePrompt {
  if (!isPlanningSystemPrompt(systemPrompt)) {
    return { userPrompt, originalUserPromptChars: userPrompt.length, truncated: false };
  }

  // 48k characters is intentionally conservative for a 16k-token code context. It
  // leaves output/reasoning headroom instead of filling the entire context with repo text.
  const budget = Math.min(48_000, Math.max(24_000, numCtx * 3));
  if (userPrompt.length <= budget) {
    return { userPrompt, originalUserPromptChars: userPrompt.length, truncated: false };
  }

  // Planning prompts put goal/constraints first and validation candidates last. Preserve
  // both ends and trim the large evidence middle.
  const marker = '\n\n...[planning evidence truncated to stay within local context budget]...\n\n';
  const tailChars = Math.min(8_000, Math.floor(budget * 0.18));
  const headChars = Math.max(1, budget - tailChars - marker.length);
  return {
    userPrompt: userPrompt.slice(0, headChars) + marker + userPrompt.slice(-tailChars),
    originalUserPromptChars: userPrompt.length,
    truncated: true
  };
}
