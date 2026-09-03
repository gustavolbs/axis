import { prepareContextCapsule, RepoIndexStore } from './context-capsule.js';
import type { LocalCoderConfig } from './config.js';
import { discoverWorkspace } from './discovery.js';
import { reportProgress } from './progress-context.js';
import type { ProjectDefinition } from './project-store.js';
import { resolveWorkspace } from './workspace.js';

const PROJECT_CHAT_MAX_FILES = 10;
const PROJECT_CHAT_MAX_CHARS_PER_FILE = 1_800;
const PROJECT_CHAT_MAP_FILES = 220;

/**
 * Project Chat is deliberately read-only, but it should still understand the
 * repository it is scoped to. This helper builds a bounded repository capsule
 * from the Project-owned workspace before the conversational model runs.
 *
 * The Project has already crossed the Company isolation boundary in
 * ProjectAwareEngineerBackend, so this function never accepts an arbitrary
 * caller-supplied root and never widens the allowed filesystem scope.
 */
export async function attachProjectChatRepositoryContext(
  config: LocalCoderConfig,
  project: ProjectDefinition,
  goal: string,
  existingContext?: string
): Promise<string | undefined> {
  const configuredWorkspace = project.workspace.trim();
  if (!configuredWorkspace) return existingContext?.trim() || undefined;

  const workspace = await resolveWorkspace(configuredWorkspace);
  reportProgress({
    phase: 'investigation',
    activityKind: 'searching-repository',
    action: 'Reading project context',
    detail: project.name,
    reasoningSummary: 'Project Chat is gathering a bounded, read-only repository snapshot for this response.'
  });

  const discovery = await discoverWorkspace(workspace, {
    maxDepth: 7,
    maxEntries: 1_200
  });
  const index = new RepoIndexStore(config.contextIndexPath);
  const capsule = await prepareContextCapsule(index, config, {
    workspace,
    task: goal,
    maxFiles: PROJECT_CHAT_MAX_FILES,
    maxCharsPerFile: PROJECT_CHAT_MAX_CHARS_PER_FILE
  });

  const evidence = capsule.relevantFiles
    .map((file) => {
      const snippets = file.evidence
        .map((item) => `${file.path}:${item.startLine}-${item.endLine}\n${item.content}`)
        .join('\n\n');
      return `## ${file.path}\n${snippets}`;
    })
    .join('\n\n');

  const repositoryMap = [
    `Workspace: ${workspace}`,
    `Package manager: ${discovery.packageManager ?? 'unknown'}`,
    `Package scripts: ${(discovery.packageScripts ?? []).join(', ') || '[none]'}`,
    '',
    ...discovery.files.slice(0, PROJECT_CHAT_MAP_FILES)
  ].join('\n');

  const readOnlyContext = [
    '# READ-ONLY PROJECT REPOSITORY CONTEXT',
    `Project: ${project.name}`,
    `Company: ${project.organizationName ?? project.organizationId}`,
    'Axis gathered this repository evidence from the Project-owned workspace for this Chat turn.',
    'Treat it as read-only context. You may explain, inspect, compare and reason about the code, but do not claim that you edited files or ran commands. Use Cowork when the user asks you to modify or validate the repository.',
    '',
    '## Repository map',
    repositoryMap,
    '',
    '## Ranked source evidence',
    evidence || '[No relevant source snippets were selected for this turn.]'
  ].join('\n');

  reportProgress({
    phase: 'investigation',
    activityKind: 'reading',
    action: `Loaded ${capsule.relevantFiles.length} relevant project file${capsule.relevantFiles.length === 1 ? '' : 's'}`,
    detail: capsule.relevantFiles.map((file) => file.path).slice(0, 5).join(', ') || project.name,
    reasoningSummary: 'Only the bounded repository capsule is sent to the selected model; Project Chat does not mutate the workspace.'
  });

  return [existingContext?.trim(), readOnlyContext].filter(Boolean).join('\n\n') || undefined;
}
