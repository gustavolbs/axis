export interface ReviewCapsule {
  changedFiles: number;
  additions: number;
  deletions: number;
  risk: 'low' | 'medium' | 'high';
  flags: string[];
  reviewTargets: string[];
  validationPassed: boolean;
  fullDiffRecommended: boolean;
}

function diffCounts(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions += 1;
    if (line.startsWith('-')) deletions += 1;
  }

  return { additions, deletions };
}

function changedFileNames(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split(/\r?\n/)) {
    const match = line.match(/^---\s+(.+?)\s+\(before(?: plan)?\)/);
    if (match?.[1]) files.add(match[1]);
  }
  return [...files];
}

export function buildReviewCapsule(input: {
  diff: string;
  changedFiles: string[];
  validationPassed: boolean;
}): ReviewCapsule {
  const { additions, deletions } = diffCounts(input.diff);
  const files = input.changedFiles.length > 0 ? input.changedFiles : changedFileNames(input.diff);
  const flags: string[] = [];
  const joinedFiles = files.join('\n').toLowerCase();
  const diff = input.diff;

  if (/package\.json|(?:^|\/)package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lock/m.test(joinedFiles)) {
    flags.push('dependency-or-package-metadata-changed');
  }
  if (/(?:^|\/)\.env(?:\.|$)/m.test(joinedFiles)) flags.push('environment-file-touched');
  if (/\b(auth|oauth|permission|rbac|acl|credential|secret|crypt|encrypt|signing)\b/i.test(`${joinedFiles}\n${diff}`)) {
    flags.push('security-sensitive-signal');
  }
  if (/^\+.*(?:@ts-ignore|@ts-expect-error|eslint-disable|biome-ignore)/m.test(diff)) {
    flags.push('suppression-added');
  }
  if (/^\+.*\bexport\s+(?:default\s+)?(?:type|interface|class|function|const|let|var|enum)\b/m.test(diff)) {
    flags.push('export-surface-changed');
  }
  if (/migration|schema|terraform|kubernetes|cloudformation/i.test(joinedFiles)) {
    flags.push('high-impact-file-signal');
  }
  if (!input.validationPassed) flags.push('validation-not-clean');
  if (files.length > 12 || additions + deletions > 700) flags.push('large-change-set');

  const high = flags.some((flag) =>
    ['security-sensitive-signal', 'environment-file-touched', 'high-impact-file-signal', 'validation-not-clean'].includes(flag)
  );
  const medium = flags.length > 0 || files.length > 6 || additions + deletions > 300;
  const risk: ReviewCapsule['risk'] = high ? 'high' : medium ? 'medium' : 'low';

  return {
    changedFiles: files.length,
    additions,
    deletions,
    risk,
    flags,
    reviewTargets: files.slice(0, 12),
    validationPassed: input.validationPassed,
    fullDiffRecommended: risk === 'high' || additions + deletions > 500
  };
}
