import { useEffect, useRef, useState } from 'react';
import {
  fetchAppSettings,
  saveComfySettings,
  saveImageGenSettings,
  saveStorageSettings,
  type ComfyStatus,
  type ImageGenSettings,
} from '../api';

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
  {
    id: 'imageGen',
    label: '生图默认参数',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <circle cx="9" cy="9" r="7.5" stroke="currentColor" strokeWidth="1.3" />
        <path d="M9 5v4l2.5 2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    id: 'storage',
    label: '产物存储',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <path d="M2.5 5.5A1.5 1.5 0 0 1 4 4h3l1.5 1.5H14A1.5 1.5 0 0 1 15.5 7v6A1.5 1.5 0 0 1 14 14.5H4A1.5 1.5 0 0 1 2.5 13v-7.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M5.5 9.5h7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    ),
  },
];

const SAMPLER_OPTIONS = [
  'euler',
  'euler_ancestral',
  'heun',
  'dpm_2',
  'dpm_2_ancestral',
  'lms',
  'dpm_fast',
  'dpm_adaptive',
  'dpmpp_2s_ancestral',
  'dpmpp_sde',
  'dpmpp_sde_gpu',
  'dpmpp_2m',
  'dpmpp_2m_sde',
  'dpmpp_2m_sde_gpu',
  'dpmpp_3m_sde',
  'dpmpp_3m_sde_gpu',
  'ddpm',
  'lcm',
  'ddim',
  'uni_pc',
  'uni_pc_bh2',
];

const SCHEDULER_OPTIONS = [
  'normal',
  'karras',
  'exponential',
  'sgm_uniform',
  'simple',
  'ddim_uniform',
  'beta',
  'turbo',
];

const RESOLUTION_PRESETS = [
  { label: '1024 × 1024 (1:1 正方)', width: 1024, height: 1024 },
  { label: '832 × 1216 (2:3 竖版)', width: 832, height: 1216 },
  { label: '1216 × 832 (3:2 横版)', width: 1216, height: 832 },
  { label: '768 × 1344 (9:16 手机竖屏)', width: 768, height: 1344 },
  { label: '1344 × 768 (16:9 宽屏)', width: 1344, height: 768 },
  { label: '512 × 512 (小正方)', width: 512, height: 512 },
];

