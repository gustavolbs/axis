import type { AgentSessionContext } from '../../agent-runtime/index.js';
import type {
  BrowserBackend,
  BrowserBackendSession,
  BrowserOperationContext,
  BrowserSessionScope
} from './contracts.js';

interface ManagedBrowserSession {
  readonly scope: BrowserSessionScope;
  readonly session: Promise<BrowserBackendSession>;
}

function scopeFor(session: AgentSessionContext): BrowserSessionScope {
  const projectId = session.project?.id;
  return Object.freeze({
    sessionId: session.sessionId,
    companyId: session.companyId,
    ...(projectId ? { projectId } : {}),
    executionTargetId: session.executionTarget.id,
    contextKey: JSON.stringify([
      session.companyId,
      projectId ?? null,
      session.sessionId,
      session.executionTarget.id
    ])
  });
}

function sameScope(left: BrowserSessionScope, right: BrowserSessionScope): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.companyId === right.companyId &&
    left.projectId === right.projectId &&
    left.executionTargetId === right.executionTargetId &&
    left.contextKey === right.contextKey
  );
}

function assertBackendSessionScope(
  expected: BrowserSessionScope,
  actual: BrowserBackendSession
): void {
  if (!actual.id.trim()) throw new Error('Browser backend returned a session with an empty id.');
  if (!sameScope(expected, actual.scope)) {
    throw new Error(
      `Browser backend ${actual.id} returned a session outside Axis scope ${expected.contextKey}.`
    );
  }
}

/**
 * Lazily owns exactly one browser backend session per immutable Axis session.
 * It never reuses a session across Company/Project/target boundaries and never
 * switches to a different backend if creation or an operation fails.
 */
export class BrowserSessionManager {
  private readonly sessions = new Map<string, ManagedBrowserSession>();

  constructor(readonly backend: BrowserBackend) {
    if (!backend.id.trim()) throw new Error('Browser backend id must not be empty.');
  }

  get activeSessionCount(): number {
    return this.sessions.size;
  }

  async getOrCreate(
    axisSession: AgentSessionContext,
    context: BrowserOperationContext
  ): Promise<BrowserBackendSession> {
    const scope = scopeFor(axisSession);
    const existing = this.sessions.get(scope.sessionId);
    if (existing) {
      if (!sameScope(existing.scope, scope)) {
        throw new Error(
          `Browser session ${scope.sessionId} is already bound to a different Company/Project/target context. Axis will not reuse it.`
        );
      }
      return await existing.session;
    }

    context.reportProgress({
      message: `Opening browser session with backend ${this.backend.id}.`,
      metadata: { backendId: this.backend.id }
    });
    const pending = this.backend.openSession(scope, context).then((opened) => {
      assertBackendSessionScope(scope, opened);
      return opened;
    }).catch((error) => {
      const current = this.sessions.get(scope.sessionId);
      if (current?.session === pending) this.sessions.delete(scope.sessionId);
      throw error;
    });
    this.sessions.set(scope.sessionId, { scope, session: pending });
    return await pending;
  }

  async closeSession(axisSession: AgentSessionContext): Promise<void> {
    const scope = scopeFor(axisSession);
    const managed = this.sessions.get(scope.sessionId);
    if (!managed) return;
    if (!sameScope(managed.scope, scope)) {
      throw new Error(
        `Browser session ${scope.sessionId} is bound to a different Company/Project/target context and cannot be closed through this context.`
      );
    }
    this.sessions.delete(scope.sessionId);
    const session = await managed.session;
    await session.close?.();
  }

  async closeAll(): Promise<void> {
    const managed = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(managed.map(async ({ session }) => {
      const opened = await session;
      await opened.close?.();
    }));
  }
}
