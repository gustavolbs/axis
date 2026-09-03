import {
  CompanyContextStore,
  PERSONAL_COMPANY_ID,
  type CompanyDefinition
} from './company-context.js';
import {
  ProviderConnectionRuntime,
  type ProviderConnectionView
} from './provider-connections.js';

export interface CanonicalProviderConnectionView extends ProviderConnectionView {
  /** Stable Axis Company identity. Local execution is shared and has no owner. */
  companyId?: string;
  companyName?: string;
  companyArchived?: boolean;
}

export interface BindableConnectionIdentity {
  id: string;
  label: string;
  auth: ProviderConnectionView['auth'];
  organizationId?: string;
  organizationLabel?: string;
}

function personalCompany(): Pick<CompanyDefinition, 'id' | 'name' | 'archivedAt'> {
  return { id: PERSONAL_COMPANY_ID, name: 'Personal' };
}

/**
 * Resolves provider connection ownership through the stable Company graph.
 * Account/profile labels and legacy organization ids are migration inputs only;
 * once a connection id is bound, later provider metadata cannot move it.
 */
export class CompanyConnectionOwnership {
  constructor(private readonly companies = new CompanyContextStore()) {}

  company(companyIdValue: string): Pick<CompanyDefinition, 'id' | 'name' | 'archivedAt'> {
    const companyId = companyIdValue.trim();
    if (!companyId) throw new Error('Company is required.');
    if (companyId === PERSONAL_COMPANY_ID) return personalCompany();
    const company = this.companies.getCompany(companyId);
    if (company.archivedAt) throw new Error(`Company ${company.name} is archived.`);
    return company;
  }

  bind(connection: BindableConnectionIdentity, companyIdValue: string): CanonicalProviderConnectionView['companyId'] {
    if (connection.auth === 'local') throw new Error('Local execution is shared and cannot be assigned to a Company.');
    const company = this.company(companyIdValue);
    this.companies.reconcile({
      projects: [],
      sessions: [],
      connections: [{
        id: connection.id,
        label: connection.label,
        auth: connection.auth,
        companyId: company.id,
        organizationId: connection.organizationId,
        organizationLabel: connection.organizationLabel ?? company.name
      }]
    });
    return company.id;
  }

  canonicalize(connections: ProviderConnectionView[]): CanonicalProviderConnectionView[] {
    if (connections.length === 0) return [];
    const snapshot = this.companies.reconcile({
      projects: [],
      sessions: [],
      connections
    });
    const companyByConnection = new Map<string, typeof snapshot.companies[number]>();
    for (const company of snapshot.companies) {
      for (const connectionId of company.connectionIds) companyByConnection.set(connectionId, company);
    }

    return connections.map((connection): CanonicalProviderConnectionView => {
      if (connection.auth === 'local') return { ...connection };
      const company = companyByConnection.get(connection.id);
      if (!company) {
        throw new Error(`Connection ${connection.id} is missing a canonical Company binding.`);
      }
      return {
        ...connection,
        // Existing routing/project code already treats organizationId as its
        // authorization boundary. Canonicalizing it here migrates that boundary
        // without teaching every caller about a second competing identity.
        organizationId: company.id,
        companyId: company.id,
        companyName: company.name,
        companyArchived: Boolean(company.archivedAt)
      };
    });
  }
}

let installed = false;

/**
 * Desktop-only compatibility decorator. ProviderConnectionRuntime remains the
 * provider abstraction; this installs the canonical Company ownership layer on
 * every instance created by AppRuntime, ProjectProviderRuntime and account IPC.
 */
export function installCompanyConnectionOwnership(): void {
  if (installed) return;
  installed = true;
  const ownership = new CompanyConnectionOwnership();
  const prototype = ProviderConnectionRuntime.prototype as ProviderConnectionRuntime & {
    list: () => ProviderConnectionView[];
  };
  const originalList = prototype.list;
  prototype.list = function listCanonicalConnections(this: ProviderConnectionRuntime): ProviderConnectionView[] {
    return ownership.canonicalize(originalList.call(this));
  };
}
