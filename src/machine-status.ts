import { spawn } from 'node:child_process';
import os from 'node:os';

interface CpuSnapshot {
  idle: number;
  total: number;
}

let previousCpu: CpuSnapshot | undefined;
let gpuCache: { at: number; value: Record<string, unknown> | null } = { at: 0, value: null };

function cpuSnapshot(): CpuSnapshot {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

function cpuUsagePercent(): number | null {
  const current = cpuSnapshot();
  const previous = previousCpu;
  previousCpu = current;
  if (!previous) return null;
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (totalDelta <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 1000) / 10));
}

async function queryNvidiaGpu(): Promise<Record<string, unknown> | null> {
  if (Date.now() - gpuCache.at < 1500) return gpuCache.value;

  const value = await new Promise<Record<string, unknown> | null>((resolve) => {
    const args = [
      '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu',
      '--format=csv,noheader,nounits'
    ];
    const child = spawn('nvidia-smi', args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, 1500);

    child.stdout.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      const line = Buffer.concat(chunks).toString('utf8').trim().split(/\r?\n/)[0];
      if (!line) return resolve(null);
      const [name, utilization, memoryUsed, memoryTotal, temperature] = line
        .split(',')
        .map((part) => part.trim());
      resolve({
        name,
        utilizationPercent: Number(utilization),
        memoryUsedMiB: Number(memoryUsed),
        memoryTotalMiB: Number(memoryTotal),
        temperatureC: Number(temperature)
      });
    });
  });

  gpuCache = { at: Date.now(), value };
  return value;
}

export async function getMachineStatus(): Promise<Record<string, unknown>> {
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const processMemory = process.memoryUsage();
  const cpus = os.cpus();

  return {
    hostname: os.hostname(),
    platform: process.platform,
    uptimeSeconds: os.uptime(),
    cpu: {
      model: cpus[0]?.model ?? 'unknown',
      logicalCores: cpus.length,
      usagePercent: cpuUsagePercent()
    },
    memory: {
      totalBytes: totalMemory,
      freeBytes: freeMemory,
      usedBytes: Math.max(0, totalMemory - freeMemory),
      usedPercent: totalMemory > 0 ? Math.round(((totalMemory - freeMemory) / totalMemory) * 1000) / 10 : 0
    },
    workerProcess: {
      pid: process.pid,
      rssBytes: processMemory.rss,
      heapUsedBytes: processMemory.heapUsed,
      uptimeSeconds: process.uptime()
    },
    gpu: await queryNvidiaGpu()
  };
}
