import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { LightboxImage } from './ImageLightbox';
import ImageLightbox from './ImageLightbox';
import VideoLightbox from './VideoLightbox';
import { VideoThumbnail } from './VideoPreview';
import type { SessionAsset } from '../sessionAssets';

export default function SessionAssetsPanel({
  assets,
}: {
  assets: SessionAsset[];
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const [lightboxAsset, setLightboxAsset] = useState<SessionAsset | null>(null);

  const openAsset = (asset: SessionAsset) => {
    setLightboxAsset(asset);
  };

  return (
    <aside className={`session-assets-panel${open ? ' open' : ' collapsed'}`}>
      <button
        className="session-assets-toggle"
        onClick={() => setOpen(value => !value)}
        title={open ? t('assets.collapse') : t('assets.expand')}
        aria-label={open ? t('assets.collapse') : t('assets.expand')}
        aria-expanded={open}
      >
        <svg width="16" height="16" viewBox="0 0 18 18" fill="none" aria-hidden="true">
          <rect x="2.5" y="3" width="13" height="12" rx="2" stroke="currentColor" strokeWidth="1.3" />
          <circle cx="6.5" cy="7" r="1.2" fill="currentColor" />
          <path d="m4.5 13 3.2-3.2 2.4 2.2 1.6-1.6 2.2 2.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {open && <span>{t('assets.title')}</span>}
        {open && <span className="session-assets-count">{assets.length}</span>}
      </button>

      {open && (
        <div className="session-assets-content">
          {assets.length === 0 ? (
            <div className="session-assets-empty">{t('assets.empty')}</div>
          ) : (
            <div className="session-assets-list">
              {assets.map(asset => (
                <div className="session-asset" key={`${asset.kind}:${asset.url}`}>
                  <div className="session-asset-preview">
                    {asset.kind === 'image' ? (
                      <button
                        type="button"
                        className="session-asset-image-button"
                        onClick={() => openAsset(asset)}
                        aria-label={t('assets.viewAria', { name: asset.name })}
                      >
                        <img src={asset.url} alt={asset.name} loading="lazy" />
                      </button>
                    ) : (
                      <VideoThumbnail
                        src={asset.url}
                        alt={t('assets.viewAria', { name: asset.name })}
                        onClick={() => openAsset(asset)}
                      />
                    )}
                  </div>
                  <div className="session-asset-footer">
                    <span className="session-asset-name">{asset.name}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {/* 灯箱必须渲染到 body：面板的 backdrop-filter 会使其成为 fixed 定位的包含块，导致预览被面板裁切 */}
      {lightboxAsset && createPortal(
        lightboxAsset.kind === 'image' ? (
          <ImageLightbox
            image={{
              url: lightboxAsset.url,
              alt: lightboxAsset.name,
              generation: lightboxAsset.generation as LightboxImage['generation'],
            }}
            onClose={() => setLightboxAsset(null)}
          />
        ) : (
          <VideoLightbox
            src={lightboxAsset.url}
            name={lightboxAsset.name}
            generation={lightboxAsset.generation as LightboxImage['generation']}
            onClose={() => setLightboxAsset(null)}
          />
        ),
        document.body,
      )}
    </aside>
  );
}
