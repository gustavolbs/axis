import './project-engineer-backend.js';

declare module './project-engineer-backend.js' {
  interface ProjectEngineerInput {
    /** Canonical Company id captured by product composition before execution. */
    companyId?: string;
  }
}
