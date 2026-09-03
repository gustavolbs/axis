import { ProviderConnectionRuntime, type ProviderConnectionView } from './provider-connections.js';
import { WorkHubService, type WorkHubSnapshot } from './work-hub.js';

export interface CompanyOwnedConnectionView extends ProviderConnectionView {
  companyId?: string;
  companyName?: string;
}

export type CompanyOwnedWorkHubSnapshot = WorkHubSnapshot & {
  sources: Array<WorkHubSnapshot['sources'][number] & { companyId: string; companyName: string }>;
  events: Array<WorkHubSnapshot['events'][number] & { companyId: string; companyName: string }>;
  tickets: Array<WorkHubSnapshot['tickets'][number] & { companyId: string; companyName: string }>;
  messages: Array<WorkHubSnapshot['messages'][number] & { companyId: string; companyName: string }>;
};

function ownershipByConnection(connections: CompanyOwnedConnectionView[]): Map<string, { companyId: string; companyName: string }> {
  const owners = new Map<string, { companyId: string; companyName: string }>();
  for (const connection of connections) {
    if (connection.auth === 'local') continue;
    const companyId = connection.companyId?.trim();
    const companyName = connection.companyName?.trim();
    if (!companyId || !companyName) {
      throw new Error(`Connection ${connection.id} is missing canonical Company ownership.`);
    }
    owners.set(connection.id, { companyId, companyName });
  }
  return owners;
}

export function attachWorkHubCompanyProvenance(
  snapshot: WorkHubSnapshot,
  connections: CompanyOwnedConnectionView[]
): CompanyOwnedWorkHubSnapshot {
  const owners = ownershipByConnection(connections);
  const attach = <T extends { connectionId: string }>(value: T): T & { companyId: string; companyName: string } => {
    const owner = owners.get(value.connectionId);
    if (!owner) throw new Error(`Work Hub connection ${value.connectionId} has no canonical Company owner.`);
    return { ...value, ...owner };
  };
  return {
    ...snapshot,
    sources: snapshot.sources.map(attach),
    events: snapshot.events.map(attach),
    tickets: snapshot.tickets.map(attach),
    messages: snapshot.messages.map(attach)
  };
}

let installed = false;

/**
 * Work Hub persists only source/connection identity. The desktop ownership
 * decorator makes connection → Company canonical; this decorator projects that
 * canonical owner onto every renderer snapshot so global aggregation never
 * erases isolation or relies on mutable account labels.
 */
export function installWorkHubCompanyProvenance(): void {
  if (installed) return;
  installed = true;
  const connections = new ProviderConnectionRuntime();
  const prototype = WorkHubService.prototype as WorkHubService & { snapshot: () => WorkHubSnapshot };
  const originalSnapshot = prototype.snapshot;
  prototype.snapshot = function snapshotWithCompany(this: WorkHubService): WorkHubSnapshot {
    return attachWorkHubCompanyProvenance(
      originalSnapshot.call(this),
      connections.list() as CompanyOwnedConnectionView[]
    ) as WorkHubSnapshot;
  };
}
