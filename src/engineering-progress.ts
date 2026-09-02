export interface EngineeringProgress {
  phase?: string;
  action?: string;
  detail?: string;
  reasoningSummary?: string;
  /** Provider-neutral UI event. Labels are rendered from this value, not inferred from prose. */
  activityKind?:
    | 'connecting'
    | 'thinking'
    | 'reading'
    | 'searching-repository'
    | 'searching-web'
    | 'tool'
    | 'writing'
    | 'validating'
    | 'working';
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
