export interface EngineeringProgress {
  phase?: string;
  action?: string;
  detail?: string;
  reasoningSummary?: string;
  taskId?: string;
  files?: string[];
  validation?: string;
  completedSteps?: string[];
  updatedAt?: string;
}

export type ProgressReporter = (progress: Partial<EngineeringProgress>) => void;
