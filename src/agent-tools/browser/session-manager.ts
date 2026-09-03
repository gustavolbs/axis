import type { AgentSessionContext } from '../../agent-runtime/index.js';
import type {
  BrowserBackend,
  BrowserBackendOperationContext,
  BrowserBackendSession,
  BrowserNavigationPolicy,
  BrowserNavigationPolicyDecision,
  BrowserNavigationReason,
  BrowserOperationContext,
  BrowserSession,
  BrowserSessionScope
} from './contracts.js';
import { StaticBrowserNavigationPolicy } from './navigation-policy.js';

interface ManagedBrowserSession {
  readonly scope: BrowserSessionScope;
  readonly session: Promise<BrowserSession>;
}

function scopeFor(session: AgentSessionContext): BrowserSessionScope {
  const projectId = session.project?.id;
  const storagePartitionKey = JSON.stringify([
    session.companyId,
    projectId ?? null,
    session.executionTarget.id
  ]);
  return Object.freeze({
    sessionId: session.sessionId,
    companyId: session.companyId,
    ...(projectId ? { projectId } : {}),
    executionTargetId: session.executionTarget.id,
    storagePartitionKey,
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
    left.storagePartitionKey === right.storagePartitionKey &&
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
 *
 * The manager also owns the URL policy boundary. Explicit navigation is checked
 * before backend invocation and trusted backends receive the same authorizer for
 * redirects or interaction-triggered navigation.
 */
export class BrowserSessionManager {
  private readonly sessions = new Map<string, ManagedBrowserSession>();

  constructor(
    readonly backend: BrowserBackend,
    readonly navigationPolicy: BrowserNavigationPolicy = new StaticBrowserNavigationPolicy()
  ) {
    if (!backend.id.trim()) throw new Error('Browser backend id must not be empty.');
  }

  get activeSessionCount(): number {
    return this.sessions.size;
  }

  private async authorizeNavigation(
    scope: BrowserSessionScope,
    url: string,
    reason: BrowserNavigationReason
  ): Promise<BrowserNavigationPolicyDecision> {
    const decision = await this.navigationPolicy.authorize({ url, reason, scope });
    if (!decision.allowed) {
      throw new Error(
        `${decision.reason ?? `Browser navigation to ${url} is denied by policy.`} Axis will not fall back to another browser, host, or execution target.`
      );
    }
    return decision;
  }

  private backendContext(
    scope: BrowserSessionScope,
    context: BrowserOperationContext
  ): BrowserBackendOperationContext {
    return {
      ...context,
      authorizeNavigation: async (url, reason) => await this.authorizeNavigation(scope, url, reason)
    };
  }

  private wrapSession(scope: BrowserSessionScope, backendSession: BrowserBackendSession): BrowserSession {
    const optional = {
      ...(backendSession.inspect
        ? {
            inspect: async (request: Parameters<NonNullable<BrowserBackendSession['inspect']>>[0], context: BrowserOperationContext) =>
              await backendSession.inspect!(request, this.backendContext(scope, context))
          }
        : {}),
      ...(backendSession.developerRead
        ? {
            developerRead: async (
              request: Parameters<NonNullable<BrowserBackendSession['developerRead']>>[0],
              context: BrowserOperationContext
            ) => await backendSession.developerRead!(request, this.backendContext(scope, context))
          }
        : {}),
      ...(backendSession.screenshot
        ? {
            screenshot: async (
              request: Parameters<NonNullable<BrowserBackendSession['screenshot']>>[0],
              context: BrowserOperationContext
            ) => await backendSession.screenshot!(request, this.backendContext(scope, context))
          }
        : {}),
      ...(backendSession.interact
        ? {
            interact: async (
              request: Parameters<NonNullable<BrowserBackendSession['interact']>>[0],
              context: BrowserOperationContext
            ) => await backendSession.interact!(request, this.backendContext(scope, context))
          }
        : {})
    };

    return Object.freeze({
      id: backendSession.id,
      scope,
      async navigate(request, context) {
        const authorization = await thisManager.authorizeNavigation(scope, request.url, 'explicit');
        return await backendSession.navigate(
          { ...request, url: authorization.normalizedUrl },
          thisManager.backendContext(scope, context)
        );
      },
      async read(request, context) {
        return await backendSession.read(request, thisManager.backendContext(scope, context));
      },
      async state(context) {
        return await backendSession.state(thisManager.backendContext(scope, context));
      },
      ...optional,
      async close() {
        await backendSession.close?.();
      }
    });

    // Keep the methods above provider-neutral while retaining access to this manager.
    // eslint is not used in this repository; declaration placement keeps the facade compact.
    var thisManager: BrowserSessionManager;
  }

  async getOrCreate(
    axisSession: AgentSessionContext,
    context: BrowserOperationContext
  ): Promise<BrowserSession> {
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
      metadata: { backendId: this.backend.id, storagePartitionKey: scope.storagePartitionKey }
    });
    let pending!: Promise<BrowserSession>;
    const manager = this;
    pending = this.backend.openSession(scope, this.backendContext(scope, context)).then(async (opened) => {
      try {
        assertBackendSessionScope(scope, opened);
        const wrapped = manager.wrapSession(scope, opened);
        // Bind the closure used by the facade without exposing manager internals to the backend.
        Object.defineProperty(wrapped, '__axisBrowserManager', { value: manager, enumerable: false });
        return manager.bindManager(wrapped, opened, scope);
      } catch (error) {
        await opened.close?.().catch(() => undefined);
        throw error;
      }
    }).catch((error) => {
      const current = this.sessions.get(scope.sessionId);
      if (current?.session === pending) this.sessions.delete(scope.sessionId);
      throw error;
    });
    this.sessions.set(scope.sessionId, { scope, session: pending });
    return await pending;
  }

  private bindManager(
    facade: BrowserSession,
    backendSession: BrowserBackendSession,
    scope: BrowserSessionScope
  ): BrowserSession {
    const manager = this;
    const optional = {
      ...(backendSession.inspect
        ? { inspect: async (request: Parameters<NonNullable<BrowserBackendSession['inspect']>>[0], context: BrowserOperationContext) =>
            await backendSession.inspect!(request, manager.backendContext(scope, context)) }
        : {}),
      ...(backendSession.developerRead
        ? { developerRead: async (request: Parameters<NonNullable<BrowserBackendSession['developerRead']>>[0], context: BrowserOperationContext) =>
            await backendSession.developerRead!(request, manager.backendContext(scope, context)) }
        : {}),
      ...(backendSession.screenshot
        ? { screenshot: async (request: Parameters<NonNullable<BrowserBackendSession['screenshot']>>[0], context: BrowserOperationContext) =>
            await backendSession.screenshot!(request, manager.backendContext(scope, context)) }
        : {}),
      ...(backendSession.interact
        ? { interact: async (request: Parameters<NonNullable<BrowserBackendSession['interact']>>[0], context: BrowserOperationContext) =>
            await backendSession.interact!(request, manager.backendContext(scope, context)) }
        : {})
    };
    return Object.freeze({
      id: facade.id,
      scope,
      async navigate(request, context) {
        const authorization = await manager.authorizeNavigation(scope, request.url, 'explicit');
        return await backendSession.navigate(
          { ...request, url: authorization.normalizedUrl },
          manager.backendContext(scope, context)
        );
      },
      async read(request, context) {
        return await backendSession.read(request, manager.backendContext(scope, context));
      },
      async state(context) {
        return await backendSession.state(manager.backendContext(scope, context));
      },
      ...optional,
      async close() {
        await backendSession.close?.();
      }
    });
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
