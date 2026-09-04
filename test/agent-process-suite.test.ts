import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PROCESS_EXEC_TOOL_NAME,
  PROCESS_LIST_TOOL_NAME,
  PROCESS_POLL_TOOL_NAME,
  PROCESS_RESIZE_TOOL_NAME,
  PROCESS_SIGNAL_TOOL_NAME,
  PROCESS_START_TOOL_NAME,
  PROCESS_STDIN_TOOL_NAME,
  PROCESS_TERMINATE_TOOL_NAME,
  PROCESS_WAIT_TOOL_NAME,
  PROCESS_WHICH_TOOL_NAME,
  createProcessTools
} from '../src/agent-tools/process/index.js';

test('createProcessTools exposes one provider-neutral process capability surface', () => {
  const suite = createProcessTools({ outputLimitBytes: 1024, killGraceMs: 10 });
  const names = suite.tools.map((tool) => tool.definition.name).sort();
  assert.deepEqual(names, [
    PROCESS_EXEC_TOOL_NAME,
    PROCESS_LIST_TOOL_NAME,
    PROCESS_POLL_TOOL_NAME,
    PROCESS_RESIZE_TOOL_NAME,
    PROCESS_SIGNAL_TOOL_NAME,
    PROCESS_START_TOOL_NAME,
    PROCESS_STDIN_TOOL_NAME,
    PROCESS_TERMINATE_TOOL_NAME,
    PROCESS_WAIT_TOOL_NAME,
    PROCESS_WHICH_TOOL_NAME
  ].sort());
  assert.equal(new Set(names).size, names.length);
  assert.ok(suite.registry);
  assert.equal(suite.exec.definition.requiredCapabilities[0], 'axis.process.exec');
  assert.equal(suite.which.definition.requiredCapabilities[0], 'axis.process.exec');
});
