export type RoutingPolicy = 'auto' | 'local-first' | 'balanced' | 'speed-first' | 'deep' | 'frontier-only';
export type ModelSelection =
  | { mode: 'auto' }
  | { mode: 'explicit'; providerId: string; modelId: string }
  | { mode: 'local-first'; modelId: string };

export interface AdminProject {
  id: string;
  name: string;
  workspace: string;
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
