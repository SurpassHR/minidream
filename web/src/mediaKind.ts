export type MediaKind = 'image' | 'video' | 'text';
export type OutputKind = MediaKind | 'number' | 'boolean';

const VIDEO_FILE_PATTERN = /\.(?:mp4|m4v|webm|mov|ogv|mpeg|mpg|avi)(?:$|[?#&])/i;

export function resolveMediaKind(kind: OutputKind, filename?: string, url?: string): OutputKind {
  if (kind === 'image' && (VIDEO_FILE_PATTERN.test(filename ?? '') || VIDEO_FILE_PATTERN.test(url ?? ''))) {
    return 'video';
  }
  return kind;
}
