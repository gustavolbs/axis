export interface EngineeringProgress {
  phase?: string;
  action?: string;
  detail?: string;
  reasoningSummary?: string;
  taskId?: string;
  files?: string[];
  validation?: string;
  completedSteps?: string[];
  /** Safe stream telemetry for the UI; never contains model reasoning text. */
  streamState?: 'waiting-response' | 'reasoning' | 'generating';
  providerId?: string;
  model?: string;
  eventCount?: number;
  outputChars?: number;
  elapsedMs?: number;
  updatedAt?: string;
}

export type ProgressReporter = (progress: Partial<EngineeringProgress>) => void;
