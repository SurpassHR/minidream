import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { deleteDraft, fetchDrafts, type DraftRecord } from '../api';
import { resolveMediaKind } from '../mediaKind';
import ImageLightbox, { type LightboxImage } from './ImageLightbox';
import { VideoPreview } from './VideoPreview';

function formatDate(value: number): string {
  return new Intl.DateTimeFormat(i18n.language, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value);
}

export default function DraftsView() {
  const { t } = useTranslation();
  const [drafts, setDrafts] = useState<DraftRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [lightbox, setLightbox] = useState<LightboxImage | null>(null);

  const refresh = () => {
    setLoading(true);
    fetchDrafts().then(result => setDrafts(result.drafts)).catch(() => undefined).finally(() => setLoading(false));
  };

  useEffect(() => {
    refresh();
  }, []);

  const remove = async (id: string) => {
    try {
      await deleteDraft(id);
      setDrafts(previous => previous.filter(draft => draft.id !== id));
    } catch {
      /* ignore */
    }
  };

  return (
    <section className="drafts-view">
      <header className="drafts-header">
        <div>
          <span className="drafts-kicker">{t('drafts.kicker')}</span>
          <h1>{t('drafts.title')}</h1>
          <p>{t('drafts.desc')}</p>
        </div>
        <button className="drafts-refresh" onClick={refresh} title={t('drafts.refresh')} aria-label={t('drafts.refresh')}>↻</button>
      </header>

      {loading ? (
        <div className="drafts-empty">{t('drafts.loading')}</div>
      ) : drafts.length === 0 ? (
        <div className="drafts-empty">
          <div className="drafts-empty-icon">□</div>
          <h2>{t('drafts.emptyTitle')}</h2>
          <p>{t('drafts.emptyDesc')}</p>
        </div>
      ) : (
        <div className="drafts-grid">
          {drafts.map(draft => {
            const kind = resolveMediaKind(draft.kind, draft.filename);
            return (
            <article className="draft-card" key={draft.id}>
              <div className="draft-media">
                {kind === 'video' ? (
                  <VideoPreview className="draft-video" src={`/api/drafts/${draft.id}/file`} />
                ) : (
                  <img
                    src={`/api/drafts/${draft.id}/file`}
                    alt={draft.filename}
                    loading="lazy"
                    onClick={() => setLightbox({ url: `/api/drafts/${draft.id}/file`, alt: draft.filename })}
                  />
                )}
                <button className="draft-delete" onClick={() => void remove(draft.id)} title={t('drafts.delete')} aria-label={t('drafts.delete')}>×</button>
              </div>
              <div className="draft-meta">
                <span className="draft-kind">{kind === 'video' ? t('common.kindVideo') : t('common.kindImage')}</span>
                <span className="draft-date">{formatDate(draft.createdAt)}</span>
              </div>
              <div className="draft-name" title={draft.filename}>{draft.filename}</div>
            </article>
            );
          })}
        </div>
      )}

      {lightbox && <ImageLightbox image={lightbox} onClose={() => setLightbox(null)} />}
    </section>
  );
}
