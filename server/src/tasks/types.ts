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

export interface TaskMediaUpload {
  name?: string;
  dataUrl: string;
}

export interface TaskOutput {
  kind: 'image' | 'video' | 'text';
  url: string;
  filename: string;
  subfolder?: string;
  type?: string;
}

/** 队列内部完成态输出，data 只在转存前存在，不会写入任务索引。 */
export interface TaskOutputCandidate extends TaskOutput {
  data?: Buffer;
  mime?: string;
}

export interface TaskItem {
  id: string;
  type: TaskType;
  status: TaskStatus;
  workflowId: string;
  prompt: string;
  images?: string[];
  videos?: string[];
  imageUploads?: TaskMediaUpload[];
  videoUploads?: TaskMediaUpload[];
  params?: Record<string, unknown>;
  sessionId?: string;
  promptGraph?: Record<string, unknown>;
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
  videos?: string[];
  imageUploads?: TaskMediaUpload[];
  videoUploads?: TaskMediaUpload[];
  params?: Record<string, unknown>;
  sessionId?: string;
  promptGraph?: Record<string, unknown>;
}
