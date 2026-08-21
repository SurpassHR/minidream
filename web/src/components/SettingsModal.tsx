import { useEffect, useRef, useState } from 'react';
import { fetchComfySettings, saveComfySettings, type ComfyStatus } from '../api';

interface Category {
  id: string;
  label: string;
  icon: React.ReactNode;
}

const MAX_ATTEMPTS = 12;
const RETRY_INTERVAL = 2000;

const CATEGORIES: Category[] = [
  {
    id: 'comfyui',
    label: 'ComfyUI 服务',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <rect x="1.5" y="1.5" width="6.5" height="6.5" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
        <rect x="10" y="1.5" width="6.5" height="6.5" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
        <rect x="1.5" y="10" width="6.5" height="6.5" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
        <rect x="10" y="10" width="6.5" height="6.5" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      </svg>
    ),
  },
];

export default function SettingsModal({
  open,
  onClose,
  comfyStatus,
  onRefreshStatus,
  onRefreshWorkflows,
}: {
  open: boolean;
  onClose: () => void;
  comfyStatus: ComfyStatus | null;
  onRefreshStatus: () => void;
  onRefreshWorkflows?: () => void;
}) {
  const [active, setActive] = useState(CATEGORIES[0]!.id);
  const [baseUrl, setBaseUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [tip, setTip] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusRef = useRef<ComfyStatus | null>(comfyStatus);
  statusRef.current = comfyStatus;

  // 打开时同步当前地址
  useEffect(() => {
    if (!open) return;
    setError(null);
    setTip(null);
    setReconnecting(false);
    setAttempt(0);
    if (comfyStatus?.baseUrl) {
      setBaseUrl(comfyStatus.baseUrl);
    } else {
      fetchComfySettings()
        .then(s => setBaseUrl(s.baseUrl))
        .catch(() => undefined);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Esc 关闭；卸载时清理重连定时器
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [open, onClose]);

  const stopReconnect = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setReconnecting(false);
    setTip(null);
  };

  /** 保存后若未连上，自动周期性重试直到成功或达到上限 */
  const startAutoReconnect = () => {
    setReconnecting(true);
    setAttempt(0);
    let n = 0;
    const run = () => {
      onRefreshStatus();
      timerRef.current = setTimeout(() => {
        if (statusRef.current?.connected) {
          setReconnecting(false);
          setTip('已连接');
          onRefreshWorkflows?.();
          return;
        }
        n += 1;
        setAttempt(n);
        if (n >= MAX_ATTEMPTS) {
          setReconnecting(false);
          setTip('自动重连未成功，请检查地址后重试');
          return;
        }
        run();
      }, RETRY_INTERVAL);
    };
    run();
  };

  const save = async () => {
    const url = baseUrl.trim();
    if (!/^https?:\/\//i.test(url)) {
      setError('地址需以 http:// 或 https:// 开头');
      return;
    }
    setSaving(true);
    setError(null);
    setTip(null);
    stopReconnect();
    try {
      const res = await saveComfySettings(url);
      if (!res.ok) {
        setError(res.error ?? '保存失败');
        setSaving(false);
        return;
      }
      setBaseUrl(res.baseUrl);
      setSaving(false);
      if (res.connected) {
        setTip('已连接');
        onRefreshStatus();
        onRefreshWorkflows?.();
      } else {
        setTip('地址已保存，正在自动重连…');
        startAutoReconnect();
      }
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  if (!open) return null;

  const connected = comfyStatus?.connected;
  const statusText = connected
    ? `已连接（${comfyStatus?.baseUrl ?? baseUrl}）${comfyStatus?.system?.comfyui_version ? `· v${comfyStatus.system.comfyui_version}` : ''}`
    : `未连接${comfyStatus?.error ? `：${comfyStatus.error}` : ''}`;

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal" role="dialog" aria-modal="true" aria-label="设置" onClick={e => e.stopPropagation()}>
        <header className="settings-header">
          <h2 className="settings-title">设置</h2>
          <button className="settings-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>
        <div className="settings-body">
          <nav className="settings-cats" aria-label="设置分类">
            {CATEGORIES.map(c => (
              <button
                key={c.id}
                className={`settings-cat${active === c.id ? ' active' : ''}`}
                onClick={() => setActive(c.id)}
              >
                {c.icon}
                <span>{c.label}</span>
              </button>
            ))}
          </nav>
          <div className="settings-pane">
            {active === 'comfyui' && (
              <section className="settings-section">
                <h3 className="settings-section-title">ComfyUI 连接</h3>
                <p className="settings-section-desc">
                  生成任务与素材上传都由服务端代理到这个地址。保存新地址后会自动尝试重连。
                </p>
                <label className="settings-field">
                  <span className="settings-label">ComfyUI 地址</span>
                  <input
                    className="settings-input"
                    value={baseUrl}
                    onChange={e => setBaseUrl(e.target.value)}
                    placeholder="http://127.0.0.1:8188"
                    spellCheck={false}
                  />
                </label>
                <div className="settings-status">
                  <span className={`settings-dot ${connected ? 'ok' : 'bad'}`} />
                  <span>{statusText}</span>
                  {reconnecting && <span className="settings-retry">正在自动重连（{attempt}/{MAX_ATTEMPTS}）…</span>}
                </div>
                {error && <div className="settings-error">{error}</div>}
                {tip && <div className="settings-tip">{tip}</div>}
                <div className="settings-actions">
                  <button className="settings-btn primary" onClick={save} disabled={saving || reconnecting}>
                    {saving ? '保存中…' : reconnecting ? '重连中…' : '保存并重连'}
                  </button>
                  {reconnecting && (
                    <button className="settings-btn" onClick={stopReconnect}>
                      停止重试
                    </button>
                  )}
                </div>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
