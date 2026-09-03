import type { CompanyContextSnapshot } from '../company-context.js';
import type { ProviderConnectionView } from '../provider-connections.js';
import {
  freezeAgentSessionContext,
  type AgentExecutionTargetContext,
  type AgentPermissionSet,
  type AgentResourceBinding,
  type AgentRoot,
  type AgentSessionContext,
  type EffectiveCapabilitySet
} from './contracts.js';

export interface CanonicalAgentSessionProject {
  readonly id: string;
}

export interface CanonicalAgentSessionContextInput {
  readonly companyContext: CompanyContextSnapshot;
  readonly sessionId: string;
  readonly companyId: string;
  readonly project?: CanonicalAgentSessionProject;
  readonly connection: ProviderConnectionView;
  readonly modelId: string;
  readonly executionTarget: AgentExecutionTargetContext;
  readonly roots: readonly AgentRoot[];
  readonly permissions: AgentPermissionSet;
  readonly capabilities: EffectiveCapabilitySet;
  readonly resources: readonly AgentResourceBinding[];
}

function ownerOfProject(snapshot: CompanyContextSnapshot, projectId: string): string | undefined {
  return snapshot.companies.find((company) => company.projectIds.includes(projectId))?.id;
}

function ownerOfConnection(snapshot: CompanyContextSnapshot, connectionId: string): string | null | undefined {
  if (snapshot.sharedConnectionIds.includes(connectionId)) return null;
  return snapshot.companies.find((company) => company.connectionIds.includes(connectionId))?.id;
}

function ownerOfSession(snapshot: CompanyContextSnapshot, sessionId: string): string | undefined {
  return snapshot.companies.find((company) => company.sessionIds.includes(sessionId))?.id;
}

/**
 * Build the immutable agent authority from the canonical Company graph produced
 * by PR #75.
 *
 * Ownership is intentionally taken from `CompanyContextSnapshot`, not from
 * legacy `organizationId`, mutable account labels or workspace paths. The
 * selected ProviderConnectionView contributes protocol/auth metadata only.
 */
export function buildAgentSessionContext(
  input: CanonicalAgentSessionContextInput
): AgentSessionContext {
  const companyId = input.companyId.trim();
  const company = input.companyContext.companies.find((candidate) => candidate.id === companyId);
  if (!company) throw new Error(`Company ${companyId || '(empty)'} is not present in the canonical Company context.`);

  const priorSessionOwner = ownerOfSession(input.companyContext, input.sessionId);
  if (priorSessionOwner && priorSessionOwner !== companyId) {
    throw new Error(
      `Session ${input.sessionId} belongs to Company ${priorSessionOwner}, not selected Company ${companyId}.`
    );
  }

  if (input.project) {
    const projectOwner = ownerOfProject(input.companyContext, input.project.id);
    if (!projectOwner) {
      throw new Error(`Project ${input.project.id} is not present in the canonical Company context.`);
    }
    if (projectOwner !== companyId) {
      throw new Error(
        `Project ${input.project.id} belongs to Company ${projectOwner}, not selected Company ${companyId}.`
      );
    }
  }

  const connectionOwner = ownerOfConnection(input.companyContext, input.connection.id);
  if (connectionOwner === undefined) {
    throw new Error(`Connection ${input.connection.id} is not present in the canonical Company context.`);
  }
  if (connectionOwner !== null && connectionOwner !== companyId) {
    throw new Error(
      `Connection ${input.connection.id} belongs to Company ${connectionOwner}, not selected Company ${companyId}.`
    );
  }

  return freezeAgentSessionContext({
    sessionId: input.sessionId,
    companyId,
    project: input.project ? { id: input.project.id, companyId } : undefined,
    connection: {
      id: input.connection.id,
      providerFamily: input.connection.providerFamily,
      authKind: input.connection.auth,
      companyId: connectionOwner
    },
    modelId: input.modelId,
    executionTarget: input.executionTarget,
    roots: input.roots,
    permissions: input.permissions,
    capabilities: input.capabilities,
    resources: input.resources
  });
}
