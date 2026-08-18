import { useState } from 'react';
import { client } from '../api/client';
import { Icon } from '../icons';

export interface EditorNode {
  id: string;
  title: string;
  fields: Record<string, unknown>;
}

export function NodeEditor({ node, onClose }: { node: EditorNode; onClose: () => void }) {
  const [title, setTitle] = useState(node.title);
  const [fieldsText, setFieldsText] = useState(JSON.stringify(node.fields, null, 2));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    let fields: Record<string, unknown>;
    try {
      fields = JSON.parse(fieldsText) as Record<string, unknown>;
    } catch {
      setError('JSON 解析失败：请检查字段内容格式');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await client.patchNode(node.id, { title, fields });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <div className="node-editor">
      <div className="ne-head">
        <span>编辑节点</span>
        <button className="btn-ghost" onClick={onClose}><Icon name="x" /></button>
      </div>
      <label className="ne-label">标题
        <input className="ne-input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="ne-label">字段（JSON）
        <textarea
          className="ne-textarea" aria-label="fields" value={fieldsText}
          onChange={(e) => setFieldsText(e.target.value)} rows={10}
        />
      </label>
      {error && <div className="ne-error">{error}</div>}
      <div className="ne-actions">
        <button className="btn-ghost" onClick={onClose}>取消</button>
        <button className="btn-primary" onClick={save} disabled={saving}>{saving ? '保存中…' : '保存'}</button>
      </div>
    </div>
  );
}
