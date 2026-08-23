export interface GenerationMetadataSource {
  id: string;
  workflowId: string;
  prompt: string;
  params?: Record<string, unknown>;
  generationParams?: Record<string, unknown>;
  ratio?: string;
  size?: number;
  createdAt: number;
}

export interface GenerationMetadata {
  taskId: string;
  workflowId: string;
  prompt: string;
  params?: Record<string, unknown>;
  generationParams?: Record<string, unknown>;
  ratio?: string;
  size?: number;
  createdAt: number;
}

export function buildGenerationMetadata(source: GenerationMetadataSource): GenerationMetadata {
  return {
    taskId: source.id,
    workflowId: source.workflowId,
    prompt: source.prompt,
    ...(source.generationParams ? { params: source.generationParams } : source.params ? { params: source.params } : {}),
    ...(source.ratio ? { ratio: source.ratio } : {}),
    ...(source.size !== undefined ? { size: source.size } : {}),
    createdAt: source.createdAt,
  };
}
