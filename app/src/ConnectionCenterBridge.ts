import type { LocalCoderBridge } from './native.js';

export interface ApiKeyConnectionDetailsView {
  connectionId: string;
  credentialId: string;
  providerFamily: 'openai' | 'anthropic';
  name: string;
  companyId: string;
  endpoint?: string;
  headers: Record<string, string>;
  allowedHeaders: string[];
  enabled: boolean;
  available: boolean;
  reason?: string;
}

export interface ApiKeyConnectionTestView {
  providerId: string;
  ok: boolean;
  checkedAt: string;
  latencyMs: number;
  modelsAvailable?: number;
  message?: string;
}

export interface ConnectionCenterBridge extends LocalCoderBridge {
  apiKeyConnectionDetails(connectionId: string): Promise<ApiKeyConnectionDetailsView>;
  updateApiKeyConnection(input: {
    connectionId: string;
    name?: string;
    endpoint?: string | null;
    headers?: Record<string, string>;
  }): Promise<ApiKeyConnectionDetailsView>;
  rotateApiKeyConnection(input: { connectionId: string; secret: string }): Promise<ApiKeyConnectionDetailsView>;
  setApiKeyConnectionEnabled(input: { connectionId: string; enabled: boolean }): Promise<ApiKeyConnectionDetailsView>;
  testApiKeyConnection(connectionId: string): Promise<ApiKeyConnectionTestView>;
  removeApiKeyConnection(connectionId: string): Promise<boolean>;
}

export function connectionCenterBridge(): ConnectionCenterBridge | undefined {
  return window.lc as ConnectionCenterBridge | undefined;
}
