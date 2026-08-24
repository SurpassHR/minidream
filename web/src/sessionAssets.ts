import type { ChatMessage, GenerationOutput } from './api.js';

export interface SessionAsset {
  kind: 'image' | 'video';
  url: string;
  name: string;
  filename?: string;
  generation?: GenerationOutput['generation'];
}

function outputsFromMessage(message: ChatMessage): GenerationOutput[] {
  const outputs: GenerationOutput[] = [];
  for (const task of message.tasks ?? []) {
    for (const output of task.outputs ?? []) {
      outputs.push({
        kind: output.kind,
        url: output.url,
        filename: output.filename,
        generation: output.generation,
      });
    }
  }
  for (const stage of message.stages ?? []) {
    outputs.push(...(stage.outputs ?? []));
  }
  return outputs;
}

export function findMentionedSessionAssets(text: string, assets: SessionAsset[]): SessionAsset[] {
  const byName = new Map(assets.map(asset => [asset.name.toLowerCase(), asset]));
  const mentioned: SessionAsset[] = [];
  const seen = new Set<string>();
  const mentionPattern = /@(image\d+|video\d+)(?![\w])/gi;
  let match: RegExpExecArray | null;
  while ((match = mentionPattern.exec(text))) {
    const name = match[1]?.toLowerCase();
    const asset = name ? byName.get(name) : undefined;
    if (asset && !seen.has(asset.name.toLowerCase())) {
      seen.add(asset.name.toLowerCase());
      mentioned.push(asset);
    }
  }
  return mentioned;
}

export function extractSessionAssets(messages: ChatMessage[]): SessionAsset[] {
  const assets: SessionAsset[] = [];
  const seen = new Set<string>();
  const counts: Record<'image' | 'video', number> = { image: 0, video: 0 };

  for (const message of messages) {
    for (const output of outputsFromMessage(message)) {
      if ((output.kind !== 'image' && output.kind !== 'video') || !output.url || seen.has(output.url)) continue;
      seen.add(output.url);
      counts[output.kind] += 1;
      assets.push({
        kind: output.kind,
        url: output.url,
        name: `${output.kind}${counts[output.kind]}`,
        filename: output.filename,
        generation: output.generation,
      });
    }
  }

  return assets;
}
