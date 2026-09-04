import { ActiveCompanyScope } from './active-company-scope.js';
import { CompanyContextStore, PERSONAL_COMPANY_ID, type CompanyContextSnapshot } from './company-context.js';
import { DesktopAppRuntime, type AppRuntimeListener, type AppRuntimeRequest } from './app-runtime.js';
import { readProjectGitReview } from './project-git-review.js';

interface ScopedProject {
  id: string;
  name: string;
  companyId?: string;
  companyName?: string;
  organizationId: string;
  organizationName?: string;
  workspace?: string;
  archived?: boolean;
}

interface ScopedJob {
  id: string;
  input: {
    projectId?: string;
    companyId?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function body(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function projectCompanyId(project: ScopedProject): string {
  return project.companyId?.trim() || project.organizationId.trim();
}

function explicitJobCompanyId(job: ScopedJob): string | undefined {
  return job.input.companyId?.trim() || undefined;
}

function projectPath(pathname: string): string | undefined {
  return /^\/projects\/([^/]+)(?:\/catalog|\/usage|\/archive)?$/.exec(pathname)?.[1];
}

function projectGitReviewPath(pathname: string): string | undefined {
  return /^\/projects\/([^/]+)\/git-diff$/.exec(pathname)?.[1];
}

function jobPath(pathname: string): string | undefined {
  return /^\/jobs\/([A-Za-z0-9-]+)(?:\/.*)?$/.exec(pathname)?.[1];
}

/**
 * Decorates the existing standalone runtime with one explicit active-Company
 * boundary. It intentionally does not implement corporate projectless Chat:
 * corporate conversations select a Project whose connection policy, folder,
 * repository context and Company ownership define the complete boundary.
 */
export class CompanyScopedDesktopRuntime {
  private readonly active = new ActiveCompanyScope();
  private readonly companies = new CompanyContextStore();

  constructor(private readonly base: DesktopAppRuntime) {}

  subscribe(listener: AppRuntimeListener): () => void {
    return this.base.subscribe((event) => {
      if (event.type !== 'job') {
        listener(event);
        return;
      }
      const job = event.payload.job as ScopedJob | undefined;
      const companyId = job ? explicitJobCompanyId(job) : undefined;
      // Legacy project jobs without an explicit Company are intentionally not
      // pushed live across the boundary. The next scoped /jobs refresh resolves
      // their Project ownership before exposing them.
      if (companyId && companyId === this.active.currentId()) listener(event);
    });
  }

  async close(): Promise<void> {
    await this.base.close();
  }

  async request(request: AppRuntimeRequest): Promise<unknown> {
    const method = (request.method ?? 'GET').toUpperCase();
    const url = new URL(request.path, 'app://axis');
    const pathname = url.pathname.replace(/^\/api(?=\/|$)/, '') || '/';

    if (pathname === '/companies/active' && method === 'GET') return { scope: this.active.snapshot() };
    if (pathname === '/companies/active' && method === 'PUT') {
      const companyId = body(request.body).companyId;
      if (typeof companyId !== 'string') throw new Error('companyId is required.');
      return { scope: this.active.set(companyId) };
    }

    if (/^\/companies\/[^/]+\/archive$/.test(pathname) && method === 'POST') {
      const result = await this.base.request(request) as { company?: { id?: string; archivedAt?: string } };
      if (result.company?.id && result.company.archivedAt) this.active.resetIfActive(result.company.id);
      return result;
    }

    const companyDeleteMatch = /^\/companies\/([^/]+)$/.exec(pathname);
    if (companyDeleteMatch && method === 'DELETE') {
      const companyId = decodeURIComponent(companyDeleteMatch[1]);
      if (companyId === PERSONAL_COMPANY_ID) throw new Error('Personal cannot be deleted.');
      const { context } = await this.base.request({ method: 'GET', path: '/api/companies/context' }) as { context: CompanyContextSnapshot };
      const company = context.companies.find((candidate) => candidate.id === companyId);
      if (!company) throw new Error(`Company not found: ${companyId}`);
      const counts = [
        ['Project', company.projectIds.length],
        ['connection', company.connectionIds.length],
        ['conversation', company.sessionIds.length]
      ] as const;
      const blockers = counts.filter(([, count]) => count > 0)
        .map(([label, count]) => `${count} ${label}${count === 1 ? '' : 's'}`);
      if (blockers.length > 0) {
        throw new Error(`Delete or move ${blockers.join(', ')} before deleting ${company.name}.`);
      }
      const deleted = this.companies.deleteCompany(companyId);
      this.active.resetIfActive(companyId);
      return { deleted: true, company: deleted };
    }

    if (pathname === '/projects' && method === 'GET') {
      const result = await this.base.request(request) as { projects: ScopedProject[] };
      const companyId = this.active.currentId();
      return { projects: result.projects.filter((project) => projectCompanyId(project) === companyId) };
    }

    if (pathname === '/projects' && method === 'POST') {
      const scope = this.active.snapshot();
      const next = { ...body(request.body), organizationId: scope.activeCompanyId, organizationName: scope.company.name };
      return await this.base.request({ ...request, body: next });
    }

    const gitReviewProjectId = projectGitReviewPath(pathname);
    if (gitReviewProjectId && method === 'GET') {
      const project = await this.requireActiveProject(decodeURIComponent(gitReviewProjectId));
      return {
        review: await readProjectGitReview(
          { id: project.id, workspace: project.workspace ?? '' },
          url.searchParams.get('scope')
        )
      };
    }

    const scopedProjectId = projectPath(pathname);
    if (scopedProjectId) {
      await this.requireActiveProject(decodeURIComponent(scopedProjectId));
      if (method === 'PATCH') {
        const scope = this.active.snapshot();
        return await this.base.request({
          ...request,
          body: { ...body(request.body), organizationId: scope.activeCompanyId, organizationName: scope.company.name }
        });
      }
    }

    if (pathname === '/jobs' && method === 'GET') {
      const result = await this.base.request(request) as { jobs: ScopedJob[] };
      const companyId = this.active.currentId();
      const resolved = await Promise.all(result.jobs.map(async (job) => ({ job, companyId: await this.resolveJobCompanyId(job) })));
      return { jobs: resolved.filter((item) => item.companyId === companyId).map((item) => item.job) };
    }

    if (pathname === '/jobs' && method === 'POST') {
      const activeCompanyId = this.active.currentId();
      const projectId = typeof body(request.body).projectId === 'string' ? String(body(request.body).projectId).trim() : '';
      if (activeCompanyId !== PERSONAL_COMPANY_ID && !projectId) {
        throw new Error('Select a Project in the active Company before starting a corporate conversation.');
      }
      if (projectId) await this.requireActiveProject(projectId);
      return await this.base.request(request);
    }

    const scopedJobId = jobPath(pathname);
    if (scopedJobId) await this.requireActiveJob(scopedJobId);

    if (pathname === '/chat/catalog' && method === 'GET' && this.active.currentId() !== PERSONAL_COMPANY_ID) {
      return { catalog: { scope: 'personal', projectId: '', defaultModel: { mode: 'auto' }, providers: [] } };
    }

    return await this.base.request(request);
  }

  private async resolveJobCompanyId(job: ScopedJob): Promise<string | undefined> {
    const explicit = explicitJobCompanyId(job);
    if (explicit) return explicit;
    const projectId = job.input.projectId?.trim();
    if (!projectId) return PERSONAL_COMPANY_ID;
    try {
      const result = await this.base.request({ method: 'GET', path: `/api/projects/${encodeURIComponent(projectId)}` }) as { project: ScopedProject };
      return projectCompanyId(result.project);
    } catch {
      return undefined;
    }
  }

  private async requireActiveProject(id: string): Promise<ScopedProject> {
    const result = await this.base.request({ method: 'GET', path: `/api/projects/${encodeURIComponent(id)}` }) as { project: ScopedProject };
    const activeCompanyId = this.active.currentId();
    const companyId = projectCompanyId(result.project);
    if (companyId !== activeCompanyId) {
      throw new Error(`Project ${id} belongs to Company ${companyId}, not active Company ${activeCompanyId}.`);
    }
    return result.project;
  }

  private async requireActiveJob(id: string): Promise<ScopedJob> {
    const result = await this.base.request({ method: 'GET', path: `/api/jobs/${id}` }) as { job: ScopedJob };
    const companyId = await this.resolveJobCompanyId(result.job);
    const activeCompanyId = this.active.currentId();
    if (!companyId || companyId !== activeCompanyId) {
      throw new Error(`Conversation ${id} does not belong to active Company ${activeCompanyId}.`);
    }
    return result.job;
  }
}

let installed = false;

export function installCompanyScopedDesktopRuntime(): void {
  if (installed) return;
  installed = true;
  const runtimeClass = DesktopAppRuntime as unknown as { create: () => Promise<DesktopAppRuntime> };
  const create = runtimeClass.create.bind(DesktopAppRuntime);
  runtimeClass.create = async () => new CompanyScopedDesktopRuntime(await create()) as unknown as DesktopAppRuntime;
}
