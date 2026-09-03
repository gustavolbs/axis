import type { AxisTool } from '../../agent-runtime/index.js';
import { listDirectoryTool, readFileTool, statFileTool } from './read-tools.js';
import { searchFilesTool, searchTextTool } from './search-tools.js';
import { createFileTool, editFileTool, writeFileTool } from './write-tools.js';
import { patchFileTool } from './patch-tools.js';
import {
  copyPathTool,
  createDirectoryTool,
  deletePathTool,
  movePathTool,
  setFileModeTool
} from './operation-tools.js';

export { FILESYSTEM_CAPABILITIES, FILESYSTEM_PERMISSIONS } from './io.js';
export { listDirectoryTool, readFileTool, statFileTool } from './read-tools.js';
export { searchFilesTool, searchTextTool } from './search-tools.js';
export { createFileTool, editFileTool, writeFileTool } from './write-tools.js';
export { patchFileTool } from './patch-tools.js';
export {
  copyPathTool,
  createDirectoryTool,
  deletePathTool,
  movePathTool,
  setFileModeTool
} from './operation-tools.js';

/** Baseline tool set introduced by the first filesystem increment. */
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

/** Extended P1.2 catalog. Composition can adopt this without any runtime change. */
export const FILESYSTEM_P1_2_TOOLS: readonly AxisTool[] = Object.freeze([
  ...FILESYSTEM_TOOLS,
  patchFileTool,
  createDirectoryTool,
  movePathTool,
  copyPathTool,
  deletePathTool,
  setFileModeTool
]);

export function createFilesystemTools(): readonly AxisTool[] {
  return FILESYSTEM_TOOLS;
}

export function createFilesystemP12Tools(): readonly AxisTool[] {
  return FILESYSTEM_P1_2_TOOLS;
}
