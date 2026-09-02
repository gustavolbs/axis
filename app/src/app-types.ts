export type RoutingPolicy = 'auto' | 'local-first' | 'balanced' | 'speed-first' | 'deep' | 'frontier-only';
export type ModelSelection =
  | { mode: 'auto' }
  | { mode: 'explicit'; providerId: string; modelId: string }
  | { mode: 'local-first'; modelId: string };

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
  organizationId: string;
  organizationName?: string;
  defaultRoutingPolicy: RoutingPolicy;
  defaultModel: ModelSelection;
  privacy: { cloudAllowed: boolean; allowedProviderIds: string[] };
  credentialProfileIds: Record<string, string>;
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
