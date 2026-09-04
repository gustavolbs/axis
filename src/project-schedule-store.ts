import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ProjectScheduleFrequency = 'manual' | 'hourly' | 'daily' | 'weekdays' | 'weekly';

export interface ProjectScheduleDefinition {
  id: string;
  companyId: string;
  projectId: string;
  name: string;
  prompt: string;
  frequency: ProjectScheduleFrequency;
  /** Local wall-clock time used by daily/weekdays/weekly schedules. */
  time?: string;
  /** JavaScript weekday (0 Sunday ... 6 Saturday) used by weekly schedules. */
  weekday?: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string;
  lastRunAt?: string;
  lastJobId?: string;
  lastError?: string;
}

export interface CreateProjectScheduleInput {
  companyId: string;
  projectId: string;
  name: string;
  prompt: string;
  frequency: ProjectScheduleFrequency;
  time?: string;
  weekday?: number;
  enabled?: boolean;
}

export interface UpdateProjectScheduleInput {
  name?: string;
  prompt?: string;
  frequency?: ProjectScheduleFrequency;
  time?: string;
  weekday?: number;
  enabled?: boolean;
}

interface ProjectScheduleFile {
  version: 1;
  schedules: ProjectScheduleDefinition[];
  updatedAt: string;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const FREQUENCIES = new Set<ProjectScheduleFrequency>(['manual', 'hourly', 'daily', 'weekdays', 'weekly']);
const MAX_NAME = 160;
const MAX_PROMPT = 40_000;

function safeId(value: string, label: string): string {
  const clean = value.trim();
  if (!SAFE_ID.test(clean)) throw new Error(`${label} contains unsupported characters.`);
  return clean;
}

function text(value: string, label: string, max: number): string {
  const clean = value.trim();
  if (!clean || clean.length > max) throw new Error(`${label} must be 1-${max} characters.`);
  return clean;
}

function normalizeFrequency(value: ProjectScheduleFrequency): ProjectScheduleFrequency {
  if (!FREQUENCIES.has(value)) throw new Error(`Unsupported project schedule frequency: ${String(value)}`);
  return value;
}

function normalizeTime(value: string | undefined, required: boolean): string | undefined {
  const clean = value?.trim();
  if (!clean) {
    if (required) throw new Error('time is required for this schedule frequency.');
    return undefined;
  }
  if (!TIME.test(clean)) throw new Error('time must use 24-hour HH:MM format.');
  return clean;
}

function normalizeWeekday(value: number | undefined, required: boolean): number | undefined {
  if (value === undefined) {
    if (required) throw new Error('weekday is required for weekly schedules.');
    return undefined;
  }
  if (!Number.isInteger(value) || value < 0 || value > 6) throw new Error('weekday must be an integer from 0 to 6.');
  return value;
}

function localAt(base: Date, time: string): Date {
  const match = TIME.exec(time);
  if (!match) throw new Error('Invalid project schedule time.');
  const next = new Date(base);
  next.setHours(Number(match[1]), Number(match[2]), 0, 0);
  return next;
}

export function nextProjectScheduleRun(
  schedule: Pick<ProjectScheduleDefinition, 'frequency' | 'time' | 'weekday' | 'enabled'>,
  from = new Date()
): string | undefined {
  if (!schedule.enabled || schedule.frequency === 'manual') return undefined;
  const after = new Date(from.getTime() + 1_000);

  if (schedule.frequency === 'hourly') {
    const next = new Date(after);
    next.setMinutes(0, 0, 0);
    if (next.getTime() <= after.getTime()) next.setHours(next.getHours() + 1);
    return next.toISOString();
  }

  const time = schedule.time ?? '09:00';
  if (schedule.frequency === 'daily') {
    const next = localAt(after, time);
    if (next.getTime() <= after.getTime()) next.setDate(next.getDate() + 1);
    return next.toISOString();
  }

  if (schedule.frequency === 'weekdays') {
    const next = localAt(after, time);
    if (next.getTime() <= after.getTime()) next.setDate(next.getDate() + 1);
    while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1);
    return next.toISOString();
  }

  const weekday = schedule.weekday ?? 1;
  const next = localAt(after, time);
  const delta = (weekday - next.getDay() + 7) % 7;
  next.setDate(next.getDate() + delta);
  if (next.getTime() <= after.getTime()) next.setDate(next.getDate() + 7);
  return next.toISOString();
}

