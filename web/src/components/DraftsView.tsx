import { useEffect, useState } from 'react';
import { deleteDraft, fetchDrafts, type DraftRecord } from '../api';
import ImageLightbox, { type LightboxImage } from './ImageLightbox';

function formatDate(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value);
}

export default function DraftsView() {
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
          <span className="drafts-kicker">本地创作缓存</span>
          <h1>草稿</h1>
          <p>生成完成的图片和视频会先保存在这里，方便继续整理。</p>
        </div>
        <button className="drafts-refresh" onClick={refresh} title="刷新草稿" aria-label="刷新草稿">↻</button>
      </header>

      {loading ? (
        <div className="drafts-empty">正在读取草稿…</div>
      ) : drafts.length === 0 ? (
        <div className="drafts-empty">
          <div className="drafts-empty-icon">□</div>
          <h2>还没有草稿</h2>
          <p>生成图片或视频后，产物会自动保存到这里。</p>
        </div>
      ) : (
        <div className="drafts-grid">
          {drafts.map(draft => (
            <article className="draft-card" key={draft.id}>
              <div className="draft-media">
                {draft.kind === 'video' ? (
                  <video src={`/api/drafts/${draft.id}/file`} controls preload="metadata" />
                ) : (
                  <img
                    src={`/api/drafts/${draft.id}/file`}
                    alt={draft.filename}
                    loading="lazy"
                    onClick={() => setLightbox({ url: `/api/drafts/${draft.id}/file`, alt: draft.filename })}
                  />
                )}
                <button className="draft-delete" onClick={() => void remove(draft.id)} title="删除草稿" aria-label="删除草稿">×</button>
              </div>
              <div className="draft-meta">
                <span className="draft-kind">{draft.kind === 'video' ? '视频' : '图片'}</span>
                <span className="draft-date">{formatDate(draft.createdAt)}</span>
              </div>
              <div className="draft-name" title={draft.filename}>{draft.filename}</div>
            </article>
          ))}
        </div>
      )}

      {lightbox && <ImageLightbox image={lightbox} onClose={() => setLightbox(null)} />}
    </section>
  );
}
