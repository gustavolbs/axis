import type { AdminProject } from './app-types.js';

export type ProjectScheduleFrequency = 'manual' | 'hourly' | 'daily' | 'weekdays' | 'weekly';

export interface ProjectScheduledTask {
  id: string;
  projectId: string;
  companyId: string;
  name: string;
  prompt: string;
  frequency: ProjectScheduleFrequency;
  time?: string;
  weekday?: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string;
  lastRunAt?: string;
  lastJobId?: string;
  lastError?: string;
}

export interface ProjectScheduleDraft {
  name: string;
  prompt: string;
  frequency: ProjectScheduleFrequency;
  time?: string;
  weekday?: number;
  enabled?: boolean;
}

const KEY = 'local-coder.project-schedules.v1';
export const PROJECT_SCHEDULES_CHANGED = 'local-coder:project-schedules-changed';
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function projectCompanyId(project: AdminProject): string {
  return project.companyId || project.organizationId || 'personal';
}

function read(): ProjectScheduledTask[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(value) ? value.filter((item): item is ProjectScheduledTask => Boolean(item && typeof item === 'object' && !Array.isArray(item) && typeof (item as ProjectScheduledTask).id === 'string')) : [];
  } catch {
    return [];
  }
}

function write(tasks: ProjectScheduledTask[]): void {
  localStorage.setItem(KEY, JSON.stringify(tasks));
  window.dispatchEvent(new CustomEvent(PROJECT_SCHEDULES_CHANGED));
}

function atTime(base: Date, time: string): Date {
  const match = TIME.exec(time);
  if (!match) throw new Error('Time must use 24-hour HH:MM format.');
  const next = new Date(base);
  next.setHours(Number(match[1]), Number(match[2]), 0, 0);
  return next;
}

export function nextProjectScheduleRun(task: Pick<ProjectScheduledTask, 'frequency' | 'time' | 'weekday' | 'enabled'>, from = new Date()): string | undefined {
  if (!task.enabled || task.frequency === 'manual') return undefined;
  const after = new Date(from.getTime() + 1_000);
  if (task.frequency === 'hourly') {
    const next = new Date(after);
    next.setMinutes(0, 0, 0);
    if (next <= after) next.setHours(next.getHours() + 1);
    return next.toISOString();
  }
  const time = task.time ?? '09:00';
  if (task.frequency === 'daily') {
    const next = atTime(after, time);
    if (next <= after) next.setDate(next.getDate() + 1);
    return next.toISOString();
  }
  if (task.frequency === 'weekdays') {
    const next = atTime(after, time);
    if (next <= after) next.setDate(next.getDate() + 1);
    while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1);
    return next.toISOString();
  }
  const weekday = task.weekday ?? 1;
  const next = atTime(after, time);
  next.setDate(next.getDate() + ((weekday - next.getDay() + 7) % 7));
  if (next <= after) next.setDate(next.getDate() + 7);
  return next.toISOString();
}

function normalize(draft: ProjectScheduleDraft): ProjectScheduleDraft {
  const name = draft.name.trim();
  const prompt = draft.prompt.trim();
  if (!name) throw new Error('Task name is required.');
  if (!prompt) throw new Error('Task prompt is required.');
  const needsTime = ['daily', 'weekdays', 'weekly'].includes(draft.frequency);
  const time = draft.time?.trim() || undefined;
  if (needsTime && (!time || !TIME.test(time))) throw new Error('Choose a valid time.');
  if (draft.frequency === 'weekly' && (!Number.isInteger(draft.weekday) || draft.weekday! < 0 || draft.weekday! > 6)) throw new Error('Choose a weekday.');
  return { ...draft, name, prompt, time };
}

export function listProjectScheduledTasks(projectId: string): ProjectScheduledTask[] {
  return read().filter((task) => task.projectId === projectId).sort((a, b) => (a.nextRunAt ?? '9999').localeCompare(b.nextRunAt ?? '9999'));
}

export function allProjectScheduledTasks(): ProjectScheduledTask[] {
  return read();
}

export function createProjectScheduledTask(project: AdminProject, draft: ProjectScheduleDraft): ProjectScheduledTask {
  const valid = normalize(draft);
  const now = new Date().toISOString();
  const task: ProjectScheduledTask = { id: crypto.randomUUID(), projectId: project.id, companyId: projectCompanyId(project), name: valid.name, prompt: valid.prompt, frequency: valid.frequency, time: valid.time, weekday: valid.weekday, enabled: valid.enabled ?? true, createdAt: now, updatedAt: now };
  task.nextRunAt = nextProjectScheduleRun(task, new Date(now));
  write([task, ...read()]);
  return task;
}

export function updateProjectScheduledTask(id: string, draft: ProjectScheduleDraft): ProjectScheduledTask {
  const valid = normalize(draft);
  const tasks = read();
  const current = tasks.find((task) => task.id === id);
  if (!current) throw new Error('Scheduled task not found.');
  const next: ProjectScheduledTask = { ...current, name: valid.name, prompt: valid.prompt, frequency: valid.frequency, time: valid.time, weekday: valid.weekday, enabled: valid.enabled ?? current.enabled, updatedAt: new Date().toISOString() };
  next.nextRunAt = nextProjectScheduleRun(next);
  write(tasks.map((task) => task.id === id ? next : task));
  return next;
}

export function patchProjectScheduledTask(id: string, patch: Partial<ProjectScheduledTask>): ProjectScheduledTask {
  const tasks = read();
  const current = tasks.find((task) => task.id === id);
  if (!current) throw new Error('Scheduled task not found.');
  const next = { ...current, ...patch, id: current.id, projectId: current.projectId, companyId: current.companyId, updatedAt: new Date().toISOString() };
  write(tasks.map((task) => task.id === id ? next : task));
  return next;
}

export function deleteProjectScheduledTask(id: string): void {
  write(read().filter((task) => task.id !== id));
}
