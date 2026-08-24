export type MediaKind = 'image' | 'video' | 'text';

const VIDEO_FILE_PATTERN = /\.(?:mp4|m4v|webm|mov|ogv|mpeg|mpg|avi)(?:$|[?#&])/i;

export function resolveMediaKind(kind: MediaKind, filename?: string, url?: string): MediaKind {
  if (kind === 'image' && (VIDEO_FILE_PATTERN.test(filename ?? '') || VIDEO_FILE_PATTERN.test(url ?? ''))) {
    return 'video';
  }
  return kind;
}
