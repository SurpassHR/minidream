import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { LightboxImage } from './ImageLightbox';
import ImageLightbox from './ImageLightbox';
import type { SessionAsset } from '../sessionAssets';

export default function SessionAssetsPanel({
  assets,
}: {
  assets: SessionAsset[];
}) {
  const [open, setOpen] = useState(true);
  const [lightboxAsset, setLightboxAsset] = useState<SessionAsset | null>(null);

  const openImage = (asset: SessionAsset) => {
    setLightboxAsset(asset);
  };

  return (
    <aside className={`session-assets-panel${open ? ' open' : ' collapsed'}`}>
      <button
        className="session-assets-toggle"
        onClick={() => setOpen(value => !value)}
        title={open ? '收起会话素材' : '展开会话素材'}
        aria-label={open ? '收起会话素材' : '展开会话素材'}
        aria-expanded={open}
      >
        <svg width="16" height="16" viewBox="0 0 18 18" fill="none" aria-hidden="true">
          <rect x="2.5" y="3" width="13" height="12" rx="2" stroke="currentColor" strokeWidth="1.3" />
          <circle cx="6.5" cy="7" r="1.2" fill="currentColor" />
          <path d="m4.5 13 3.2-3.2 2.4 2.2 1.6-1.6 2.2 2.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {open && <span>会话素材</span>}
        {open && <span className="session-assets-count">{assets.length}</span>}
      </button>

      {open && (
        <div className="session-assets-content">
          {assets.length === 0 ? (
            <div className="session-assets-empty">生成的图像和视频会显示在这里</div>
          ) : (
            <div className="session-assets-list">
              {assets.map(asset => (
                <div className="session-asset" key={`${asset.kind}:${asset.url}`}>
                  <button
                    className="session-asset-preview"
                    onClick={() => asset.kind === 'image' && openImage(asset)}
                    aria-label={`查看${asset.name}`}
                  >
                    {asset.kind === 'image' ? (
                      <img src={asset.url} alt={asset.name} loading="lazy" />
                    ) : (
                      <video src={asset.url} muted playsInline preload="metadata" />
                    )}
                  </button>
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
        <ImageLightbox
          image={{
            url: lightboxAsset.url,
            alt: lightboxAsset.name,
            generation: lightboxAsset.generation as LightboxImage['generation'],
          }}
          onClose={() => setLightboxAsset(null)}
        />,
        document.body,
      )}
    </aside>
  );
}
