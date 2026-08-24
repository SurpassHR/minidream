import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import type { LightboxImage } from './ImageLightbox';
import { VideoPreview } from './VideoPreview';

export default function VideoLightbox({
  src,
  name,
  generation,
  onClose,
}: {
  src: string;
  name: string;
  generation?: LightboxImage['generation'];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [infoOpen, setInfoOpen] = useState(Boolean(generation));
  const [copied, setCopied] = useState(false);
  const [videoSize, setVideoSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    setInfoOpen(Boolean(generation));
    setCopied(false);
    setVideoSize(null);
  }, [generation]);

  const formatValue = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };

  const copyPrompt = async () => {
    if (!generation?.prompt) return;
    try {
      await navigator.clipboard.writeText(generation.prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div
      className="video-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={t('assets.videoPreviewAria', { name })}
      onClick={onClose}
    >
      <div className="video-lightbox-content" onClick={event => event.stopPropagation()}>
        <VideoPreview
          className="video-lightbox-player"
          src={src}
          onMediaRatio={(width, height) => setVideoSize({ w: width, h: height })}
        />
        <div className="video-lightbox-name">{name}</div>
      </div>
      {generation && (
        <>
          <button
            type="button"
            className={`lightbox-info-toggle video-lightbox-info-toggle${infoOpen ? ' active' : ''}`}
            aria-label={t('lightbox.infoToggle')}
            title={t('lightbox.infoToggle')}
            onClick={event => {
              event.stopPropagation();
              setInfoOpen(open => !open);
            }}
          >
            i
          </button>
          {infoOpen && (
            <aside className="lightbox-info video-lightbox-info" onClick={event => event.stopPropagation()}>
              <div className="lightbox-info-head">
                <strong>{t('lightbox.infoTitle')}</strong>
                <button
                  className="lightbox-info-close"
                  aria-label={t('lightbox.infoClose')}
                  title={t('lightbox.infoClose')}
                  onClick={() => setInfoOpen(false)}
                >
                  ×
                </button>
              </div>
              <div className="lightbox-info-section">
                <div className="lightbox-info-label">{t('lightbox.prompt')}</div>
                <pre className="lightbox-prompt"><code>{generation.prompt || t('lightbox.notRecorded')}</code></pre>
                {generation.prompt && (
                  <button className="lightbox-copy" onClick={() => void copyPrompt()}>
                    {copied ? t('lightbox.copied') : t('lightbox.copyPrompt')}
                  </button>
                )}
              </div>
              <dl className="lightbox-info-list">
                {generation.workflowId && (
                  <div><dt>{t('lightbox.workflow')}</dt><dd>{generation.workflowId}</dd></div>
                )}
                {videoSize && (
                  <div><dt>{t('lightbox.resolution')}</dt><dd>{videoSize.w} × {videoSize.h} px</dd></div>
                )}
                {generation.ratio && (
                  <div><dt>{t('lightbox.ratio')}</dt><dd>{generation.ratio}</dd></div>
                )}
                {generation.size !== undefined && (
                  <div><dt>{t('lightbox.size')}</dt><dd>{generation.size} MP</dd></div>
                )}
                {generation.createdAt && (
                  <div><dt>{t('lightbox.createdAt')}</dt><dd>{new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(generation.createdAt)}</dd></div>
                )}
              </dl>
              {generation.params && Object.keys(generation.params).length > 0 && (
                <div className="lightbox-info-section">
                  <div className="lightbox-info-label">{t('lightbox.params')}</div>
                  <dl className="lightbox-params">
                    {Object.entries(generation.params)
                      .filter(([, value]) => value !== undefined && value !== null)
                      .map(([key, value]) => (
                        <div key={key}><dt>{key}</dt><dd>{formatValue(value)}</dd></div>
                      ))}
                  </dl>
                </div>
              )}
            </aside>
          )}
        </>
      )}
      <button
        type="button"
        className="video-lightbox-close"
        aria-label={t('assets.closeVideoPreview')}
        title={t('assets.closeVideoPreview')}
        onClick={event => {
          event.stopPropagation();
          onClose();
        }}
      >
        ×
      </button>
    </div>
  );
}
