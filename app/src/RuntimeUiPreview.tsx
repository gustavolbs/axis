import { useMemo, useState } from 'react';
import { Sparkles } from 'lucide-react';

import {
  AgentRuntimeTimeline,
  RuntimeEvidenceDock,
  type RuntimePermissionResolution
} from './AgentRuntimeActivity.js';
import {
  runtimeUiActiveEvents,
  runtimeUiAllEvents,
  runtimeUiFailureEvents,
  runtimeUiOutcomeEvents
} from './agent-runtime-ui-fixtures.js';
import type { AgentDecisionResolution, AgentLifecycleEvent } from '../../src/agent-runtime/contracts.js';

type PreviewScenario = 'empty' | 'active' | 'resolved' | 'failure' | 'all';

function scenarioFromLocation(): PreviewScenario {
  const value = new URLSearchParams(window.location.search).get('runtime-ui-preview');
  return value === 'empty' || value === 'resolved' || value === 'failure' || value === 'all' ? value : 'active';
}

function eventsForScenario(scenario: PreviewScenario): readonly AgentLifecycleEvent[] {
  if (scenario === 'empty') return [];
  if (scenario === 'resolved') return [...runtimeUiActiveEvents, ...runtimeUiOutcomeEvents];
  if (scenario === 'failure') return runtimeUiFailureEvents;
  if (scenario === 'all') return runtimeUiAllEvents;
  return runtimeUiActiveEvents;
}

export function RuntimeUiPreview() {
  const [scenario, setScenario] = useState<PreviewScenario>(scenarioFromLocation);
  const [decision, setDecision] = useState<AgentDecisionResolution>();
  const [permission, setPermission] = useState<RuntimePermissionResolution>();
  const events = useMemo(() => eventsForScenario(scenario), [scenario]);
  const panes = useMemo(() => [
    {
      id: 'filesystem' as const,
      label: 'Files',
      description: 'Scoped filesystem evidence',
      status: '2 reads · 1 committed mutation',
      mutation: true,
      content: <>
        <code>app/src/AgentRuntimeActivity.tsx</code>
        <span>Read and mutation details stay inside the active Project root.</span>
      </>
    },
    {
      id: 'process' as const,
      label: 'Shell',
      description: 'Process activity',
      status: 'npm test · exit 0',
      mutation: true,
      content: <>
        <code>npm test</code>
        <span>cwd /project · 1.8s</span>
      </>
    },
    {
      id: 'git' as const,
      label: 'Git',
      description: 'Repository evidence',
      status: '1 file changed',
      content: <>
        <code>app/src/example.tsx</code>
        <span>Working tree changes are rendered as evidence, not provider output.</span>
      </>
    },
    {
      id: 'mcp' as const,
      label: 'MCP',
      description: 'MCP host activity',
      status: 'No calls in this fixture',
      mutation: true,
      content: <span>Future MCP results can mount here without changing the runtime timeline.</span>
    },
    {
      id: 'browser' as const,
      label: 'Browser',
      description: 'Browser session evidence',
      status: scenario === 'failure' || scenario === 'all' ? 'Timed out' : 'Idle',
      mutation: true,
      content: <span>Navigation, extraction and interaction state remain provider-neutral.</span>
    }
  ], [scenario]);

  return <main className="runs-shell" data-runtime-ui-preview={scenario}>
    <header className="runs-header">
      <div>
        <h1>Agent runtime activity</h1>
        <p>Isolated canonical lifecycle fixture for visual verification. No backend wiring is used.</p>
      </div>
      <div className="result-chip-row" role="group" aria-label="Preview scenarios">
        {(['empty', 'active', 'resolved', 'failure', 'all'] as const).map((value) => <button
          key={value}
          type="button"
          className="lc-agent-secondary-action"
          aria-pressed={scenario === value}
          onClick={() => setScenario(value)}
        >{value}</button>)}
      </div>
    </header>

    <section className="thread-assistant-turn" aria-label="Runtime timeline preview">
      <span className={`assistant-mark${scenario === 'active' ? ' working' : ''}`} aria-hidden="true">
        <Sparkles size={18} strokeWidth={1.5} />
      </span>
      <div className="assistant-body">
        <AgentRuntimeTimeline
          events={events}
          emptyLabel="No lifecycle events have been emitted for this turn."
          onDecision={setDecision}
          onPermission={setPermission}
        />
        {decision || permission ? <div className="decision-picker-echo" role="status" aria-live="polite">
          <strong>Fixture resolution</strong>
          <ul>
            {permission ? <li>Permission {permission.allowed ? 'allowed' : 'denied'} for <code>{permission.callId}</code></li> : null}
            {decision ? <li>Decision <code>{decision.requestId}</code> → {decision.optionId || decision.text}</li> : null}
          </ul>
        </div> : null}
      </div>
    </section>

    <section aria-label="Future runtime panes">
      <RuntimeEvidenceDock
        panes={scenario === 'empty' ? [] : panes}
        emptyLabel="No filesystem, process, Git, MCP, or browser evidence yet."
      />
    </section>
  </main>;
}
