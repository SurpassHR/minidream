import type { ChatMessage, GenerationOutput } from './api.js';
import { resolveMediaKind } from './mediaKind.js';

export interface SessionAsset {
  kind: 'image' | 'video';
  url: string;
  name: string;
  filename?: string;
  subfolder?: string;
  type?: string;
  generation?: GenerationOutput['generation'];
}

export function nextSessionAssetName(kind: SessionAsset['kind'], assets: SessionAsset[]): string {
  const prefix = kind.toLowerCase();
  const indexes = assets
    .filter(asset => asset.kind === kind)
    .map(asset => new RegExp(`^${prefix}(\\d+)$`, 'i').exec(asset.name)?.[1])
    .filter((value): value is string => Boolean(value))
    .map(Number)
    .filter(Number.isInteger);
  return `${prefix}${Math.max(0, ...indexes) + 1}`;
}

export function insertAssetMention(text: string, caret: number, name: string): { text: string; caret: number } {
  const before = text.slice(0, caret);
  const suffix = text.slice(caret);
  const separator = suffix.length === 0 || !/^\\s/.test(suffix) ? ' ' : '';
  const inserted = `@${name}${separator}`;
  return {
    text: before + inserted + suffix,
    caret: caret + inserted.length,
  };
}

function outputsFromMessage(message: ChatMessage): GenerationOutput[] {
  const outputs: GenerationOutput[] = [];
  for (const task of message.tasks ?? []) {
    for (const output of task.outputs ?? []) {
      outputs.push({
        kind: resolveMediaKind(output.kind, output.filename, output.url),
        url: output.url,
        filename: output.filename,
        text: output.text,
        value: output.value,
        generation: output.generation,
      });
    }
  }
  for (const stage of message.stages ?? []) {
    for (const output of stage.outputs ?? []) {
      outputs.push({
        ...output,
        kind: resolveMediaKind(output.kind, output.filename, output.url),
      });
    }
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

  const addAsset = (asset: SessionAsset) => {
    if (!asset.url || seen.has(asset.url)) return;
    seen.add(asset.url);
    const name = asset.name || nextSessionAssetName(asset.kind, assets);
    const index = /^\D+(\d+)$/.exec(name)?.[1];
    if (index) counts[asset.kind] = Math.max(counts[asset.kind], Number(index));
    assets.push({ ...asset, name });
  };

  for (const message of messages) {
    for (const asset of message.assets ?? []) {
      if (asset && typeof asset === 'object' && (asset.kind === 'image' || asset.kind === 'video') && typeof asset.url === 'string') {
        addAsset(asset);
      }
    }
    for (const output of outputsFromMessage(message)) {
      if ((output.kind !== 'image' && output.kind !== 'video') || !output.url) continue;
      addAsset({
        kind: output.kind,
        url: output.url,
        name: nextSessionAssetName(output.kind, assets),
        filename: output.filename,
        subfolder: output.subfolder,
        type: output.type,
        generation: output.generation,
      });
    }
  }

  return assets;
}
