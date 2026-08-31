import fs from 'node:fs/promises';

/**
 * Creates a directory link without requiring Windows Developer Mode or an elevated shell.
 * Junctions provide the directory-reparse semantics these tests need on Windows, while
 * POSIX platforms use an ordinary directory symlink.
 */
export async function createDirectoryLink(target: string, linkPath: string): Promise<void> {
  await fs.symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}
