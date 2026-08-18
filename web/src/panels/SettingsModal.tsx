import { useEffect, useState } from 'react';
import { client } from '../api/client';
import type { AppSettings } from '../types';
import { ROLE_PROMPT_KEYS, type RolePromptKey } from '../views/roles';

// 角色提示词中文标签（UI 展示用；键固定唯一对应角色，名称不可编辑）
// 提示词库已按项目下沉：storyTeller / storySummarize 移到「剧本项目」内（项目级系统提示词），
// 全局仅保留 objectDesigner（物体设计尚未下沉时的过渡）
const ROLE_PROMPT_LABELS: Record<RolePromptKey, string> = {
  storyTeller: '故事向导 · 对话式',
  objectDesigner: '物体设计 · AI 优化',
  storySummarize: '总结成稿指令',
};

// 全局提示词库保留的角色键：storyTeller / storySummarize 已下沉到剧本项目
const GLOBAL_PROMPT_KEYS: RolePromptKey[] = ['objectDesigner'];

// 全局设置弹窗：左侧标题导航 + 右侧配置项（master-detail）。
// 分组：服务连接（ComfyUI / Ollama）、AI 对话（模型与思考）、内容（提示词库）。
// 持久化到后端 ~/.director/settings.json（用户级，跨项目）；模型/思考强度是「默认值」，
// AgentPanel 内的临时切换不回写这里。
const THINKING_LEVELS = [
  { value: '', label: '思考：默认' },
  { value: 'off', label: '思考：关闭' },
  { value: 'minimal', label: '思考：最低' },
  { value: 'low', label: '思考：低' },
  { value: 'medium', label: '思考：中' },
  { value: 'high', label: '思考：高' },
  { value: 'xhigh', label: '思考：极高' },
  { value: 'max', label: '思考：最大' },
];

// 左侧导航定义：分组 + 条目（id 对应右侧 section，点击切换）
type SectionId = 'comfy' | 'ollama' | 'model' | 'prompts';
const NAV_GROUPS: Array<{ title: string; items: Array<{ id: SectionId; icon: string; label: string; desc: string }> }> = [
  {
    title: '服务连接',
    items: [
      { id: 'comfy', icon: '🖥', label: 'ComfyUI 生成', desc: '文生图 / 视频服务' },
      { id: 'ollama', icon: '🧠', label: 'Ollama 视觉模型', desc: '图像转提示词' },
    ],
  },
  {
    title: 'AI 对话',
    items: [
      { id: 'model', icon: '🤖', label: '模型与思考', desc: '默认模型 / 思考强度' },
    ],
  },
  {
    title: '内容',
    items: [
      { id: 'prompts', icon: '📚', label: '提示词库', desc: '角色系统提示词' },
    ],
  },
];

