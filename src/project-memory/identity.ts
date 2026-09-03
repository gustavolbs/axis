import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { AgentRoot, AgentSessionContext } from '../agent-runtime/index.js';
import type { ProjectMemoryRootBinding, ProjectMemoryScope } from './types.js';

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalRootPath(rootPath: string): string {
  let resolved = path.resolve(rootPath);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    // A root may be declared before it exists. The absolute configured path is
    // still a stable, fail-closed local root identity for this device.
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function projectMemoryRootFingerprint(root: Pick<AgentRoot, 'path'>): string {
  return hash(canonicalRootPath(root.path)).slice(0, 32);
}

export function projectMemoryScopeKey(scope: Pick<ProjectMemoryScope, 'companyId' | 'projectId' | 'rootFingerprint'>): string {
  return hash(`${scope.companyId}\0${scope.projectId}\0${scope.rootFingerprint}`).slice(0, 32);
}

export function projectMemoryRootBindings(session: AgentSessionContext): ProjectMemoryRootBinding[] {
  const project = session.project;
  if (!project) return [];
  return session.roots
    .filter((root) => root.companyId === session.companyId && root.projectId === project.id)
    .map((root) => ({
      root,
      scope: {
        companyId: session.companyId,
        projectId: project.id,
        rootId: root.id,
        rootFingerprint: projectMemoryRootFingerprint(root)
      }
    }));
}
