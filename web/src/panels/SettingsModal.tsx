import { useEffect, useState } from 'react';
import { client } from '../api/client';
import type { AppSettings } from '../types';

// 全局设置弹窗：ComfyUI 地址 + agent 默认模型 + 思考强度。
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
  const [saving, setSaving] = useState(false);

  // 打开时同步外部 settings（切换项目/外部变更后重新打开取最新）
  useEffect(() => {
    if (props.open) {
      setComfyUrl(props.settings.comfyUrl);
      setAgentModel(props.settings.agentModel);
      setAgentThinking(props.settings.agentThinking);
    }
  }, [props.open, props.settings]);

  if (!props.open) return null;

  const save = () => {
    setSaving(true);
    void client.saveSettings({
      comfyUrl: comfyUrl.trim(),
      agentModel,
      agentThinking,
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
        </div>
        <div className="dialog-actions">
          <button className="btn-ghost" onClick={props.onClose}>取消</button>
          <button className="btn-primary" onClick={save} disabled={saving}>保存</button>
        </div>
      </div>
    </div>
  );
}
