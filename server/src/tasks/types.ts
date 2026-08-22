export type TaskType = 'image_generation' | 'video_generation';

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'interrupted';

export interface TaskStage {
  id: string;
  name: string;
  status: 'pending' | 'active' | 'completed' | 'failed';
  progress?: number; // 0 - 100
  step?: number;
  totalSteps?: number;
  logs: string[];
}

export interface TaskOutput {
  kind: 'image' | 'video' | 'text';
  url: string;
  filename: string;
  subfolder?: string;
  type?: string;
}

export interface TaskItem {
  id: string;
  type: TaskType;
  status: TaskStatus;
  workflowId: string;
  prompt: string;
  images?: string[];
  params?: Record<string, unknown>;
  sessionId?: string;
  stages: TaskStage[];
  outputs?: TaskOutput[];
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TaskSubmitInput {
  type?: TaskType;
  workflowId: string;
  prompt: string;
  images?: string[];
  params?: Record<string, unknown>;
  sessionId?: string;
}
