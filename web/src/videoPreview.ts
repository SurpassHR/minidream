/**
 * Capture the currently decoded video frame for use as a thumbnail/poster.
 * The caller is expected to invoke this from a media loading event.
 */
export function captureVideoFrame(video: HTMLVideoElement): string | null {
  if (video.videoWidth <= 0 || video.videoHeight <= 0) return null;

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext('2d');
  if (!context) return null;

  try {
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.82);
  } catch {
    // A cross-origin or unsupported media source may not be drawable.
    return null;
  }
}