export function SettingsModal(props: {
  open: boolean;
  // 初始值（来自 App 已拉取的 settings）；保存成功后回调最新值
  settings: AppSettings;
  models: Array<{ id: string; provider: string; thinking: boolean }>;
  onClose: () => void;
  onSaved: (s: AppSettings) => void;
  onError: (msg: string) => void;
}) {
  const [activeSec, setActiveSec] = useState<SectionId>('comfy');
  const [comfyUrl, setComfyUrl] = useState(props.settings.comfyUrl);
  const [agentModel, setAgentModel] = useState(props.settings.agentModel);
  const [agentThinking, setAgentThinking] = useState(props.settings.agentThinking);
  // 提示词库工作副本：固定 3 个角色条目（键唯一对应角色，名称不可编辑）；
  // 内容 = 存储值 ?? 内置默认；空内容 = 消费点回退默认
  const [promptEntries, setPromptEntries] = useState<Array<{ key: RolePromptKey; value: string }>>([]);
  const [armorBreak, setArmorBreak] = useState(props.settings.armorBreak ?? '');
  const [armorBreakEnabled, setArmorBreakEnabled] = useState(props.settings.armorBreakEnabled ?? false);
  // Ollama 本地视觉模型（图像转提示词）：地址 + 视觉模型名；模型列表用于下拉（datalist）
  const [ollamaUrl, setOllamaUrl] = useState(props.settings.ollamaUrl ?? '');
  const [ollamaModel, setOllamaModel] = useState(props.settings.ollamaModel ?? '');
  // Ollama embedding 模型（项目 RAG 向量检索用）
  const [ollamaEmbedModel, setOllamaEmbedModel] = useState(props.settings.ollamaEmbedModel ?? '');
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  // 打开时同步外部 settings（切换项目/外部变更后重新打开取最新）；
  // 始终显示 3 角色条目：值 = 存储的 prompts 对应键 ?? 内置默认
  useEffect(() => {
    if (props.open) {
      setActiveSec('comfy');
      setComfyUrl(props.settings.comfyUrl);
      setAgentModel(props.settings.agentModel);
      setAgentThinking(props.settings.agentThinking);
      setPromptEntries(
        GLOBAL_PROMPT_KEYS.map((key) => ({
          key,
          value: props.settings.prompts?.[key] ?? ROLE_PROMPT_KEYS[key],
        })),
      );
      setArmorBreak(props.settings.armorBreak ?? '');
      setArmorBreakEnabled(props.settings.armorBreakEnabled ?? false);
      setOllamaUrl(props.settings.ollamaUrl ?? '');
      setOllamaModel(props.settings.ollamaModel ?? '');
      setOllamaEmbedModel(props.settings.ollamaEmbedModel ?? '');
      // 打开时拉取已安装模型（datalist 数据源）；失败静默（输入框仍可手填）
      setOllamaModels([]);
      void client.listOllamaModels().then(setOllamaModels).catch(() => setOllamaModels([]));
    }
  }, [props.open, props.settings]);

  if (!props.open) return null;

  const updateEntry = (i: number, value: string) => {
    setPromptEntries((prev) => prev.map((e, j) => (j === i ? { ...e, value } : e)));
  };
  // 单个角色条目恢复默认（清空自定义内容；保存后该键值为默认/空 → 消费回退内置默认）
  const resetOne = (key: RolePromptKey) => {
    setPromptEntries((prev) => prev.map((e) => (e.key === key ? { ...e, value: ROLE_PROMPT_KEYS[key] } : e)));
  };
  // 重置全部角色条目为内置默认
  const resetDefaults = () => {
    setPromptEntries(GLOBAL_PROMPT_KEYS.map((key) => ({ key, value: ROLE_PROMPT_KEYS[key] })));
  };

  const save = () => {
    setSaving(true);
    // 组装 prompts map：全局仅保留 objectDesigner 键（storyTeller/storySummarize 已在项目级）；
    // 空内容保留（消费点回退默认）
    const prompts: Record<string, string> = {};
    for (const e of promptEntries) {
      prompts[e.key] = e.value;
    }
    void client.saveSettings({
      comfyUrl: comfyUrl.trim(),
      agentModel,
      agentThinking,
      prompts,
      armorBreak,
      armorBreakEnabled,
      ollamaUrl: ollamaUrl.trim(),
      ollamaModel: ollamaModel.trim(),
      ollamaEmbedModel: ollamaEmbedModel.trim(),
    }).then((s) => {
      props.onSaved(s);
      props.onClose();
    }).catch((err) => {
      props.onError(err instanceof Error ? err.message : '保存设置失败');
    }).finally(() => setSaving(false));
  };

  return (
    <div className="dialog-mask" onClick={props.onClose}>
      <div className="dialog dialog-wide dialog-settings" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">⚙ 设置</div>
        <div className="settings-layout">
          {/* 左侧标题导航：分组列表，点击切换右侧配置项 */}
          <aside className="settings-nav" data-testid="settings-nav">
            {NAV_GROUPS.map((g) => (
              <div key={g.title} className="settings-nav-group">
                <div className="settings-nav-title">{g.title}</div>
                {g.items.map((it) => (
                  <button
                    key={it.id}
                    type="button"
                    className={`settings-nav-item${activeSec === it.id ? ' active' : ''}`}
                    data-testid={`nav-${it.id}`}
                    onClick={() => setActiveSec(it.id)}
                  >
                    <span className="sni-ico">{it.icon}</span>
                    <span className="sni-text">
                      <span className="sni-label">{it.label}</span>
                      <span className="sni-desc">{it.desc}</span>
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </aside>
          {/* 右侧配置项：一次只显示激活 section */}
          <div className="settings-content">
            {/* —— ComfyUI 生成服务 —— */}
            <section className={`settings-sec${activeSec === 'comfy' ? ' active' : ''}`} data-testid="sec-comfy">
              <div className="settings-sec-head">
                <div className="sec-eyebrow">Service · 01</div>
                <div className="sec-title">ComfyUI 生成服务</div>
                <div className="sec-desc">画布生成流水线依赖的 ComfyUI 实例。地址保存后立即生效并写入当前项目节点。</div>
              </div>
              <label className="role-field">
                <span className="role-field-label">COMFYUI 地址</span>
                <input
                  className="ne-input"
                  placeholder="http://127.0.0.1:8188"
                  value={comfyUrl}
                  onChange={(e) => setComfyUrl(e.target.value)}
                />
                <span className="role-field-hint">本机或远程 GPU 地址；保存后立即生效并写入当前项目节点</span>
              </label>
            </section>

            {/* —— Ollama 本地视觉模型 —— */}
            <section className={`settings-sec${activeSec === 'ollama' ? ' active' : ''}`} data-testid="sec-ollama">
              <div className="settings-sec-head">
                <div className="sec-eyebrow">Local Vision · 02</div>
                <div className="sec-title">Ollama 视觉模型</div>
                <div className="sec-desc">用本地视觉模型把参考图转成外观描述（物体设计器「🪄 图像转描述」）。</div>
              </div>
              <label className="role-field">
                <span className="role-field-label">OLLAMA 地址</span>
                <input
                  className="ne-input" data-testid="ollama-url"
                  placeholder="http://127.0.0.1:11434"
                  value={ollamaUrl}
                  onChange={(e) => setOllamaUrl(e.target.value)}
                />
                <span className="role-field-hint">本地 Ollama 服务地址；未配置时物体设计器的图像转描述不可用</span>
              </label>
              <label className="role-field">
                <span className="role-field-label">视觉模型</span>
                <input
                  className="ne-input" data-testid="ollama-model"
                  list="ollama-models" placeholder="llava / qwen2.5vl…"
                  value={ollamaModel}
                  onChange={(e) => setOllamaModel(e.target.value)}
                />
                <datalist id="ollama-models">
                  {ollamaModels.map((m) => <option key={m} value={m} />)}
                </datalist>
                <span className="role-field-hint">支持图像的本地视觉模型（可从已安装模型下拉选择，或手动填写）</span>
              </label>
              <label className="role-field">
                <span className="role-field-label">Embedding 模型（RAG 知识库检索）</span>
                <input
                  className="ne-input" data-testid="ollama-embed-model"
                  list="ollama-models" placeholder="nomic-embed-text / bge-m3…"
                  value={ollamaEmbedModel}
                  onChange={(e) => setOllamaEmbedModel(e.target.value)}
                />
                <span className="role-field-hint">剧本项目的 RAG 向量检索用；未配置时知识库检索自动降级（对话不受影响）</span>
              </label>
            </section>

            {/* —— 模型与思考 —— */}
            <section className={`settings-sec${activeSec === 'model' ? ' active' : ''}`} data-testid="sec-model">
              <div className="settings-sec-head">
                <div className="sec-eyebrow">Agent · 03</div>
                <div className="sec-title">模型与推理</div>
                <div className="sec-desc">AGENT 面板与对话式的默认模型与推理深度；面板内可临时切换，不回写这里。</div>
              </div>
              <label className="role-field">
                <span className="role-field-label">默认模型</span>
                <select
                  className="ne-input"
                  value={agentModel}
                  onChange={(e) => setAgentModel(e.target.value)}
                >
                  <option value="">默认模型（pi 配置）</option>
                  {props.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.provider}/{m.id.split('/').slice(1).join('/')}{m.thinking ? ' · 思考' : ''}
                    </option>
                  ))}
                </select>
                <span className="role-field-hint">AGENT 面板与对话式的默认模型（面板内可临时切换）</span>
              </label>
              <label className="role-field">
                <span className="role-field-label">思考强度</span>
                <select
                  className="ne-input"
                  value={agentThinking}
                  onChange={(e) => setAgentThinking(e.target.value)}
                >
                  {THINKING_LEVELS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                <span className="role-field-hint">pi --thinking：控制模型推理深度（越高思考越充分，响应越慢）</span>
              </label>
            </section>

            {/* —— 提示词库 —— */}
            <section className={`settings-sec${activeSec === 'prompts' ? ' active' : ''}`} data-testid="sec-prompts">
              <div className="settings-sec-head">
                <div className="sec-eyebrow">Prompts · 04</div>
                <div className="sec-title">提示词库 · 全局角色提示词</div>
                <div className="sec-desc">storyTeller / storySummarize 已下沉到「剧本项目」的项目级系统提示词（每个项目完全自定义）；此处仅保留全局 objectDesigner。留空即回退内置默认</div>
              </div>
              <div className="armor-break">
                <label className="armor-break-head">
                  <input
                    type="checkbox" data-testid="armor-break-enabled"
                    checked={armorBreakEnabled}
                    onChange={(e) => setArmorBreakEnabled(e.target.checked)}
                  />
                  <span className="role-field-label">⚔ 破甲预设 · 开启后插入到所有系统提示词之前</span>
                </label>
                <textarea
                  className="ne-input armor-break-text" data-testid="armor-break-text"
                  rows={3} value={armorBreak} placeholder="在此填写破甲预设文本…"
                  onChange={(e) => setArmorBreak(e.target.value)}
                />
              </div>
              <div className="settings-section" data-testid="prompt-lib">
                <div className="settings-section-head">
                  <span className="role-field-label">角色系统提示词</span>
                  <button type="button" className="btn-ghost" onClick={resetDefaults}>↺ 重置为默认提示词</button>
                </div>
                <div className="prompt-lib">
                  {promptEntries.map((e, i) => (
                    <div key={e.key} className="prompt-entry">
                      <div className="prompt-entry-head">
                        {/* 名称固定只读：键唯一对应角色，不可编辑（改名会破坏消费引用） */}
                        <span className="prompt-entry-name" data-testid={`prompt-name-${i}`}>
                          {ROLE_PROMPT_LABELS[e.key] ?? e.key}
                          <span className="prompt-entry-key">{e.key}</span>
                        </span>
                        <button
                          type="button" className="btn-ghost prompt-entry-reset" data-testid={`prompt-reset-${i}`}
                          title="恢复为内置默认内容" onClick={() => resetOne(e.key)}
                        >↺ 默认</button>
                      </div>
                      <textarea
                        className="ne-input prompt-entry-text" data-testid={`prompt-text-${i}`}
                        rows={3} value={e.value}
                        onChange={(ev) => updateEntry(i, ev.target.value)}
                      />
                    </div>
                  ))}
                </div>
              </div>
            </section>
          </div>
        </div>
        <div className="dialog-actions">
          <button className="btn-ghost" onClick={props.onClose}>取消</button>
          <button className="btn-primary" onClick={save} disabled={saving}>保存</button>
        </div>
      </div>
    </div>
  );
}
