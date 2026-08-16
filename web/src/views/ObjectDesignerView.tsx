import { useCallback, useEffect, useRef, useState } from 'react';
import { client } from '../api/client';
import type { DesignKind, DesignObject } from '../types';
import { agentChat } from '../api/agent';
import { OBJECT_DESIGNER_SYSTEM } from './roles';
import { AiButton, EmptyState, ErrorBanner, Field, LoadingState, RoleCard, RoleHeader, StatusBadge } from './role-ui';

const KIND_LABEL: Record<DesignKind, string> = {
  character: '人物', scene: '场景', prop: '物品',
};
const KIND_ICON: Record<DesignKind, string> = { character: '👤', scene: '🏞', prop: '🎒' };
const STYLE_PRESETS = ['吉卜力风', '写实', '赛博朋克', '水墨', '皮克斯 3D', '暗黑奇幻'];

// 状态 → 徽章色与文案（统一视觉语言）
const STATUS_TONE: Record<DesignObject['status'], 'dim' | 'warn' | 'ok' | 'err'> = {
  draft: 'dim', generating: 'warn', done: 'ok', failed: 'err',
};
const STATUS_TEXT: Record<DesignObject['status'], string> = {
  draft: '草稿', generating: '生成中…', done: '已生成', failed: '失败',
};
const STATUS_ICON: Record<DesignObject['status'], string> = {
  draft: '·', generating: '⏳', done: '✅', failed: '❌',
};

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
  // 防抖合并累积的字段 patch：500ms 窗口内多次编辑合并为一次 PUT，避免丢中间修改。
  // 按对象隔离 { id, patch }：切换选中对象后旧 pending 作废，绝不串对象（B 不会收到 A 的字段）。
  const pendingRef = useRef<{ id: string; patch: Partial<Pick<DesignObject, 'name' | 'description' | 'style' | 'template'>> } | null>(null);

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
    // 卸载/切项目清理防抖 timer 与 pending，避免在途 PUT 污染新项目状态
    return () => {
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
      pendingRef.current = null;
    };
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

  // 防抖保存表单字段：乐观更新本地状态；窗口内多次编辑合并累积 patch 一次 PUT；
  // 切换对象后只保留当前对象的累积（pendingRef 按 id 隔离，跨对象不合并）
  const persist = (patch: Partial<Pick<DesignObject, 'name' | 'description' | 'style' | 'template'>>) => {
    if (!selected) return;
    const id = selected.id;
    // 同一对象继续累积；不同对象则丢弃旧 pending 以当前对象重建（快速切换时旧对象未落盘修改随之作废）
    pendingRef.current = pendingRef.current && pendingRef.current.id === id
      ? { id, patch: { ...pendingRef.current.patch, ...patch } }
      : { id, patch };
    setSelected((s) => (s && s.id === id ? { ...s, ...patch } : s));
    setDesigns((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending) {
        // 从 pending 取 id 发送（而非 timer 闭包捕获的 id）：修复切换对象后 timer 仍发旧对象的问题
        void client.updateDesign(pending.id, pending.patch).catch(() => setError('保存失败，请重试'));
      }
    }, 500);
  };

  const remove = () => {
    if (!selected) return;
    if (!window.confirm(`删除设计对象「${selected.name}」？`)) return;
    // 清防抖 timer：删除后不再发送针对已删对象的在途 PUT
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    pendingRef.current = null;
    const id = selected.id;
    void client.deleteDesign(id).then(() => {
      setDesigns((prev) => prev.filter((d) => d.id !== id));
      setSelected(null);
    }).catch((err) => setError(err instanceof Error ? err.message : '删除失败'));
  };

  const aiOptimize = () => {
    if (!selected) return;
    const id = selected.id; // 提前捕获：流式回调不依赖可能过期的 selected 闭包
    const baseDesc = selected.description;
    setAiBusy(true);
    const prompt = `${OBJECT_DESIGNER_SYSTEM}\n\n对象名称：${selected.name}\n风格：${selected.style || '（未指定）'}\n现有描述：${selected.description || '（暂无）'}`;
    // 本地累积最终描述（chunk 回调与 finally 共用；UI state 仍走函数式更新）
    let acc = baseDesc;
    void agentChat(prompt, [], (chunk) => {
      acc += chunk;
      // 只追加到发起优化的对象：切换选中后不污染新对象（selected 与 designs 双向守卫）
      setSelected((s) => (s && s.id === id ? { ...s, description: s.description + chunk } : s));
      setDesigns((prev) => prev.map((d) => (d.id === id ? { ...d, description: d.description + chunk } : d)));
    }).catch(() => setError('AI 优化失败，请重试')).finally(() => {
      setAiBusy(false);
      // AI 流式完成后立即落盘最终描述（不等 500ms 防抖）：
      // generate 端点从后端 design.json 读 description，不落盘则参考图基于旧描述生成（所见非所得）
      if (acc !== baseDesc) {
        void client.updateDesign(id, { description: acc }).catch(() => setError('保存失败，请重试'));
      }
    });
  };

  const generate = () => {
    if (!selected) return;
    const id = selected.id;
    setError('');
    // 乐观置位：selected 与 designs 同步更新
    setSelected((s) => (s ? { ...s, status: 'generating' } : s));
    setDesigns((prev) => prev.map((d) => (d.id === id ? { ...d, status: 'generating' } : d)));
    void client.generateDesign(id).then((d) => {
      setDesigns((prev) => prev.map((x) => (x.id === d.id ? d : x)));
      // 生成期间用户若已切走，不强切回选中（仅更新列表）
      setSelected((s) => (s && s.id === d.id ? d : s));
    }).catch((err) => {
      const msg = err instanceof Error ? err.message : '生成失败';
      setDesigns((prev) => prev.map((x) => (x.id === id ? { ...x, status: 'failed', error: msg } : x)));
      setSelected((s) => (s && s.id === id ? { ...s, status: 'failed', error: msg } : s));
      setError(msg);
    });
  };

  if (!loaded) {
    return <div className="role-view" data-testid="object-designer-view"><LoadingState /></div>;
  }

  const kinds: DesignKind[] = ['character', 'scene', 'prop'];
  const doneCount = designs.filter((d) => d.status === 'done').length;

  return (
    <div className="role-view designer-view" data-testid="object-designer-view">
      <RoleHeader
        eyebrow="OBJECT DESIGNER"
        title="物体设计器"
        meta={<span className="designer-meta">{designs.length} 个设计 · {doneCount} 张参考图</span>}
      />
      <div className="designer-body">
        {/* 左列：三类对象分组（人物/场景/物品） */}
        <div className="designer-list">
          {kinds.map((k) => {
            const items = designs.filter((d) => d.kind === k);
            return (
              <div key={k} className="designer-group">
                <div className={`designer-kind${activeKind === k ? ' active' : ''}`} onClick={() => setActiveKind(k)}>
                  <span className="kind-icon">{KIND_ICON[k]}</span>
                  <span>{KIND_LABEL[k]}</span>
                  <span className="kind-count">{items.length}</span>
                </div>
                <div className="designer-items">
                  {items.map((d) => (
                    <div
                      key={d.id}
                      className={`designer-item${selected?.id === d.id ? ' active' : ''}`}
                      onClick={() => setSelected(d)}
                    >
                      <span className="item-status">{STATUS_ICON[d.status]}</span>
                      <span className="designer-item-name">{d.name}</span>
                      {d.assetId && <span className="designer-thumb-mini" style={{ backgroundImage: `url(/api/assets/${d.assetId}/file)` }} />}
                    </div>
                  ))}
                  {items.length === 0 && (
                    <EmptyState
                      icon={KIND_ICON[k]}
                      text={`暂无设计`}
                    />
                  )}
                </div>
              </div>
            );
          })}
          <button className="btn-ghost designer-add" onClick={() => setCreating(true)}>＋ 新建</button>
        </div>
        {/* 右列：选中对象表单 / 定妆照灯箱 */}
        <div className="designer-form">
          {selected ? (
            <>
              <div className="designer-form-head">
                <span className="form-kind">{KIND_ICON[selected.kind]} <span>{KIND_LABEL[selected.kind]}</span></span>
                <StatusBadge tone={STATUS_TONE[selected.status]}>{STATUS_TEXT[selected.status]}</StatusBadge>
              </div>
              <Field label="名称">
                <input className="ne-input" data-testid="design-name" value={selected.name}
                  onChange={(e) => persist({ name: e.target.value })} />
              </Field>
              <Field label="风格" hint="自由输入或选择常用风格">
                <input className="ne-input" list="style-presets" value={selected.style}
                  placeholder="自由输入或选择常用风格"
                  onChange={(e) => persist({ style: e.target.value })} />
                <datalist id="style-presets">
                  {STYLE_PRESETS.map((s) => <option key={s} value={s} />)}
                </datalist>
              </Field>
              <Field label="视觉描述" hint="外观、材质、光影…">
                <textarea className="ne-input" data-testid="design-desc" rows={5} value={selected.description}
                  placeholder="描述外观、材质、光影…"
                  onChange={(e) => persist({ description: e.target.value })} />
              </Field>
              <Field label="文生图模板">
                <select className="ne-input" value={selected.template}
                  onChange={(e) => persist({ template: e.target.value })}>
                  <option value="">（选择模板…）</option>
                  {workflows.map((w) => <option key={w} value={w}>{w}</option>)}
                </select>
                {workflows.length === 0 && <div className="designer-tip">workflows/ 目录暂无模板，请放入 *.template.json（需含 $&#123;prompt&#125; 变量）</div>}
              </Field>
              <div className="designer-actions">
                <AiButton busy={aiBusy} onClick={aiOptimize}>✨ AI 优化描述</AiButton>
                <button className="btn-primary" disabled={selected.status === 'generating' || !selected.template} onClick={generate}>⚙ 生成参考图</button>
              </div>
              {selected.status === 'failed' && selected.error && (
                <ErrorBanner text={`生成失败：${selected.error}`} />
              )}
              {selected.status === 'done' && selected.assetId && (
                <div className="designer-preview">
                  <img src={`/api/assets/${selected.assetId}/file`} alt="参考图" data-testid="design-preview-img" />
                  <div className="preview-meta">
                    <span>{selected.template || '—'}</span>
                    <span>{selected.style || '未指定风格'}</span>
                  </div>
                </div>
              )}
              <button className="btn-ghost designer-del" onClick={remove}>删除对象</button>
            </>
          ) : (
            <EmptyState
              icon="🎬"
              text="选择或新建一个对象开始设计"
              action={<button className="btn-ghost designer-add" onClick={() => setCreating(true)}>＋ 新建对象</button>}
            />
          )}
        </div>
      </div>
      {error && <ErrorBanner text={error} />}
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
