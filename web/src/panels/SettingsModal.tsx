import { useEffect, useState } from 'react';
import { client } from '../api/client';
import type { AppSettings } from '../types';
import { ROLE_PROMPT_KEYS } from '../views/roles';

// 全局设置弹窗：ComfyUI 地址 + agent 默认模型 + 思考强度 + 提示词库。
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

export function SettingsModal(props: {
  open: boolean;
  // 初始值（来自 App 已拉取的 settings）；保存成功后回调最新值
  settings: AppSettings;
  models: Array<{ id: string; provider: string; thinking: boolean }>;
  onClose: () => void;
  onSaved: (s: AppSettings) => void;
  onError: (msg: string) => void;
}) {
  const [comfyUrl, setComfyUrl] = useState(props.settings.comfyUrl);
  const [agentModel, setAgentModel] = useState(props.settings.agentModel);
  const [agentThinking, setAgentThinking] = useState(props.settings.agentThinking);
  // 提示词库工作副本（有序条目数组；保存时组装 map）
  const [promptEntries, setPromptEntries] = useState<Array<{ key: string; value: string }>>([]);
  const [saving, setSaving] = useState(false);

  // 打开时同步外部 settings（切换项目/外部变更后重新打开取最新）；
  // prompts 键缺失（undefined）= 从未自定义 → 预填 5 角色默认条目
  useEffect(() => {
    if (props.open) {
      setComfyUrl(props.settings.comfyUrl);
      setAgentModel(props.settings.agentModel);
      setAgentThinking(props.settings.agentThinking);
      setPromptEntries(props.settings.prompts === undefined
        ? Object.entries(ROLE_PROMPT_KEYS).map(([key, value]) => ({ key, value }))
        : Object.entries(props.settings.prompts).map(([key, value]) => ({ key, value })));
    }
  }, [props.open, props.settings]);

  if (!props.open) return null;

  const updateEntry = (i: number, patch: Partial<{ key: string; value: string }>) => {
    setPromptEntries((prev) => prev.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  };
  const removeEntry = (i: number) => {
    setPromptEntries((prev) => prev.filter((_, j) => j !== i));
  };
  const addEntry = () => {
    setPromptEntries((prev) => [...prev, { key: `新提示词 ${prev.length + 1}`, value: '' }]);
  };
  // 重置默认：5 角色条目（含默认内容）合并进工作副本，自定义条目保留
  const resetDefaults = () => {
    setPromptEntries((prev) => {
      const next = [...prev];
      for (const [key, value] of Object.entries(ROLE_PROMPT_KEYS)) {
        const i = next.findIndex((e) => e.key === key);
        if (i >= 0) next[i] = { key, value };
        else next.push({ key, value });
      }
      return next;
    });
  };

  const save = () => {
    setSaving(true);
    // 组装 prompts map：空名称行丢弃（无法按名引用）；空内容保留（消费点回退默认）
    const prompts: Record<string, string> = {};
    for (const e of promptEntries) {
      const key = e.key.trim();
      if (key) prompts[key] = e.value;
    }
    void client.saveSettings({
      comfyUrl: comfyUrl.trim(),
      agentModel,
      agentThinking,
      prompts,
    }).then((s) => {
      props.onSaved(s);
      props.onClose();
    }).catch((err) => {
      props.onError(err instanceof Error ? err.message : '保存设置失败');
    }).finally(() => setSaving(false));
  };

  return (
    <div className="dialog-mask" onClick={props.onClose}>
      <div className="dialog dialog-wide" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">⚙ 设置</div>
        <div className="dialog-body settings-body">
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
          {/* 提示词库：角色系统提示词 CRUD（AI 功能按名称引用，缺省回退内置默认） */}
          <div className="settings-section" data-testid="prompt-lib">
            <div className="settings-section-head">
              <span className="role-field-label">提示词库 · 角色系统提示词</span>
              <button type="button" className="btn-ghost" onClick={resetDefaults}>↺ 重置为默认提示词</button>
            </div>
            <span className="role-field-hint">AI 建议 / 物体优化 / 对话总结回填按名称引用；删除或留空该条目即回退内置默认；改名角色条目将不再被 AI 功能按名引用</span>
            <div className="prompt-lib">
              {promptEntries.map((e, i) => (
                <div key={i} className="prompt-entry">
                  <input
                    className="ne-input prompt-entry-name" data-testid={`prompt-name-${i}`}
                    value={e.key}
                    onChange={(ev) => updateEntry(i, { key: ev.target.value })}
                  />
                  <textarea
                    className="ne-input prompt-entry-text" data-testid={`prompt-text-${i}`}
                    rows={3} value={e.value}
                    onChange={(ev) => updateEntry(i, { value: ev.target.value })}
                  />
                  <button
                    type="button" className="btn-ghost prompt-entry-del" data-testid={`prompt-del-${i}`}
                    onClick={() => removeEntry(i)}
                  >🗑 删除</button>
                </div>
              ))}
            </div>
            <button type="button" className="btn-ghost" data-testid="prompt-add" onClick={addEntry}>＋ 新增提示词</button>
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
