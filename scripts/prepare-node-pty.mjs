import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

if (process.platform === 'darwin') {
  const architectures = ['arm64', 'x64'];
  await Promise.all(architectures.map(async (architecture) => {
    const helper = path.resolve('node_modules', 'node-pty', 'prebuilds', `darwin-${architecture}`, 'spawn-helper');
    try {
      await fs.chmod(helper, 0o755);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }));
}
