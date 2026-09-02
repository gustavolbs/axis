import {
  effectiveProjectConnectionPolicy,
  type ModelSelection,
  type ProjectDefinition
} from './project-store.js';

/**
 * Resolves the exact Project Chat identity once, when a new conversation is created.
 * The returned explicit selection is persisted on the job so later Project-default
 * edits cannot silently move an existing conversation to another account.
 */
export function projectChatDefaultModelSelection(
  project: Pick<ProjectDefinition, 'privacy' | 'credentialProfileIds' | 'defaultModel' | 'connectionPolicy'>
): ModelSelection | undefined {
  const policy = effectiveProjectConnectionPolicy(project);
  const connectionId = policy.chat.defaultConnectionId?.trim();
  const modelId = policy.chat.defaultModelId?.trim();
  if (!connectionId || !modelId) {
    return project.defaultModel.mode === 'explicit'
      ? { ...project.defaultModel }
      : project.defaultModel.mode === 'local-first'
        ? { mode: 'explicit', providerId: 'ollama', modelId: project.defaultModel.modelId }
        : undefined;
  }
  return { mode: 'explicit', providerId: connectionId, modelId };
}
