import type { AxisTool } from '../../agent-runtime/index.js';
import { listDirectoryTool, readFileTool, statFileTool } from './read-tools.js';
import { searchFilesTool, searchTextTool } from './search-tools.js';
import { createFileTool, editFileTool, writeFileTool } from './write-tools.js';

export { FILESYSTEM_CAPABILITIES, FILESYSTEM_PERMISSIONS } from './io.js';
export { listDirectoryTool, readFileTool, statFileTool } from './read-tools.js';
export { searchFilesTool, searchTextTool } from './search-tools.js';
export { createFileTool, editFileTool, writeFileTool } from './write-tools.js';

export const FILESYSTEM_TOOLS: readonly AxisTool[] = Object.freeze([
  listDirectoryTool,
  readFileTool,
  statFileTool,
  searchFilesTool,
  searchTextTool,
  createFileTool,
  writeFileTool,
  editFileTool
]);

export function createFilesystemTools(): readonly AxisTool[] {
  return FILESYSTEM_TOOLS;
}