function normalize(
  input: CreateProjectScheduleInput,
  existing?: ProjectScheduleDefinition,
  preserveUpdatedAt?: string
): ProjectScheduleDefinition {
  const now = preserveUpdatedAt ?? new Date().toISOString();
  const frequency = normalizeFrequency(input.frequency);
  const needsTime = frequency === 'daily' || frequency === 'weekdays' || frequency === 'weekly';
  const enabled = input.enabled ?? existing?.enabled ?? true;
  const schedule: ProjectScheduleDefinition = {
    id: existing?.id ?? randomUUID(),
    companyId: safeId(input.companyId, 'Company id'),
    projectId: safeId(input.projectId, 'Project id'),
    name: text(input.name, 'Task name', MAX_NAME),
    prompt: text(input.prompt, 'Task prompt', MAX_PROMPT),
    frequency,
    time: normalizeTime(input.time, needsTime),
    weekday: normalizeWeekday(input.weekday, frequency === 'weekly'),
    enabled,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastRunAt: existing?.lastRunAt,
    lastJobId: existing?.lastJobId,
    lastError: existing?.lastError
  };
  schedule.nextRunAt = nextProjectScheduleRun(schedule, new Date(now));
  return schedule;
}

function parseSchedule(value: unknown): ProjectScheduleDefinition | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  try {
    if (
      typeof item.id !== 'string' || typeof item.companyId !== 'string' || typeof item.projectId !== 'string' ||
      typeof item.name !== 'string' || typeof item.prompt !== 'string' || typeof item.frequency !== 'string' ||
      typeof item.enabled !== 'boolean' || typeof item.createdAt !== 'string' || typeof item.updatedAt !== 'string' ||
      (item.time !== undefined && typeof item.time !== 'string') ||
      (item.weekday !== undefined && typeof item.weekday !== 'number')
    ) return undefined;
    const existing = item as unknown as ProjectScheduleDefinition;
    const parsed = normalize({
      companyId: existing.companyId,
      projectId: existing.projectId,
      name: existing.name,
      prompt: existing.prompt,
      frequency: existing.frequency,
      time: existing.time,
      weekday: existing.weekday,
      enabled: existing.enabled
    }, existing, existing.updatedAt);
    parsed.nextRunAt = typeof item.nextRunAt === 'string' ? item.nextRunAt : nextProjectScheduleRun(parsed, new Date());
    parsed.lastRunAt = typeof item.lastRunAt === 'string' ? item.lastRunAt : undefined;
    parsed.lastJobId = typeof item.lastJobId === 'string' ? item.lastJobId : undefined;
    parsed.lastError = typeof item.lastError === 'string' ? item.lastError : undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function projectScheduleStorePath(): string {
  return process.env.AXIS_PROJECT_SCHEDULES_PATH?.trim()
    || process.env.LOCAL_CODER_PROJECT_SCHEDULES_PATH?.trim()
    || path.join(os.homedir(), '.local-coder-mcp', 'project-schedules.json');
}

export class ProjectScheduleStore {
  constructor(private readonly file = projectScheduleStorePath()) {}

  listForProject(companyId: string, projectId: string): ProjectScheduleDefinition[] {
    const company = safeId(companyId, 'Company id');
    const project = safeId(projectId, 'Project id');
    return this.read().schedules
      .filter((schedule) => schedule.companyId === company && schedule.projectId === project)
      .sort((a, b) => (a.nextRunAt ?? '9999').localeCompare(b.nextRunAt ?? '9999'))
      .map((schedule) => structuredClone(schedule));
  }

  due(now = new Date()): ProjectScheduleDefinition[] {
    const timestamp = now.getTime();
    return this.read().schedules
      .filter((schedule) => schedule.enabled && schedule.nextRunAt && Date.parse(schedule.nextRunAt) <= timestamp)
      .sort((a, b) => (a.nextRunAt ?? '').localeCompare(b.nextRunAt ?? ''))
      .map((schedule) => structuredClone(schedule));
  }

  get(id: string): ProjectScheduleDefinition | undefined {
    const scheduleId = safeId(id, 'Schedule id');
    const schedule = this.read().schedules.find((entry) => entry.id === scheduleId);
    return schedule ? structuredClone(schedule) : undefined;
  }

  create(input: CreateProjectScheduleInput): ProjectScheduleDefinition {
    const state = this.read();
    const schedule = normalize(input);
    state.schedules.unshift(schedule);
    state.updatedAt = schedule.updatedAt;
    this.write(state);
    return structuredClone(schedule);
  }

  update(id: string, patch: UpdateProjectScheduleInput): ProjectScheduleDefinition {
    const scheduleId = safeId(id, 'Schedule id');
    const state = this.read();
    const current = state.schedules.find((entry) => entry.id === scheduleId);
    if (!current) throw new Error(`Scheduled task not found: ${scheduleId}`);
    const schedule = normalize({
      companyId: current.companyId,
      projectId: current.projectId,
      name: patch.name ?? current.name,
      prompt: patch.prompt ?? current.prompt,
      frequency: patch.frequency ?? current.frequency,
      time: patch.time ?? current.time,
      weekday: patch.weekday ?? current.weekday,
      enabled: patch.enabled ?? current.enabled
    }, current);
    state.schedules = state.schedules.map((entry) => entry.id === scheduleId ? schedule : entry);
    state.updatedAt = schedule.updatedAt;
    this.write(state);
    return structuredClone(schedule);
  }

  recordRun(
    id: string,
    result: { jobId?: string; error?: string; advanceSchedule?: boolean },
    at = new Date()
  ): ProjectScheduleDefinition {
    const scheduleId = safeId(id, 'Schedule id');
    const state = this.read();
    const current = state.schedules.find((entry) => entry.id === scheduleId);
    if (!current) throw new Error(`Scheduled task not found: ${scheduleId}`);
    const updatedAt = at.toISOString();
    const schedule: ProjectScheduleDefinition = {
      ...current,
      updatedAt,
      lastRunAt: updatedAt,
      lastJobId: result.jobId,
      lastError: result.error?.trim() || undefined,
      nextRunAt: result.advanceSchedule === false
        ? current.nextRunAt
        : nextProjectScheduleRun(current, at)
    };
    state.schedules = state.schedules.map((entry) => entry.id === scheduleId ? schedule : entry);
    state.updatedAt = updatedAt;
    this.write(state);
    return structuredClone(schedule);
  }

  remove(id: string): boolean {
    const scheduleId = safeId(id, 'Schedule id');
    const state = this.read();
    const next = state.schedules.filter((entry) => entry.id !== scheduleId);
    if (next.length === state.schedules.length) return false;
    state.schedules = next;
    state.updatedAt = new Date().toISOString();
    this.write(state);
    return true;
  }

  removeForProject(companyId: string, projectId: string): number {
    const company = safeId(companyId, 'Company id');
    const project = safeId(projectId, 'Project id');
    const state = this.read();
    const before = state.schedules.length;
    state.schedules = state.schedules.filter((entry) => entry.companyId !== company || entry.projectId !== project);
    const removed = before - state.schedules.length;
    if (removed > 0) {
      state.updatedAt = new Date().toISOString();
      this.write(state);
    }
    return removed;
  }

  private read(): ProjectScheduleFile {
    if (!fs.existsSync(this.file)) return { version: 1, schedules: [], updatedAt: new Date(0).toISOString() };
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
    } catch (error) {
      throw new Error(`Could not read Axis project schedules: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Axis project schedules file must be a JSON object.');
    const value = parsed as Record<string, unknown>;
    if (value.version !== 1 || !Array.isArray(value.schedules)) throw new Error(`Unsupported Axis project schedules version: ${String(value.version)}`);
    const schedules = value.schedules.map(parseSchedule);
    if (schedules.some((schedule) => !schedule)) throw new Error('Axis project schedules file contains an invalid scheduled task.');
    return {
      version: 1,
      schedules: schedules as ProjectScheduleDefinition[],
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date(0).toISOString()
    };
  }

  private write(state: ProjectScheduleFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.renameSync(temp, this.file);
      try { fs.chmodSync(this.file, 0o600); } catch { /* best effort on non-POSIX */ }
    } catch (error) {
      try { fs.unlinkSync(temp); } catch { /* best effort */ }
      throw error;
    }
  }
}