const DEFAULT_IMAGE_GEN: ImageGenSettings = {
  seedMode: 'random',
  seed: -1,
  steps: 20,
  cfg: 7.0,
  sampler_name: 'euler',
  scheduler: 'normal',
  denoise: 1.0,
  width: 1024,
  height: 1024,
};

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

  // 生图参数状态
  const [imageGen, setImageGen] = useState<ImageGenSettings>(DEFAULT_IMAGE_GEN);
  const [savingImageGen, setSavingImageGen] = useState(false);
  const [imageGenTip, setImageGenTip] = useState<string | null>(null);
  const [imageGenError, setImageGenError] = useState<string | null>(null);
  const [outputDir, setOutputDir] = useState('');
  const [savingStorage, setSavingStorage] = useState(false);
  const [storageTip, setStorageTip] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusRef = useRef<ComfyStatus | null>(comfyStatus);
  statusRef.current = comfyStatus;

  // 打开时同步设置
  useEffect(() => {
    if (!open) return;
    setError(null);
    setTip(null);
    setImageGenTip(null);
    setImageGenError(null);
    setStorageTip(null);
    setStorageError(null);
    setReconnecting(false);
    setAttempt(0);

    fetchAppSettings()
      .then(s => {
        if (s.comfyui?.baseUrl) {
          setBaseUrl(s.comfyui.baseUrl);
        } else if (comfyStatus?.baseUrl) {
          setBaseUrl(comfyStatus.baseUrl);
        }
        if (s.imageGen) {
          setImageGen({ ...DEFAULT_IMAGE_GEN, ...s.imageGen });
        }
        if (s.storage?.outputDir) {
          setOutputDir(s.storage.outputDir);
        }
      })
      .catch(() => {
        if (comfyStatus?.baseUrl) {
          setBaseUrl(comfyStatus.baseUrl);
        }
      });
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

  const saveComfy = async () => {
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

  const saveStorage = async () => {
    const value = outputDir.trim();
    if (!value.startsWith('/')) {
      setStorageError('产物存储目录必须是绝对路径');
      return;
    }
    setSavingStorage(true);
    setStorageTip(null);
    setStorageError(null);
    try {
      const res = await saveStorageSettings(value);
      setOutputDir(res.storage.outputDir);
      setStorageTip('产物存储目录已保存并生效');
    } catch (e) {
      setStorageError((e as Error).message);
    } finally {
      setSavingStorage(false);
    }
  };

  const saveImageGen = async () => {
    setSavingImageGen(true);
    setImageGenTip(null);
    setImageGenError(null);
    try {
      const res = await saveImageGenSettings(imageGen);
      if (res.ok) {
        setImageGen(res.imageGen);
        setImageGenTip('生图参数已保存并生效');
      } else {
        setImageGenError('保存失败');
      }
    } catch (e) {
      setImageGenError((e as Error).message);
    } finally {
      setSavingImageGen(false);
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
                  <button className="settings-btn primary" onClick={saveComfy} disabled={saving || reconnecting}>
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

            {active === 'storage' && (
              <section className="settings-section">
                <h3 className="settings-section-title">生成产物存储</h3>
                <p className="settings-section-desc">
                  生成完成后，项目会把 ComfyUI 的临时产物转存到这里，并使用本地文件作为草稿和聊天结果。
                </p>
                <label className="settings-field">
                  <span className="settings-label">本地存储目录（绝对路径）</span>
                  <input
                    className="settings-input"
                    value={outputDir}
                    onChange={e => setOutputDir(e.target.value)}
                    placeholder="/path/to/director-workbench/server/data/drafts"
                    spellCheck={false}
                  />
                </label>
                <div className="storage-path-hint">目录不存在时会自动创建；需要当前服务进程具备读写权限。</div>
                {storageError && <div className="settings-error">{storageError}</div>}
                {storageTip && <div className="settings-tip">{storageTip}</div>}
                <div className="settings-actions">
                  <button className="settings-btn primary" onClick={saveStorage} disabled={savingStorage}>
                    {savingStorage ? '检查并保存中…' : '保存存储目录'}
                  </button>
                </div>
              </section>
            )}

            {active === 'imageGen' && (
              <section className="settings-section">
                <h3 className="settings-section-title">生图默认参数 (Krea2)</h3>
                <p className="settings-section-desc">
                  配置执行生图工作流时的默认参数与采样器选项，无需在每次提问时重复配置。
                </p>

                <div className="settings-grid">
                  <label className="settings-field">
                    <span className="settings-label">采样算法 (Sampler)</span>
                    <select
                      className="settings-select"
                      value={imageGen.sampler_name}
                      onChange={e => setImageGen(prev => ({ ...prev, sampler_name: e.target.value }))}
                    >
                      {SAMPLER_OPTIONS.map(opt => (
                        <option key={opt} value={opt}>
                          {opt}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="settings-field">
                    <span className="settings-label">调度器 (Scheduler)</span>
                    <select
                      className="settings-select"
                      value={imageGen.scheduler}
                      onChange={e => setImageGen(prev => ({ ...prev, scheduler: e.target.value }))}
                    >
                      {SCHEDULER_OPTIONS.map(opt => (
                        <option key={opt} value={opt}>
                          {opt}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="settings-field">
                    <span className="settings-label">采样步数 (Steps: {imageGen.steps})</span>
                    <input
                      type="range"
                      min={1}
                      max={100}
                      step={1}
                      className="settings-range"
                      value={imageGen.steps}
                      onChange={e => setImageGen(prev => ({ ...prev, steps: Number(e.target.value) }))}
                    />
                  </label>

                  <label className="settings-field">
                    <span className="settings-label">提示词引导系数 (CFG: {imageGen.cfg})</span>
                    <input
                      type="range"
                      min={1}
                      max={20}
                      step={0.5}
                      className="settings-range"
                      value={imageGen.cfg}
                      onChange={e => setImageGen(prev => ({ ...prev, cfg: Number(e.target.value) }))}
                    />
                  </label>

                  <label className="settings-field">
                    <span className="settings-label">重绘幅度 / Denoise: {imageGen.denoise}</span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      className="settings-range"
                      value={imageGen.denoise}
                      onChange={e => setImageGen(prev => ({ ...prev, denoise: Number(e.target.value) }))}
                    />
                  </label>

                  <label className="settings-field">
                    <span className="settings-label">分辨率预设</span>
                    <select
                      className="settings-select"
                      value={`${imageGen.width}x${imageGen.height}`}
                      onChange={e => {
                        const [w, h] = e.target.value.split('x').map(Number);
                        if (w && h) setImageGen(prev => ({ ...prev, width: w, height: h }));
                      }}
                    >
                      {RESOLUTION_PRESETS.map(p => (
                        <option key={`${p.width}x${p.height}`} value={`${p.width}x${p.height}`}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="settings-row" style={{ marginTop: '12px' }}>
                  <label className="settings-field" style={{ flex: 1 }}>
                    <span className="settings-label">宽度 (Width)</span>
                    <input
                      type="number"
                      className="settings-input"
                      value={imageGen.width}
                      step={64}
                      min={256}
                      max={4096}
                      onChange={e => setImageGen(prev => ({ ...prev, width: Number(e.target.value) }))}
                    />
                  </label>
                  <label className="settings-field" style={{ flex: 1 }}>
                    <span className="settings-label">高度 (Height)</span>
                    <input
                      type="number"
                      className="settings-input"
                      value={imageGen.height}
                      step={64}
                      min={256}
                      max={4096}
                      onChange={e => setImageGen(prev => ({ ...prev, height: Number(e.target.value) }))}
                    />
                  </label>
                </div>

                <div className="settings-field" style={{ marginTop: '12px' }}>
                  <span className="settings-label">随机种子 (Seed)</span>
                  <div className="settings-seed-row">
                    <label className="settings-radio">
                      <input
                        type="radio"
                        name="seedMode"
                        checked={imageGen.seedMode === 'random'}
                        onChange={() => setImageGen(prev => ({ ...prev, seedMode: 'random', seed: -1 }))}
                      />
                      <span>每次随机</span>
                    </label>
                    <label className="settings-radio">
                      <input
                        type="radio"
                        name="seedMode"
                        checked={imageGen.seedMode === 'fixed'}
                        onChange={() => setImageGen(prev => ({ ...prev, seedMode: 'fixed', seed: prev.seed === -1 ? 12345678 : prev.seed }))}
                      />
                      <span>固定种子</span>
                    </label>
                    {imageGen.seedMode === 'fixed' && (
                      <input
                        type="number"
                        className="settings-input settings-seed-input"
                        placeholder="种子数值"
                        value={imageGen.seed >= 0 ? imageGen.seed : ''}
                        onChange={e => setImageGen(prev => ({ ...prev, seed: Number(e.target.value) }))}
                      />
                    )}
                  </div>
                </div>

                {imageGenError && <div className="settings-error">{imageGenError}</div>}
                {imageGenTip && <div className="settings-tip">{imageGenTip}</div>}

                <div className="settings-actions">
                  <button className="settings-btn primary" onClick={saveImageGen} disabled={savingImageGen}>
                    {savingImageGen ? '保存中…' : '保存生图参数'}
                  </button>
                  <button
                    className="settings-btn"
                    onClick={() => setImageGen(DEFAULT_IMAGE_GEN)}
                    disabled={savingImageGen}
                  >
                    恢复默认值
                  </button>
                </div>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
