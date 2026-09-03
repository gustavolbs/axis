import type { LocalCoderConfig } from '../config.js';
import { projectIsolationKey } from '../project-store.js';
import { prepareRepoIntelligence } from '../repo-intelligence.js';
import type { ProjectDurableMemorySource } from './types.js';

/**
 * Reuses the existing evidence-backed Repo Intelligence store as the durable
 * knowledge layer. Lifecycle Project Memory remains episodic/handoff state and
 * does not promote conversational speculation into durable repository facts.
 */
export function createRepoIntelligenceProjectMemorySource(
  config: Pick<LocalCoderConfig, 'workerStatePath'>
): ProjectDurableMemorySource {
  return {
    async load({ session, root, task }) {
      const project = session.project;
      if (!project || root.projectId !== project.id || root.companyId !== session.companyId) return undefined;
      const memoryScopeKey = projectIsolationKey({
        id: project.id,
        organizationId: session.companyId
      });
      try {
        const memory = await prepareRepoIntelligence(root.path, task, config, memoryScopeKey);
        return {
          capsule: memory.capsule,
          retrievedFacts: memory.retrieved.length
        };
      } catch {
        // Durable memory is advisory. A non-Git root or temporarily unavailable
        // repo-intelligence store must not block the structured handoff layer.
        return undefined;
      }
    }
  };
}
