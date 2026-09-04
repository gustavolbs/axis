import type { AdminProject } from './app-types.js';
import {
  allProjectScheduledTasks,
  nextProjectScheduleRun,
  patchProjectScheduledTask,
  projectCompanyId,
  type ProjectScheduledTask
} from './project-schedules.js';

let installed = false;
let ticking = false;

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { accept: 'application/json', 'content-type': 'application/json', ...(init?.headers ?? {}) }
  });
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
  return payload;
}

async function projectForTask(task: ProjectScheduledTask): Promise<AdminProject> {
  const { projects } = await api<{ projects: AdminProject[] }>('/api/projects');
  const project = projects.find((candidate) => candidate.id === task.projectId);
  if (!project) throw new Error('The Project for this scheduled task no longer exists.');
  if (projectCompanyId(project) !== task.companyId) throw new Error('Scheduled task Company no longer matches the Project owner.');
  return project;
}

export async function runProjectScheduledTask(taskId: string, options: { advanceSchedule?: boolean } = {}): Promise<ProjectScheduledTask> {
  const task = allProjectScheduledTasks().find((candidate) => candidate.id === taskId);
  if (!task) throw new Error('Scheduled task not found.');
  const project = await projectForTask(task);
  const started = new Date();
  const claimed = patchProjectScheduledTask(task.id, {
    lastRunAt: started.toISOString(),
    lastError: undefined,
    nextRunAt: options.advanceSchedule ? nextProjectScheduleRun(task, started) : task.nextRunAt
  });
  try {
    const { job } = await api<{ job: { id: string } }>('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({
        projectId: project.id,
        goal: task.prompt,
        interactionMode: project.workspace?.trim() ? 'cowork' : 'chat',
        maxRepairRounds: 1,
        reasoningEffort: 'auto'
      })
    });
    return patchProjectScheduledTask(task.id, { lastJobId: job.id, lastError: undefined });
  } catch (error) {
    patchProjectScheduledTask(task.id, { lastError: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

async function runDueTasks(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    const due = allProjectScheduledTasks().filter((task) => task.enabled && task.nextRunAt && Date.parse(task.nextRunAt) <= now);
    for (const task of due) {
      try {
        await runProjectScheduledTask(task.id, { advanceSchedule: true });
      } catch (error) {
        console.error(`Could not start scheduled Project task ${task.id}`, error);
      }
    }
  } finally {
    ticking = false;
  }
}

export function installProjectScheduleRunner(): void {
  if (installed) return;
  installed = true;
  window.setTimeout(() => void runDueTasks(), 2_000);
  window.setInterval(() => void runDueTasks(), 30_000);
}
