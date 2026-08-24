import { useEffect, useState } from 'react';
import { captureVideoFrame } from '../videoPreview';

interface VideoMediaProps {
  src: string;
  className?: string;
  alt?: string;
  onMediaRatio?: (width: number, height: number) => void;
}

function useVideoPoster(src: string, onMediaRatio?: VideoMediaProps['onMediaRatio']): {
  poster: string | undefined;
  capture: (event: React.SyntheticEvent<HTMLVideoElement>) => void;
} {
  const [poster, setPoster] = useState<string>();

  useEffect(() => {
    setPoster(undefined);
  }, [src]);

  const capture = (event: React.SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      onMediaRatio?.(video.videoWidth, video.videoHeight);
      setPoster(current => current ?? captureVideoFrame(video) ?? undefined);
    }
  };

  return { poster, capture };
}

/** Full video player used for generated results. Its poster is the first decoded frame. */
export function VideoPreview({ src, className, onMediaRatio }: Omit<VideoMediaProps, 'alt'>) {
  const { poster, capture } = useVideoPoster(src, onMediaRatio);
  return (
    <video
      className={className}
      src={src}
      poster={poster}
      controls
      playsInline
      preload="auto"
      onLoadedData={capture}
      onCanPlay={capture}
    />
  );
}

/** Static thumbnail that promotes the first decoded video frame to an image. */
export function VideoThumbnail({ src, alt, className, onClick }: VideoMediaProps & { onClick?: () => void }) {
  const [poster, setPoster] = useState<string>();

  useEffect(() => {
    setPoster(undefined);
  }, [src]);

  const capture = (event: React.SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    const nextPoster = captureVideoFrame(video);
    if (nextPoster) setPoster(nextPoster);
  };

  return (
    <button
      type="button"
      className={`video-thumbnail${className ? ` ${className}` : ''}`}
      onClick={onClick}
      aria-label={alt}
    >
      {poster ? (
        <img className="video-thumbnail-image" src={poster} alt={alt} />
      ) : (
        <video
          className="video-thumbnail-video"
          src={src}
          muted
          playsInline
          preload="auto"
          onLoadedData={capture}
          onCanPlay={capture}
        />
      )}
      <span className="video-thumbnail-play" aria-hidden="true">▶</span>
    </button>
  );
}
