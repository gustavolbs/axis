import type { AxisTool } from '../../agent-runtime/index.js';
import {
  createProcessBackgroundTools,
  type ProcessBackgroundToolSuite
} from './background-tools.js';
import { ProcessExecTool, type ProcessExecToolOptions } from './exec-tool.js';
import { ManagedProcessRegistry } from './managed-process.js';
import { StaticProcessExecutionPolicy } from './policy.js';
import { ProcessWhichTool } from './toolchain.js';

export interface ProcessToolSuiteOptions extends ProcessExecToolOptions {
  readonly registry?: ManagedProcessRegistry;
}

export interface ProcessToolSuite extends ProcessBackgroundToolSuite {
  readonly exec: ProcessExecTool;
  readonly which: ProcessWhichTool;
  readonly tools: readonly AxisTool[];
}

/**
 * Canonical construction point for consumers such as Git/validation integration.
 * All tools share one policy/environment and background registry while the runtime
 * remains responsible for capabilities, permissions and exact execution-target routing.
 */
export function createProcessTools(options: ProcessToolSuiteOptions = {}): ProcessToolSuite {
  const policy = options.policy ?? new StaticProcessExecutionPolicy();
  const environment = options.environment ?? process.env;
  const registry = options.registry ?? new ManagedProcessRegistry({
    outputLimitBytes: options.outputLimitBytes,
    killGraceMs: options.killGraceMs
  });
  const exec = new ProcessExecTool({ ...options, policy, environment });
  const background = createProcessBackgroundTools({ registry, policy, environment });
  const which = new ProcessWhichTool({ environment });

  return {
    registry,
    exec,
    which,
    tools: [exec, ...background.tools, which]
  };
}
