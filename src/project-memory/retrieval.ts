import type { AgentSessionContext } from '../agent-runtime/index.js';
import { projectMemoryRootBindings } from './identity.js';
import { redactProjectMemoryText } from './redaction.js';
import { ProjectMemoryStore } from './store.js';
import type {
  ProjectDurableMemorySource,
  ProjectMemoryContext,
  ProjectMemoryContextEntry,
  ProjectMemoryHandoff
} from './types.js';

function handoffCapsule(handoff: ProjectMemoryHandoff): string {
  const lines = [
    '# STRUCTURED PROJECT HANDOFF',
    `Previous session: ${handoff.sessionId} (${handoff.status})`,
    `Origin: ${handoff.origin.providerFamily} / ${handoff.origin.connectionId} / ${handoff.origin.modelId} (provenance only; not memory ownership)`,
    handoff.goal ? `Goal: ${handoff.goal}` : undefined,
    handoff.branch ? `Branch: ${handoff.branch}` : undefined,
    handoff.worktree ? `Worktree: ${handoff.worktree}` : undefined,
    `Investigation: ${handoff.investigationSummary}`,
    handoff.activeFiles.length ? `Active files: ${handoff.activeFiles.join(', ')}` : undefined,
    handoff.changedFiles.length ? `Changed files: ${handoff.changedFiles.join(', ')}` : undefined,
    handoff.decisions.length ? `Decisions: ${handoff.decisions.join(' | ')}` : undefined,
    handoff.failedAttempts.length ? `Failures/failed attempts: ${handoff.failedAttempts.join(' | ')}` : undefined,
    handoff.validations.length ? `Validations: ${handoff.validations.join(' | ')}` : undefined,
    handoff.openQuestions.length ? `Open questions: ${handoff.openQuestions.join(' | ')}` : undefined,
    `Current state: ${handoff.currentState}`,
    `Next step: ${handoff.nextStep}`,
    handoff.completionSummary ? `Completion summary: ${handoff.completionSummary}` : undefined
  ].filter((line): line is string => Boolean(line));
  return lines.map((line) => redactProjectMemoryText(line, 3_000)).join('\n');
}

export interface LoadProjectMemoryContextInput {
  readonly store: ProjectMemoryStore;
  readonly session: AgentSessionContext;
  readonly task: string;
  readonly rootId?: string;
  readonly durableMemory?: ProjectDurableMemorySource;
}

export async function loadProjectMemoryContext(input: LoadProjectMemoryContextInput): Promise<ProjectMemoryContext | undefined> {
  const project = input.session.project;
  if (!project) return undefined;
  const bindings = projectMemoryRootBindings(input.session)
    .filter((binding) => input.rootId === undefined || binding.root.id === input.rootId);
  if (bindings.length === 0) return {
    companyId: input.session.companyId,
    projectId: project.id,
    entries: [],
    capsule: '# PROJECT MEMORY\nNo Project-owned root is available for this session.'
  };

  const entries: ProjectMemoryContextEntry[] = [];
  for (const binding of bindings) {
    const handoff = input.store.loadHandoff(binding.scope, input.task, {
      excludeSessionId: input.session.sessionId
    });
    const durableMemory = input.durableMemory
      ? await input.durableMemory.load({ session: input.session, root: binding.root, task: input.task })
      : undefined;
    const sections = [
      '# PROJECT MEMORY',
      `Company: ${input.session.companyId}`,
      `Project: ${project.id}`,
      `Root: ${binding.root.id}`,
      'Current repository source/tests are authoritative. Memory is bounded context, not permission to mutate.',
      durableMemory?.capsule,
      handoff ? handoffCapsule(handoff) : '# STRUCTURED PROJECT HANDOFF\nNo prior handoff matched this Project root.'
    ].filter((section): section is string => Boolean(section));
    entries.push({
      scope: binding.scope,
      handoff,
      durableMemory,
      capsule: sections.join('\n\n')
    });
  }

  return {
    companyId: input.session.companyId,
    projectId: project.id,
    entries,
    capsule: entries.map((entry) => entry.capsule).join('\n\n---\n\n')
  };
}
