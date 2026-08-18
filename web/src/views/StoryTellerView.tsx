import { useCallback, useEffect, useMemo, useState } from 'react';
import { client } from '../api/client';
import { Icon } from '../icons';
import type { RagHit, StoryBoard, StoryProgress } from '../types';
import { ErrorBanner, LoadingState, RoleHeader } from './role-ui';
import { StoryChat } from './StoryChat';
import { ScriptViewer } from './ScriptViewer';
import { ROLE_PROMPT_KEYS } from './roles';

// story-teller 仅对话式：自由聊天 + 总结成稿入库（向导式已移除）。
// v3：剧本项目（Story Board）= 项目级系统提示词（storyTeller/storySummarize）+ RAG 知识库；
// 每项目一套完全自定义上下文，替代全局提示词库的 storyTeller/storySummarize（设置弹窗已瘦身）。
// story 状态只需 completedAt（完成横幅/剧本栏）；answers 由总结成稿写入后端。

// 剧本项目加载失败/空库时的兜底板（后端正常会自动落「未命名项目」，此处仅防御）
const VIRTUAL_BOARD: StoryBoard = {
  id: 'default', name: '未命名项目', createdAt: 0, updatedAt: 0,
  systemPrompts: {}, ragEnabled: false, ragAssets: [],
};

const PROMPT_META: Array<{ key: 'storyTeller' | 'storySummarize'; label: string; desc: string }> = [
  { key: 'storyTeller', label: 'storyTeller', desc: '故事向导 · 对话系统提示词' },
  { key: 'storySummarize', label: 'storySummarize', desc: '总结成稿 · 六步答案格式' },
];

