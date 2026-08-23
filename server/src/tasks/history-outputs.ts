import type { WorkflowOutput } from '../workflow.js';
import type { TaskOutputCandidate } from './types.js';
import { viewUrl } from '../comfyui.js';

export function extractHistoryOutputs(
  historyOutputs: Record<string, any>,
  outputMappings: WorkflowOutput[],
): TaskOutputCandidate[] {
  const outputs: TaskOutputCandidate[] = [];
  for (const mapping of outputMappings.filter(output => !output.hidden)) {
    const nodeOut = historyOutputs[mapping.nodeId];
    if (!nodeOut || typeof nodeOut !== 'object') continue;
    if (Array.isArray(nodeOut.images)) {
      for (const image of nodeOut.images) {
        outputs.push({
          kind: 'image',
          filename: image.filename,
          subfolder: image.subfolder,
          type: image.type,
          url: viewUrl(image.filename, image.subfolder || '', image.type || 'output'),
        });
      }
    }
    if (Array.isArray(nodeOut.gifs)) {
      for (const gif of nodeOut.gifs) {
        outputs.push({
          kind: 'video',
          filename: gif.filename,
          subfolder: gif.subfolder,
          type: gif.type,
          url: viewUrl(gif.filename, gif.subfolder || '', gif.type || 'output'),
        });
      }
    }
    if (Array.isArray(nodeOut.videos)) {
      for (const video of nodeOut.videos) {
        outputs.push({
          kind: 'video',
          filename: video.filename,
          subfolder: video.subfolder,
          type: video.type,
          url: viewUrl(video.filename, video.subfolder || '', video.type || 'output'),
        });
      }
    }
    if (Array.isArray(nodeOut.text)) {
      for (const [index, value] of nodeOut.text.entries()) {
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        outputs.push({
          kind: 'text',
          filename: `${mapping.nodeId}-${index + 1}.txt`,
          url: `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`,
          text,
          mime: 'text/plain; charset=utf-8',
          data: Buffer.from(text, 'utf8'),
        });
      }
    }
  }
  return outputs;
}
