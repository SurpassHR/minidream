export interface TaskMediaRatioSource {
  ratio?: string;
  params?: Record<string, unknown>;
  generationParams?: Record<string, unknown>;
  outputParams?: Record<string, unknown>;
}

function positiveDimension(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function ratioFromDimensions(params?: Record<string, unknown>): string | undefined {
  const width = positiveDimension(params?.width);
  const height = positiveDimension(params?.height);
  return width !== undefined && height !== undefined ? `${width} / ${height}` : undefined;
}

/**
 * Returns the best known CSS aspect-ratio value for a task's loading media.
 * Actual generated dimensions win over the selected ratio; unknown sizes stay auto.
 */
export function getTaskMediaAspectRatio(task?: TaskMediaRatioSource): string | undefined {
  if (!task) return undefined;

  const actualRatio = ratioFromDimensions(task.outputParams)
    ?? ratioFromDimensions(task.generationParams)
    ?? ratioFromDimensions(task.params);
  if (actualRatio) return actualRatio;

  const match = task.ratio?.trim().match(/^(\d+(?:\.\d+)?)\s*[:：]\s*(\d+(?:\.\d+)?)$/);
  if (!match) return undefined;

  const width = positiveDimension(match[1]);
  const height = positiveDimension(match[2]);
  return width !== undefined && height !== undefined ? `${width} / ${height}` : undefined;
}

export function getTaskMediaLayoutClass(task?: TaskMediaRatioSource): 'has-aspect-ratio' | 'intrinsic' {
  return getTaskMediaAspectRatio(task) ? 'has-aspect-ratio' : 'intrinsic';
}
