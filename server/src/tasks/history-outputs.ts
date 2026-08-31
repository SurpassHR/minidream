import type { WorkflowOutput } from '../workflow.js';
import type { TaskOutputCandidate } from './types.js';
import { viewUrl } from '../comfyui.js';

function scalarValues(nodeOut: Record<string, any>): unknown[] {
  if (Array.isArray(nodeOut.values)) return nodeOut.values;
  for (const key of ['value', 'values', 'string', 'strings', 'number', 'numbers', 'boolean', 'booleans']) {
    const value = nodeOut[key];
    if (Array.isArray(value)) return value;
    if (value !== undefined && value !== null) return [value];
  }
  return [];
}

function scalarText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function extractHistoryOutputs(
  historyOutputs: Record<string, any>,
  outputMappings: WorkflowOutput[],
): TaskOutputCandidate[] {
  const outputs: TaskOutputCandidate[] = [];
  for (const mapping of outputMappings.filter(output => !output.hidden)) {
    const nodeOut = historyOutputs[mapping.nodeId];
    if (!nodeOut || typeof nodeOut !== 'object') continue;

    if (mapping.kind === 'number' || mapping.kind === 'boolean') {
      const values = scalarValues(nodeOut);
      const value = values[mapping.slot ?? 0];
      if (value === undefined) continue;
      const normalized = mapping.kind === 'number'
        ? (typeof value === 'number' ? value : Number(value))
        : (typeof value === 'boolean' ? value : String(value).toLowerCase() === 'true');
      if (mapping.kind === 'number' && (typeof normalized !== 'number' || !Number.isFinite(normalized))) continue;
      outputs.push({
        kind: mapping.kind,
        label: mapping.label,
        value: normalized,
        text: scalarText(normalized),
        filename: `${mapping.nodeId}-${(mapping.slot ?? 0) + 1}.${mapping.kind}`,
        url: `data:text/plain;charset=utf-8,${encodeURIComponent(scalarText(normalized))}`,
      });
      continue;
    }
    if (Array.isArray(nodeOut.images)) {
      for (const image of nodeOut.images) {
        outputs.push({
          // Some video nodes (including SaveVideo) expose MP4 files under `images`.
          // The declared workflow output mapping is more authoritative than the key.
          kind: mapping.kind === 'video' ? 'video' : 'image',
          label: mapping.label,
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
          label: mapping.label,
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
          label: mapping.label,
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
          label: mapping.label,
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