export function StoryTellerView(props: { projectName: string; prompts?: Record<string, string>; armorBreak?: string; armorBreakEnabled?: boolean; agentModel?: string; thinkingLevel?: string }) {
  const [story, setStory] = useState<StoryProgress>({ step: 0, answers: {}, completedAt: null });
  const [md, setMd] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  // 剧本项目：列表 + 当前激活（加载失败 → 空列表 + 虚拟默认板兜底）
  const [boards, setBoards] = useState<StoryBoard[]>([]);
  const [activeBoardId, setActiveBoardId] = useState<string | null>(null);
  // 中栏 tab（对话 / 系统提示词 / 知识库 RAG）
  const [midTab, setMidTab] = useState<'chat' | 'prompts' | 'rag'>('chat');
  // 右栏 tab（生效上下文 / 剧本）
  const [rightTab, setRightTab] = useState<'ctx' | 'script'>('script');

  const activeBoard = useMemo<StoryBoard>(
    () => boards.find((b) => b.id === activeBoardId) ?? VIRTUAL_BOARD,
    [boards, activeBoardId],
  );

  // 项目切换/挂载时加载进度（completedAt + md）
  useEffect(() => {
    let disposed = false;
    setLoaded(false);
    setError('');
    void client.getStory().then(({ story: s, md: m }) => {
      if (disposed) return;
      setStory(s);
      setMd(m ?? null);
      setLoaded(true);
    }).catch(() => {
      if (!disposed) {
        // GET 失败：清空剧本栏（切项目后不得残留上一项目已完成的 md）
        setMd(null);
        setError('加载故事进度失败');
        setLoaded(true);
      }
    });
    return () => { disposed = true; };
  }, [props.projectName]);

  // 剧本项目加载：切换项目 = 整套提示词 + RAG + 会话列表
  useEffect(() => {
    let disposed = false;
    setBoards([]);
    setActiveBoardId(null);
    setMidTab('chat');
    void client.listStoryBoards().then((bs) => {
      if (disposed) return;
      // 防御：响应非数组（旧测试 mock 命中 /api/story 分支）按空列表处理 → VIRTUAL_BOARD 兜底
      if (!Array.isArray(bs)) { setBoards([]); setActiveBoardId(null); return; }
      setBoards(bs);
      setActiveBoardId(bs[0]?.id ?? null);
    }).catch(() => {
      // 失败：空列表 → VIRTUAL_BOARD 兜底（对话仍可用，走全局/内置提示词）
      if (!disposed) { setBoards([]); setActiveBoardId(null); }
    });
    return () => { disposed = true; };
  }, [props.projectName]);

  // 对话式总结成稿：解析答案 → 写入 story.json → complete 入库 → 刷新完成状态
  const handleSummarized = (answers: Record<string, string>) => {
    void client.saveStory({ answers })
      .then(() => client.completeStory())
      .then((r) => {
        setStory(r.story);
        setMd(r.md);
        setError('');
      })
      .catch((err) => setError(err instanceof Error ? err.message : '总结入库失败'));
  };

  // 重新生成：清空进度与完成标记，回到未完成态（确认门防误触）
  const reset = () => {
    if (!window.confirm('重新生成将清空当前故事进度，确定？')) return;
    void client.resetStory().then((s) => {
      setStory(s);
      setMd(null);
      setError('');
    }).catch((err) => setError(err instanceof Error ? err.message : '重置失败'));
  };

  // —— 剧本项目操作 ——
  const selectBoard = (id: string) => {
    setActiveBoardId(id);
    setError('');
  };
  const createBoard = () => {
    const name = window.prompt('新剧本项目名称', '未命名项目');
    if (name === null) return;
    void client.createStoryBoard(name.trim() || '未命名项目').then((bs) => {
      if (!Array.isArray(bs)) return;
      setBoards(bs);
      const created = bs.find((b) => b.name === (name.trim() || '未命名项目'));
      setActiveBoardId(created?.id ?? bs[0]?.id ?? null);
    }).catch((err) => setError(err instanceof Error ? err.message : '创建剧本项目失败'));
  };
  const removeBoard = (id: string) => {
    const b = boards.find((x) => x.id === id);
    if (!window.confirm(`删除剧本项目「${b?.name ?? ''}」？其项目级提示词与 RAG 配置将一并删除（会话消息保留）。`)) return;
    void client.deleteStoryBoard(id).then((bs) => {
      if (!Array.isArray(bs)) return;
      setBoards(bs);
      if (activeBoardId === id) setActiveBoardId(bs[0]?.id ?? null);
    }).catch((err) => setError(err instanceof Error ? err.message : '删除剧本项目失败'));
  };
  // 保存项目级系统提示词（整体替换传入键；空 = 清空回退内置默认）
  const saveBoardPrompt = useCallback((key: 'storyTeller' | 'storySummarize', value: string) => {
    if (!activeBoardId || activeBoardId === VIRTUAL_BOARD.id) return;
    void client.saveBoardPrompts(activeBoardId, {
      ...activeBoard.systemPrompts,
      [key]: value.trim(),
    }).then((b) => {
      setBoards((prev) => prev.map((x) => (x.id === b.id ? b : x)));
    }).catch((err) => setError(err instanceof Error ? err.message : '保存项目提示词失败'));
  }, [activeBoardId, activeBoard.systemPrompts]);

  const toggleRag = (enabled: boolean) => {
    if (!activeBoardId || activeBoardId === VIRTUAL_BOARD.id) return;
    void client.setBoardRagEnabled(activeBoardId, enabled).then((b) => {
      setBoards((prev) => prev.map((x) => (x.id === b.id ? b : x)));
    }).catch((err) => setError(err instanceof Error ? err.message : '切换 RAG 失败'));
  };
  const addRagAsset = (assetId: string) => {
    if (!activeBoardId || activeBoardId === VIRTUAL_BOARD.id) return;
    void client.addBoardRagAsset(activeBoardId, assetId).then((b) => {
      setBoards((prev) => prev.map((x) => (x.id === b.id ? b : x)));
    }).catch((err) => setError(err instanceof Error ? err.message : '添加知识库文件失败'));
  };
  const removeRagAsset = (assetId: string) => {
    if (!activeBoardId || activeBoardId === VIRTUAL_BOARD.id) return;
    void client.removeBoardRagAsset(activeBoardId, assetId).then((b) => {
      setBoards((prev) => prev.map((x) => (x.id === b.id ? b : x)));
    }).catch((err) => setError(err instanceof Error ? err.message : '移除知识库文件失败'));
  };

  if (!loaded) {
    return <div className="role-view" data-testid="story-teller-view"><LoadingState /></div>;
  }

  const promptCustomCount = (b: StoryBoard) =>
    (b.systemPrompts.storyTeller ? 1 : 0) + (b.systemPrompts.storySummarize ? 1 : 0);

  return (
    // 仅对话式：chat-mode 布局常驻（高度受限，仅消息区滚动）
    <div className="role-view story-view chat-mode" data-testid="story-teller-view">
      <RoleHeader
        eyebrow="STORY TELLER"
        title="故事向导"
        meta={<span className="story-step-meta">项目级提示词 + RAG · 自由对话</span>}
      />
      <div className="story-layout story-v3">
        {/* 左栏：剧本项目（项目 = 系统提示词 + RAG 容器） */}
        <aside className="board-sidebar" data-testid="board-sidebar">
          <div className="panel-title">剧本项目 <span className="mini">提示词 + RAG</span></div>
          <div className="board-list">
            {boards.map((b) => (
              <div
                key={b.id}
                className={`board-item${b.id === activeBoard.id ? ' active' : ''}`}
                data-testid={`board-item-${b.id}`}
                onClick={() => selectBoard(b.id)}
              >
                <span className="board-name">{b.name}</span>
                <span className="board-badges">
                  {promptCustomCount(b) > 0 && <span className="bb bb-prompt">提示词 {promptCustomCount(b)}</span>}
                  {b.ragEnabled && b.ragAssets.length > 0 && <span className="bb bb-rag">RAG {b.ragAssets.length}</span>}
                </span>
                <span
                  className="board-del" title="删除剧本项目"
                  onClick={(e) => { e.stopPropagation(); removeBoard(b.id); }}
                ><Icon name="trash" /></span>
              </div>
            ))}
            <button className="board-new-btn" data-testid="board-new" onClick={createBoard}>＋ 新建剧本项目</button>
          </div>
          <div className="board-context">
            <div className="board-context-title">当前项目上下文</div>
            <div className="bc-row"><span className={`bc-dot ${promptCustomCount(activeBoard) > 0 ? 'bc-on' : 'bc-off'}`} />提示词 {promptCustomCount(activeBoard) > 0 ? `${promptCustomCount(activeBoard)} 键已自定义` : '回退内置默认'}</div>
            <div className="bc-row"><span className={`bc-dot ${activeBoard.ragEnabled && activeBoard.ragAssets.length > 0 ? 'bc-on' : 'bc-off'}`} />RAG {activeBoard.ragEnabled && activeBoard.ragAssets.length > 0 ? `${activeBoard.ragAssets.length} 文件 · 已启用` : '未配置'}</div>
          </div>
        </aside>

        {/* 中栏：对话 / 系统提示词 / 知识库 RAG */}
        <div className="story-main mid-col">
          <div className="mid-tabs" data-testid="story-mid-tabs">
            <button className={`mid-tab${midTab === 'chat' ? ' on' : ''}`} onClick={() => setMidTab('chat')}><Icon name="chat" />对话</button>
            <button className={`mid-tab${midTab === 'prompts' ? ' on' : ''}`} onClick={() => setMidTab('prompts')}>
              <Icon name="file-text" />系统提示词{promptCustomCount(activeBoard) > 0 && <span className="tab-dot" />}
            </button>
            <button className={`mid-tab${midTab === 'rag' ? ' on' : ''}`} onClick={() => setMidTab('rag')}>
              <Icon name="book" />知识库 RAG{activeBoard.ragEnabled && activeBoard.ragAssets.length > 0 && <span className="tab-dot" />}
            </button>
          </div>
          <div className="mid-body">
            {midTab === 'chat' && (
              <>
                {story.completedAt && (
                  <div className="story-banner">
                    <Icon name="check-circle" />已完成 · 已生成故事文档进素材库（{new Date(story.completedAt).toLocaleString()}）
                    <button className="btn-ghost story-reset" onClick={reset}>重新生成</button>
                  </div>
                )}
                <StoryChat
                  projectName={props.projectName}
                  onSummarized={handleSummarized}
                  prompts={props.prompts}
                  armorBreak={props.armorBreak}
                  armorBreakEnabled={props.armorBreakEnabled}
                  agentModel={props.agentModel}
                  thinkingLevel={props.thinkingLevel}
                  board={activeBoard}
                />
                {error && <ErrorBanner text={error} />}
              </>
            )}
            {midTab === 'prompts' && (
              <PromptEditor
                board={activeBoard}
                globalPrompts={props.prompts}
                onSave={saveBoardPrompt}
              />
            )}
            {midTab === 'rag' && (
              <RagPanel
                board={activeBoard}
                onToggle={toggleRag}
                onAdd={addRagAsset}
                onRemove={removeRagAsset}
              />
            )}
          </div>
        </div>

        {/* 右栏：生效上下文 / 剧本栏 */}
        <aside className="script-sidebar" data-testid="script-sidebar">
          <div className="ctx-tabs">
            <button className={`ctx-tab${rightTab === 'ctx' ? ' on' : ''}`} onClick={() => setRightTab('ctx')}><Icon name="brain" />上下文</button>
            <button className={`ctx-tab${rightTab === 'script' ? ' on' : ''}`} onClick={() => setRightTab('script')}><Icon name="scroll" />剧本</button>
          </div>
          {rightTab === 'ctx' ? (
            <ContextPanel board={activeBoard} globalPrompts={props.prompts} />
          ) : (
            <>
              <div className="panel-title">剧本 <span className="mini">story_{props.projectName || '未命名项目'}.md</span></div>
              {md ? (
                <ScriptViewer text={md} />
              ) : (
                <div className="script-empty">
                  对话结束点击「总结成稿」后，
                  剧本将在这里展示
                </div>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

// —— 系统提示词编辑器：项目级两键（storyTeller / storySummarize），board → 全局 → 内置 ——
function PromptEditor(props: {
  board: StoryBoard;
  globalPrompts?: Record<string, string>;
  onSave: (key: 'storyTeller' | 'storySummarize', value: string) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savedKey, setSavedKey] = useState<string | null>(null);
  // 打开时同步当前 board 值（切换项目重置草稿）
  useEffect(() => {
    setDrafts({});
    setSavedKey(null);
  }, [props.board.id]);

  const valueOf = (key: 'storyTeller' | 'storySummarize') =>
    drafts[key] !== undefined ? drafts[key]! : (props.board.systemPrompts[key] ?? props.globalPrompts?.[key] ?? ROLE_PROMPT_KEYS[key]);

  const save = (key: 'storyTeller' | 'storySummarize') => {
    props.onSave(key, drafts[key] ?? props.board.systemPrompts[key] ?? '');
    setSavedKey(key);
    setTimeout(() => setSavedKey(null), 1600);
  };

  return (
    <>
      <div className="pe-intro">项目级系统提示词 · 每个剧本项目完全自定义，未配置的键回退内置默认。替代原全局设置「提示词库」的 storyTeller / storySummarize。</div>
      <div className="pe-list">
        {PROMPT_META.map(({ key, label, desc }) => {
          const custom = !!props.board.systemPrompts[key];
          return (
            <div key={key} className={`pe-card${custom ? ' custom' : ''}`}>
              <div className="pe-head">
                <span className="pe-key">{label}</span>
                <span className="pe-desc">{desc}</span>
                <span className={`pe-state ${custom ? 'custom' : 'default'}`}>{custom ? '已自定义' : '内置默认'}</span>
              </div>
              <div className="pe-body">
                <textarea
                  data-testid={`pe-text-${key}`}
                  value={valueOf(key)}
                  onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
                />
                <div className="pe-acts">
                  <button className="btn-primary" style={{ fontSize: 12, padding: '5px 12px' }} onClick={() => save(key)}>保存</button>
                  <button className="btn-ghost" style={{ fontSize: 11 }} onClick={() => { props.onSave(key, ''); setDrafts((d) => ({ ...d, [key]: '' })); }}>
                    恢复内置默认
                  </button>
                  <span className={`pe-saved${savedKey === key ? ' show' : ''}`}><Icon name="check" />已保存</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

// —— 知识库 RAG：开关 + 文件管理 + 检索预览 ——
function RagPanel(props: {
  board: StoryBoard;
  onToggle: (enabled: boolean) => void;
  onAdd: (assetId: string) => void;
  onRemove: (assetId: string) => void;
}) {
  const [assets, setAssets] = useState<Array<{ id: string; name: string }> | null>(null);
  const [showPick, setShowPick] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<{ hits: RagHit[]; status: string; error?: string } | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    void client.listAssets().then((list) => setAssets(list.map((a) => ({ id: a.id, name: a.name })))).catch(() => setAssets([]));
  }, [props.board.id]);

  const candidates = (assets ?? []).filter((a) => !props.board.ragAssets.includes(a.id));

  const search = () => {
    if (!query.trim() || props.board.id === VIRTUAL_BOARD.id) return;
    setSearching(true);
    void client.ragSearch(props.board.id, query.trim(), 3)
      .then((r) => setHits(r))
      .catch((err) => setHits({ hits: [], status: 'error', error: err instanceof Error ? err.message : '检索失败' }))
      .finally(() => setSearching(false));
  };

  return (
    <>
      <div className="rag-top">
        <div className="rag-toggle">
          <span
            className={`rag-switch${props.board.ragEnabled ? ' on' : ''}`}
            data-testid="rag-toggle"
            onClick={() => props.onToggle(!props.board.ragEnabled)}
          />
          RAG 检索增强
        </div>
        <span className="rag-hint">启用后：提问 → 检索命中片段 → 注入系统提示词 → 生成</span>
      </div>
      <div className="rag-files">
        {props.board.ragAssets.length === 0 && (
          <div className="ctx-empty">尚未添加知识库文件 —— 添加 txt 素材后即可向量检索</div>
        )}
        {props.board.ragAssets.map((id) => {
          const name = (assets ?? []).find((a) => a.id === id)?.name ?? id;
          return (
            <div key={id} className="rag-file">
              <span><Icon name="file" /></span>
              <span className="nm">{name}</span>
              <span className="x" data-testid={`rag-remove-${id}`} onClick={() => props.onRemove(id)}><Icon name="x" /></span>
            </div>
          );
        })}
        {!showPick && (
          <button className="rag-add" data-testid="rag-add" onClick={() => setShowPick(true)}>
            ＋ 添加知识库文件（引用素材库 txt）
          </button>
        )}
        {showPick && (
          <div className="rag-pick">
            {candidates.length === 0 && <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>素材库没有可添加的 txt 文件（或已全部加入）</span>}
            {candidates.map((a) => (
              <button key={a.id} className="rag-pick-item" data-testid={`rag-pick-${a.id}`}
                onClick={() => { props.onAdd(a.id); setShowPick(false); }}
              >＋ {a.name}</button>
            ))}
            <button className="rag-pick-item" onClick={() => setShowPick(false)}>取消</button>
          </div>
        )}
      </div>
      <div className="rag-search">
        <input
          placeholder="试检索：输入问题查看命中片段…（需已配置 Ollama embedding 模型）"
          value={query}
          data-testid="rag-query"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') search(); }}
        />
        <button className="btn-ghost" data-testid="rag-search" onClick={search} disabled={searching}>
          {searching ? '检索中…' : '检索'}
        </button>
      </div>
      {hits && (
        <div className="rag-hit" data-testid="rag-hit">
          {hits.status === 'ok' && hits.hits.length > 0 && (
            <>
              <span className="qh">命中 {hits.hits.length} 片段</span><br />
              {hits.hits.map((h, i) => <div key={i}><b>[{h.name}]</b> {h.text.slice(0, 120)}…</div>)}
            </>
          )}
          {hits.status === 'ok' && hits.hits.length === 0 && <span>无命中（相似度低于阈值）</span>}
          {hits.status === 'unconfigured' && <span>未配置 Ollama embedding 模型 —— 到「设置 → Ollama」填写 Embedding 模型即可启用检索；未配置时对话自动降级（不注入）</span>}
          {hits.status === 'error' && <span>检索失败：{hits.error}</span>}
        </div>
      )}
    </>
  );
}

// —— 生效上下文：当前项目提示词 + RAG 状态 ——
function ContextPanel(props: { board: StoryBoard; globalPrompts?: Record<string, string> }) {
  const { board } = props;
  const prompts = props.globalPrompts;
  return (
    <div className="ctx-pane">
      <div className="ctx-sec">剧本项目 · {board.name}</div>
      {PROMPT_META.map(({ key, label }) => {
        const custom = !!board.systemPrompts[key];
        const value = board.systemPrompts[key] ?? prompts?.[key] ?? ROLE_PROMPT_KEYS[key];
        return (
          <div key={key} className="ctx-card">
            <span className="k">{label} · {custom ? '已自定义' : '内置默认'}</span>
            <span className="v">{value.slice(0, 140)}{value.length > 140 ? '…' : ''}</span>
          </div>
        );
      })}
      <div className="ctx-sec">RAG 知识库</div>
      <div className="ctx-card">
        <span className="k">{board.ragEnabled && board.ragAssets.length > 0 ? `${board.ragAssets.length} 文件 · 已启用` : '未配置'}</span>
        {board.ragEnabled && board.ragAssets.length > 0
          ? <span className="v">提问时检索命中片段并注入回答，标注引用来源。</span>
          : <span className="v">未启用 —— 添加知识库文件并打开开关后，对话将自动检索注入。</span>}
      </div>
      <div className="ctx-sec">全局设置</div>
      <div className="ctx-empty">提示词库已按项目下沉：storyTeller / storySummarize 在本项目内自定义<br />全局仅保留 objectDesigner</div>
    </div>
  );
}
