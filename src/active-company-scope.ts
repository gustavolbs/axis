import { readAppSettings, writeAppSettings } from './app-config.js';
import {
  CompanyContextStore,
  DEFAULT_COMPANY_COLOR,
  PERSONAL_COMPANY_ID,
  type CompanyDefinition
} from './company-context.js';

export interface ActiveCompanyOption extends CompanyDefinition {
  kind: 'personal' | 'company';
}

export interface ActiveCompanySnapshot {
  activeCompanyId: string;
  company: ActiveCompanyOption;
  companies: ActiveCompanyOption[];
}

function personalCompany(): ActiveCompanyOption {
  const now = new Date(0).toISOString();
  return {
    id: PERSONAL_COMPANY_ID,
    name: 'Personal',
    description: 'Personal work on this device',
    color: DEFAULT_COMPANY_COLOR,
    icon: 'building-2',
    order: -1,
    createdAt: now,
    updatedAt: now,
    kind: 'personal'
  };
}

export class ActiveCompanyScope {
  constructor(private readonly companies = new CompanyContextStore()) {}

  currentId(): string {
    const configured = readAppSettings()?.activeCompanyId?.trim();
    if (!configured || configured === PERSONAL_COMPANY_ID) return PERSONAL_COMPANY_ID;
    try {
      const company = this.companies.getCompany(configured);
      if (!company.archivedAt) return company.id;
    } catch { /* stale setting falls back closed to Personal */ }
    this.persist(PERSONAL_COMPANY_ID);
    return PERSONAL_COMPANY_ID;
  }

  snapshot(): ActiveCompanySnapshot {
    const personal = personalCompany();
    const companies: ActiveCompanyOption[] = [
      personal,
      ...this.companies.listCompanies().map((company) => ({ ...company, kind: 'company' as const }))
    ];
    const activeCompanyId = this.currentId();
    return {
      activeCompanyId,
      company: companies.find((company) => company.id === activeCompanyId) ?? personal,
      companies
    };
  }

  set(companyIdValue: string): ActiveCompanySnapshot {
    const companyId = companyIdValue.trim();
    if (!companyId) throw new Error('companyId is required.');
    if (companyId !== PERSONAL_COMPANY_ID) {
      const company = this.companies.getCompany(companyId);
      if (company.archivedAt) throw new Error(`Company ${company.name} is archived and cannot become active.`);
    }
    this.persist(companyId);
    return this.snapshot();
  }

  resetIfActive(companyId: string): boolean {
    if (this.currentId() !== companyId) return false;
    this.persist(PERSONAL_COMPANY_ID);
    return true;
  }

  private persist(activeCompanyId: string): void {
    writeAppSettings({ ...readAppSettings(), activeCompanyId });
  }
}
