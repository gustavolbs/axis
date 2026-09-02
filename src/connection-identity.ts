import { createHash } from 'node:crypto';

export const PERSONAL_ORGANIZATION_ID = 'personal';
export const LOCAL_ORGANIZATION_ID = 'local';

function stableSuffix(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export function apiCredentialConnectionId(providerId: string, credentialId: string): string {
  return `${providerId}-api-${stableSuffix(`${providerId}\0${credentialId}`)}`;
}

export function claudeAccountConnectionId(profileId: string): string {
  return `claude-account-${stableSuffix(profileId)}`;
}

export function chatGptAccountConnectionId(profileId: string): string {
  return `chatgpt-account-${stableSuffix(profileId)}`;
}

export function organizationIdFromLabel(label?: string): string {
  const clean = label?.trim().toLowerCase() ?? '';
  if (!clean) return PERSONAL_ORGANIZATION_ID;
  const normalized = clean
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);
  return normalized || PERSONAL_ORGANIZATION_ID;
}
