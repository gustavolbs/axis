export type RoutingPolicy = 'auto' | 'local-first' | 'balanced' | 'speed-first' | 'deep' | 'frontier-only';
export type ModelSelection =
  | { mode: 'auto' }
  | { mode: 'explicit'; providerId: string; modelId: string }
  | { mode: 'local-first'; modelId: string };

export interface ProjectConnectionPolicy {
  chat: {
    defaultConnectionId?: string;
    defaultModelId?: string;
    allowedConnectionIds: string[];
  };
  inference: {
    allowedConnectionIds: string[];
    preferredConnectionId?: string;
  };
  workSourceIds: string[];
}

export interface AdminProject {
  id: string;
  name: string;
  /** Short gallery description; unlike instructions, it is never sent to a model. */
  description?: string;
  /** Presentation only: archived projects are hidden from the sidebar. */
  archived?: boolean;
  /** Optional default Cowork folder; empty means conversation-only until a folder is chosen. */
  workspace: string;
  /** Shared instructions injected into every conversation scoped to this Project. */
  instructions?: string;
  /** Canonical product isolation identity. */
  companyId: string;
  companyName?: string;
  /** @deprecated Legacy storage/migration alias; UI must use companyId/companyName. */
  organizationId: string;
  /** @deprecated Legacy storage/migration alias; UI must use companyId/companyName. */
  organizationName?: string;
  defaultRoutingPolicy: RoutingPolicy;
  defaultModel: ModelSelection;
  privacy: { cloudAllowed: boolean; allowedProviderIds: string[] };
  credentialProfileIds: Record<string, string>;
  connectionPolicy?: ProjectConnectionPolicy;
  budgets: {
    monthlyUsd?: number;
    dailyUsd?: number;
    perJobUsd?: number;
    warningFractions: number[];
    hardStopFraction: number;
  };
  concurrency: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderConnectionView {
  id: string;
  providerFamily: 'ollama' | 'anthropic' | 'openai';
  label: string;
  auth: 'local' | 'api-key' | 'claude-account' | 'chatgpt-account';
  billing: 'local' | 'api' | 'subscription';
  /** Canonical Axis ownership. Shared local execution intentionally has no companyId. */
  companyId?: string;
  companyName?: string;
  /** @deprecated Provider/runtime migration metadata; product isolation uses companyId. */
  organizationId: string;
  /** @deprecated Provider/runtime display metadata; not Axis company identity. */
  organizationLabel?: string;
  credentialId?: string;
  accountProfileId?: string;
  available: boolean;
  reason?: string;
  supportsMcpSources: boolean;
}

export interface WorkHubSourceSummary {
  id: string;
  label: string;
  connectionId: string;
  kind: 'calendar' | 'tickets' | 'messages';
  system: string;
  enabled: boolean;
}
