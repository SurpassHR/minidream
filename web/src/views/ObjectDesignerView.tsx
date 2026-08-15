import { useCallback, useEffect, useRef, useState } from 'react';
import { client } from '../api/client';
import type { DesignKind, DesignObject } from '../types';
import { agentChat } from '../api/agent';
import { OBJECT_DESIGNER_SYSTEM } from './roles';

const KIND_LABEL: Record<DesignKind, string> = {
  character: '人物', scene: '场景', prop: '物品',
};
const KIND_ICON: Record<DesignKind, string> = { character: '👤', scene: '🏞', prop: '🎒' };
const STYLE_PRESETS = ['吉卜力风', '写实', '赛博朋克', '水墨', '皮克斯 3D', '暗黑奇幻'];

export function ObjectDesignerView(props: { projectName: string }) {
  const [designs, setDesigns] = useState<DesignObject[]>([]);
  const [activeKind, setActiveKind] = useState<DesignKind>('character');
  const [selected, setSelected] = useState<DesignObject | null>(null);
  const [workflows, setWorkflows] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(() => {
    void client.listDesigns().then((list) => {
      setDesigns(list);
      setSelected((sel) => {
        if (!sel) return null;
        return list.find((d) => d.id === sel.id) ?? null;
      });
      setLoaded(true);
    }).catch(() => { setLoaded(true); setError('加载设计列表失败'); });
  }, []);

  useEffect(() => {
    refresh();
    void client.listWorkflows().then(setWorkflows).catch(() => setWorkflows([]));
  }, [props.projectName, refresh]);

  const create = () => {
    if (!newName.trim()) return;
    void client.createDesign({ kind: activeKind, name: newName.trim() }).then((d) => {
      setDesigns((prev) => [...prev, d]);
      setSelected(d);
      setNewName('');
      setCreating(false);
    }).catch((err) => setError(err instanceof Error ? err.message : '创建失败'));
  };

  // 防抖保存表单字段：乐观更新本地状态，500ms 后 PUT
  const persist = (patch: Partial<Pick<DesignObject, 'name' | 'description' | 'style' | 'template'>>) => {
    if (!selected) return;
    const id = selected.id;
    setSelected((s) => (s ? { ...s, ...patch } : s));
    setDesigns((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void client.updateDesign(id, patch).catch(() => setError('保存失败，请重试'));
    }, 500);
  };

  const remove = () => {
    if (!selected) return;
    if (!window.confirm(`删除设计对象「${selected.name}」？`)) return;
    const id = selected.id;
    void client.deleteDesign(id).then(() => {
      setDesigns((prev) => prev.filter((d) => d.id !== id));
      setSelected(null);
    }).catch((err) => setError(err instanceof Error ? err.message : '删除失败'));
  };

  const aiOptimize = () => {
    if (!selected) return;
    setAiBusy(true);
    const prompt = `${OBJECT_DESIGNER_SYSTEM}\n\n对象名称：${selected.name}\n风格：${selected.style || '（未指定）'}\n现有描述：${selected.description || '（暂无）'}`;
    void agentChat(prompt, [], (chunk) => {
      // 流式追加到描述框：用函数式 setState 避免 selected 闭包过期
      setSelected((s) => (s ? { ...s, description: s.description + chunk } : s));
      setDesigns((prev) => prev.map((d) => (d.id === selected.id ? { ...d, description: d.description + chunk } : d)));
    }).catch(() => setError('AI 优化失败，请重试')).finally(() => setAiBusy(false));
  };

  const generate = () => {
    if (!selected) return;
    setError('');
    setSelected((s) => (s ? { ...s, status: 'generating' } : s));
    void client.generateDesign(selected.id).then((d) => {
      setDesigns((prev) => prev.map((x) => (x.id === d.id ? d : x)));
      setSelected(d);
    }).catch((err) => {
      setSelected((s) => (s ? { ...s, status: 'failed', error: err instanceof Error ? err.message : '生成失败' } : s));
      setError(err instanceof Error ? err.message : '生成失败');
    });
  };

  if (!loaded) return <div className="role-view" data-testid="object-designer-view"><div className="story-center">加载中…</div></div>;

  const kinds: DesignKind[] = ['character', 'scene', 'prop'];

  return (
    <div className="role-view designer-view" data-testid="object-designer-view">
      <div className="designer-head">
        <div className="story-title">物体设计器 · {designs.length} 个设计 · {designs.filter((d) => d.status === 'done').length} 张参考图</div>
      </div>
      <div className="designer-body">
        <div className="designer-list">
          {kinds.map((k) => {
            const items = designs.filter((d) => d.kind === k);
            return (
              <div key={k} className="designer-group">
                <div className={`designer-kind${activeKind === k ? ' active' : ''}`} onClick={() => setActiveKind(k)}>
                  {KIND_ICON[k]} <span>{KIND_LABEL[k]}</span> ({items.length})
                </div>
                <div className="designer-items">
                  {items.map((d) => (
                    <div
                      key={d.id}
                      className={`designer-item${selected?.id === d.id ? ' active' : ''}`}
                      onClick={() => setSelected(d)}
                    >
                      <span>{d.status === 'done' ? '✅' : d.status === 'failed' ? '❌' : d.status === 'generating' ? '⏳' : '·'}</span>
                      <span className="designer-item-name">{d.name}</span>
                      {d.assetId && <span className="designer-thumb-mini" style={{ backgroundImage: `url(/api/assets/${d.assetId}/file)` }} />}
                    </div>
                  ))}
                  {items.length === 0 && <div className="designer-empty">暂无设计</div>}
                </div>
              </div>
            );
          })}
          <button className="btn-ghost designer-add" onClick={() => setCreating(true)}>＋ 新建</button>
        </div>
        <div className="designer-form">
          {selected ? (
            <>
              <div className="designer-form-head">
                <span>{KIND_ICON[selected.kind]} {KIND_LABEL[selected.kind]}</span>
                <span className={`designer-status st-${selected.status}`}>
                  {selected.status === 'draft' ? '草稿' : selected.status === 'generating' ? '生成中…' : selected.status === 'done' ? '已生成' : '失败'}
                </span>
              </div>
              <label className="designer-label">名称
                <input className="ne-input" data-testid="design-name" value={selected.name}
                  onChange={(e) => persist({ name: e.target.value })} />
              </label>
              <label className="designer-label">风格
                <input className="ne-input" list="style-presets" value={selected.style}
                  placeholder="自由输入或选择常用风格"
                  onChange={(e) => persist({ style: e.target.value })} />
                <datalist id="style-presets">
                  {STYLE_PRESETS.map((s) => <option key={s} value={s} />)}
                </datalist>
              </label>
              <label className="designer-label">视觉描述
                <textarea className="ne-input" data-testid="design-desc" rows={5} value={selected.description}
                  placeholder="描述外观、材质、光影…"
                  onChange={(e) => persist({ description: e.target.value })} />
              </label>
              <label className="designer-label">文生图模板
                <select className="ne-input" value={selected.template}
                  onChange={(e) => persist({ template: e.target.value })}>
                  <option value="">（选择模板…）</option>
                  {workflows.map((w) => <option key={w} value={w}>{w}</option>)}
                </select>
                {workflows.length === 0 && <div className="designer-tip">workflows/ 目录暂无模板，请放入 *.template.json（需含 $&#123;prompt&#125; 变量）</div>}
              </label>
              <div className="designer-actions">
                <button className="btn-ghost" disabled={aiBusy} onClick={aiOptimize}>✨ AI 优化描述</button>
                <button className="btn-primary" disabled={selected.status === 'generating' || !selected.template} onClick={generate}>⚙ 生成参考图</button>
              </div>
              {selected.status === 'failed' && selected.error && (
                <div className="story-error">生成失败：{selected.error}</div>
              )}
              {selected.status === 'done' && selected.assetId && (
                <div className="designer-preview">
                  <img src={`/api/assets/${selected.assetId}/file`} alt="参考图" data-testid="design-preview-img" />
                </div>
              )}
              <button className="btn-ghost designer-del" onClick={remove}>删除对象</button>
            </>
          ) : (
            <div className="designer-empty">← 选择或新建一个对象开始设计</div>
          )}
        </div>
      </div>
      {error && <div className="story-error designer-error">{error}</div>}
      {creating && (
        <div className="dialog-mask" onClick={() => setCreating(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-title">新建{KIND_LABEL[activeKind]}</div>
            <div className="dialog-body">
              <input className="ne-input" placeholder="对象名称" value={newName}
                autoFocus onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') create(); }} />
            </div>
            <div className="dialog-actions">
              <button className="btn-ghost" onClick={() => setCreating(false)}>取消</button>
              <button className="btn-primary" onClick={create} disabled={!newName.trim()}>创建</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
