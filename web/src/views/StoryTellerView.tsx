import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { client } from '../api/client';
import { Icon } from '../icons';
import type { RagHit, StoryBoard, StoryProgress } from '../types';
import { ErrorBanner, LoadingState } from './role-ui';
import { StoryChat } from './StoryChat';
import { ScriptViewer } from './ScriptViewer';
import { ConfirmDialog } from '../panels/ConfirmDialog';
import { TextInputDialog } from '../panels/TextInputDialog';
import { ROLE_PROMPT_KEYS } from './roles';

// story-teller 仅对话式：自由聊天 + 提炼分镜提示词入库（向导式已移除）。
// v3：剧本项目（Story Board）= 项目级系统提示词（storyTeller/storySummarize）+ RAG 知识库；
// 每项目一套完全自定义上下文，替代全局提示词库的 storyTeller/storySummarize（设置弹窗已瘦身）。
// story 状态只需 completedAt（完成横幅/剧本栏）；answers 由生成分镜提示词写入后端。

// 剧本项目加载失败/空库时的兜底板（后端正常会自动落默认项目，此处仅防御）
const VIRTUAL_BOARD: StoryBoard = {
  id: 'default', name: 'Minimax-H3 Prompt Writer', createdAt: 0, updatedAt: 0,
  systemPrompts: {}, ragEnabled: false, ragAssets: [],
};

const PROMPT_META: Array<{ key: 'storyTeller' | 'storySummarize'; label: string; desc: string }> = [
  { key: 'storyTeller', label: 'storyTeller', desc: '故事向导 · 对话系统提示词' },
  { key: 'storySummarize', label: 'storySummarize', desc: '分镜提示词 · MiniMax H3 YAML 格式' },
];

export function StoryTellerView(props: {
  projectName: string;
  prompts?: Record<string, string>;
  armorBreak?: string;
  armorBreakEnabled?: boolean;
  agentModel?: string;
  thinkingLevel?: string;
  models?: Array<{ id: string; images: boolean }>;
}) {
  const [story, setStory] = useState<StoryProgress>({ step: 0, answers: {}, completedAt: null });
  const [md, setMd] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  // 剧本项目：列表 + 当前激活（加载失败 → 空列表 + 虚拟默认板兜底）
  const [boards, setBoards] = useState<StoryBoard[]>([]);
  const [activeBoardId, setActiveBoardId] = useState<string | null>(null);

  // 两侧边栏宽度记忆与拖拽调节
  const [leftWidth, setLeftWidth] = useState<number>(() => {
    const saved = localStorage.getItem('dw_story_left_width');
    const n = saved ? Number(saved) : 240;
    return Number.isFinite(n) && n >= 160 && n <= 500 ? n : 240;
  });
  const [rightWidth, setRightWidth] = useState<number>(() => {
    const saved = localStorage.getItem('dw_story_right_width');
    const n = saved ? Number(saved) : 380;
    return Number.isFinite(n) && n >= 220 && n <= 700 ? n : 380;
  });
  const [dragging, setDragging] = useState<'left' | 'right' | null>(null);
  const dragRef = useRef<{ kind: 'left' | 'right'; startX: number; startW: number } | null>(null);

  useEffect(() => {
    localStorage.setItem('dw_story_left_width', String(leftWidth));
  }, [leftWidth]);

  useEffect(() => {
    localStorage.setItem('dw_story_right_width', String(rightWidth));
  }, [rightWidth]);

  useEffect(() => {
    if (!dragging) return;
    const onMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const { kind, startX, startW } = dragRef.current;
      const delta = e.clientX - startX;
      if (kind === 'left') {
        const next = Math.max(160, Math.min(500, startW + delta));
        setLeftWidth(next);
      } else if (kind === 'right') {
        const next = Math.max(220, Math.min(700, startW - delta));
        setRightWidth(next);
      }
    };
    const onMouseUp = () => {
      setDragging(null);
      dragRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [dragging]);

  const onSplitterDown = (kind: 'left' | 'right') => (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { kind, startX: e.clientX, startW: kind === 'left' ? leftWidth : rightWidth };
    setDragging(kind);
  };

  const onSplitterReset = (kind: 'left' | 'right') => () => {
    if (kind === 'left') setLeftWidth(240);
    else if (kind === 'right') setRightWidth(380);
  };
  // 中栏 tab（对话 / 系统提示词 / 知识库 RAG）
  const [midTab, setMidTab] = useState<'chat' | 'prompts' | 'rag'>('chat');
  // 右栏 tab（生效上下文 / 剧本）
  const [rightTab, setRightTab] = useState<'ctx' | 'script'>('script');
  // 项目操作弹窗：统一使用项目风格 modal，禁止浏览器原生 prompt/confirm
  const [boardNameDialog, setBoardNameDialog] = useState<
    { mode: 'create' } | { mode: 'rename'; board: StoryBoard } | null
  >(null);
  const [boardDeleteDialog, setBoardDeleteDialog] = useState<StoryBoard | null>(null);
  const [resetDialog, setResetDialog] = useState(false);
  const [boardDialogBusy, setBoardDialogBusy] = useState(false);
  // StoryChat 保留会话状态，挂载位置由当前项目项提供
  const [sessionHost, setSessionHost] = useState<HTMLDivElement | null>(null);
  const createSessionRef = useRef<(() => void) | null>(null);
  const setSessionHostRef = useCallback((node: HTMLDivElement | null) => {
    setSessionHost(node);
  }, []);
  const registerCreateSession = useCallback((handler: (() => void) | null) => {
    createSessionRef.current = handler;
  }, []);

  const activeBoard = useMemo<StoryBoard>(
    () => boards.find((b) => b.id === activeBoardId) ?? VIRTUAL_BOARD,
    [boards, activeBoardId],
  );

  // 当前激活会话的 prompt versions 列表
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [promptVersions, setPromptVersions] = useState<PromptVersion[]>([]);
  const [activeVersionId, setActiveVersionId] = useState<string | null>(null);

  // 会话切换时，拉取会话绑定的 prompt versions，并联动更新右侧 YAML 提示词展示
  const loadPromptVersions = useCallback(async (sessionId: string | null) => {
    if (!sessionId) {
      setPromptVersions([]);
      setActiveVersionId(null);
      return;
    }
    try {
      const res = await client.listStoryPromptVersions(sessionId);
      const versions = Array.isArray(res?.versions) ? res.versions : [];
      const activeId = res?.activeVersionId ?? (versions.length > 0 ? versions[versions.length - 1]!.id : null);
      setPromptVersions(versions);
      setActiveVersionId(activeId);
      if (versions.length > 0) {
        const activeV = versions.find((x) => x.id === activeId) ?? versions[versions.length - 1]!;
        setMd(activeV.yaml);
      } else {
        // 该会话暂无 prompt 版本：清空右侧 YAML 展示（如果项目有全局故事，可降级为 null 或保持空占位）
        setMd(null);
      }
    } catch {
      setPromptVersions([]);
      setActiveVersionId(null);
    }
  }, []);

  const handleSessionChange = useCallback((sessionId: string | null) => {
    setCurrentSessionId(sessionId);
    void loadPromptVersions(sessionId);
  }, [loadPromptVersions]);

  // 项目切换/挂载时加载进度（completedAt + md）
  useEffect(() => {
    let disposed = false;
    setLoaded(false);
    setError('');
    void client.getStory().then(({ story: s, md: m }) => {
      if (disposed) return;
      setStory(s);
      // 如果此时还没有会话版本数据，可以以项目 md 作为初始展示；否则以会话版本为准
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

  // 对话式生成分镜提示词：重置（若已完成）/保存答案 → complete 入库 → 刷新完成状态，同时为当前会话新增 prompt version
  const handleSummarized = async (answers: Record<string, string>, sessionId?: string | null) => {
    try {
      if (story?.completedAt) {
        await client.resetStory();
      }
      await client.saveStory({ answers });
      const r = await client.completeStory();
      setStory(r.story);
      setMd(r.md);
      setRightTab('script');
      setError('');

      const targetSessionId = sessionId ?? currentSessionId;
      if (targetSessionId && (answers.yaml || r.md)) {
        const yamlContent = answers.yaml?.trim() || r.md || '';
        if (yamlContent) {
          const added = await client.addStoryPromptVersion(targetSessionId, yamlContent).catch(() => null);
          if (added) {
            setCurrentSessionId(targetSessionId);
            const vList = Array.isArray(added.versions) ? added.versions : [];
            setPromptVersions(vList);
            setActiveVersionId(added.activeVersionId ?? null);
            const activeV = vList.find((x) => x.id === added.activeVersionId) ?? added.version;
            if (activeV?.yaml) setMd(activeV.yaml);
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '总结入库失败');
    }
  };

  const selectPromptVersion = async (v: PromptVersion) => {
    if (!currentSessionId) return;
    setActiveVersionId(v.id);
    setMd(v.yaml);
    await client.setActiveStoryPromptVersion(currentSessionId, v.id).catch(() => {});
  };

  const deletePromptVersion = async (v: PromptVersion) => {
    if (!currentSessionId) return;
    const res = await client.deleteStoryPromptVersion(currentSessionId, v.id).catch(() => null);
    if (res) {
      setPromptVersions(res.versions);
      setActiveVersionId(res.activeVersionId);
      const activeV = res.versions.find((x) => x.id === res.activeVersionId);
      if (activeV) {
        setMd(activeV.yaml);
      }
    }
  };

  // 重新生成：清空进度与完成标记，回到未完成态（确认门防误触）
  const reset = () => setResetDialog(true);
  const confirmReset = () => {
    setResetDialog(false);
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
  const createBoard = () => setBoardNameDialog({ mode: 'create' });
  const renameBoard = (board: StoryBoard) => setBoardNameDialog({ mode: 'rename', board });
  const submitBoardName = (value: string) => {
    const dialog = boardNameDialog;
    if (!dialog) return;
    setBoardDialogBusy(true);
    const request = dialog.mode === 'create'
      ? client.createStoryBoard(value)
      : client.renameStoryBoard(dialog.board.id, value);
    void request.then((bs) => {
      if (!Array.isArray(bs)) return;
      setBoards(bs);
      if (dialog.mode === 'create') {
        const created = bs.find((b) => b.name === value);
        setActiveBoardId(created?.id ?? bs[0]?.id ?? null);
      }
      setBoardNameDialog(null);
      setError('');
    }).catch((err) => setError(err instanceof Error ? err.message : `${dialog.mode === 'create' ? '创建' : '重命名'}剧本项目失败`))
      .finally(() => setBoardDialogBusy(false));
  };
  const removeBoard = (id: string) => {
    const b = boards.find((x) => x.id === id);
    if (b) setBoardDeleteDialog(b);
  };
  const confirmRemoveBoard = () => {
    const board = boardDeleteDialog;
    if (!board) return;
    setBoardDeleteDialog(null);
    void client.deleteStoryBoard(board.id).then((bs) => {
      if (!Array.isArray(bs)) return;
      setBoards(bs);
      if (activeBoardId === board.id) setActiveBoardId(bs[0]?.id ?? null);
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
      <div
        className="story-layout story-v3"
        style={{
          gridTemplateColumns: `${leftWidth}px 5px minmax(360px, 1fr) 5px ${rightWidth}px`,
        }}
      >
        {/* 左栏：剧本项目（项目 = 系统提示词 + RAG 容器） */}
        <aside
          className="board-sidebar"
          data-testid="board-sidebar"
          style={{ width: leftWidth }}
        >
          <div className="panel-title">剧本项目 <span className="mini">提示词 + RAG</span></div>
          <div className="board-list">
            {boards.map((b) => (
              <div
                key={b.id}
                className={`board-item${b.id === activeBoard.id ? ' active' : ''}`}
                data-testid={`board-item-${b.id}`}
                onClick={() => selectBoard(b.id)}
              >
                <div className="board-item-head">
                  <span className="board-name">{b.name}</span>
                  <span className="board-badges">
                    {promptCustomCount(b) > 0 && <span className="bb bb-prompt">提示词 {promptCustomCount(b)}</span>}
                    {b.ragEnabled && b.ragAssets.length > 0 && <span className="bb bb-rag">RAG {b.ragAssets.length}</span>}
                  </span>
                  {b.id === activeBoard.id && (
                    <button
                      type="button"
                      className="board-session-new"
                      data-testid={`board-session-new-${b.id}`}
                      aria-label={`在${b.name}下新建会话`}
                      title="新建会话"
                      onClick={(e) => { e.stopPropagation(); createSessionRef.current?.(); }}
                    >＋</button>
                  )}
                  <button
                    type="button"
                    className="board-rename"
                    data-testid={`board-rename-${b.id}`}
                    aria-label={`重命名项目${b.name}`}
                    title="重命名项目"
                    onClick={(e) => { e.stopPropagation(); renameBoard(b); }}
                  ><Icon name="pencil" /></button>
                  <span
                    className="board-del" title="删除剧本项目"
                    onClick={(e) => { e.stopPropagation(); removeBoard(b.id); }}
                  ><Icon name="trash" /></span>
                </div>
                {b.id === activeBoard.id && (
                  <div className="board-session-host" data-testid="board-session-host" ref={setSessionHostRef} />
                )}
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

        {/* 左侧可拖拽分割条 */}
        <div
          className={`splitter splitter-v${dragging === 'left' ? ' active' : ''}`}
          data-testid="story-left-splitter"
          title="拖动调整剧本项目栏宽度，双击恢复默认"
          onMouseDown={onSplitterDown('left')}
          onDoubleClick={onSplitterReset('left')}
        />

        {/* 中栏：对话 / 系统提示词 / 知识库 RAG */}
        <div className="story-main mid-col">
          <div className="mid-tabs" data-testid="story-mid-tabs">
            <button className={`mid-tab${midTab === 'chat' ? ' on' : ''}`} onClick={() => setMidTab('chat')}>对话</button>
            <button className={`mid-tab${midTab === 'prompts' ? ' on' : ''}`} onClick={() => setMidTab('prompts')}>
              系统提示词{promptCustomCount(activeBoard) > 0 && <span className="tab-dot" />}
            </button>
            <button className={`mid-tab${midTab === 'rag' ? ' on' : ''}`} onClick={() => setMidTab('rag')}>
              知识库 RAG{activeBoard.ragEnabled && activeBoard.ragAssets.length > 0 && <span className="tab-dot" />}
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
                  onSessionChange={handleSessionChange}
                  prompts={props.prompts}
                  armorBreak={props.armorBreak}
                  armorBreakEnabled={props.armorBreakEnabled}
                  agentModel={props.agentModel}
                  thinkingLevel={props.thinkingLevel}
                  modelSupportsImages={props.models?.find((m) => m.id === props.agentModel)?.images}
                  board={activeBoard}
                  sessionHost={sessionHost}
                  onCreateSessionReady={registerCreateSession}
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

        {/* 右侧可拖拽分割条 */}
        <div
          className={`splitter splitter-v${dragging === 'right' ? ' active' : ''}`}
          data-testid="story-right-splitter"
          title="拖动调整剧本/上下文栏宽度，双击恢复默认"
          onMouseDown={onSplitterDown('right')}
          onDoubleClick={onSplitterReset('right')}
        />

        {/* 右栏：生效上下文 / 剧本栏 */}
        <aside
          className="script-sidebar"
          data-testid="script-sidebar"
          style={{ width: rightWidth }}
        >

          <div className="ctx-tabs">
            <button className={`ctx-tab${rightTab === 'ctx' ? ' on' : ''}`} onClick={() => setRightTab('ctx')}>上下文</button>
            <button className={`ctx-tab${rightTab === 'script' ? ' on' : ''}`} onClick={() => setRightTab('script')}>提示词 (YAML)</button>
          </div>
          {rightTab === 'ctx' ? (
            <ContextPanel board={activeBoard} globalPrompts={props.prompts} />
          ) : (
            <>
              <div className="panel-title">分镜提示词 <span className="mini">story_{props.projectName || '未命名项目'}.yaml</span></div>
              {Array.isArray(promptVersions) && promptVersions.length > 0 && (
                <div className="prompt-versions-bar" data-testid="prompt-versions-bar" style={{ display: 'flex', gap: '6px', overflowX: 'auto', padding: '6px 0', borderBottom: '1px solid var(--border, #333)', marginBottom: '8px' }}>
                  {promptVersions.map((v) => (
                    <div
                      key={v.id}
                      className={`prompt-version-tag${v.id === activeVersionId ? ' active' : ''}`}
                      data-testid={`prompt-version-${v.version}`}
                      onClick={() => void selectPromptVersion(v)}
                      style={{
                        padding: '2px 8px',
                        borderRadius: '4px',
                        fontSize: '12px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px',
                        background: v.id === activeVersionId ? 'var(--primary, #3b82f6)' : 'var(--bg-tag, #2a2a2a)',
                        color: v.id === activeVersionId ? '#fff' : 'var(--text-muted, #aaa)',
                        border: '1px solid var(--border, #444)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      <span>{v.label}</span>
                      <span
                        data-testid={`delete-version-${v.version}`}
                        title="删除该版本"
                        onClick={(e) => {
                          e.stopPropagation();
                          void deletePromptVersion(v);
                        }}
                        style={{ cursor: 'pointer', opacity: 0.7 }}
                      >
                        ×
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {md ? (
                <ScriptViewer text={md} />
              ) : (
                <div className="script-empty">
                  对话结束点击「生成分镜提示词」后，
                  分镜提示词（YAML 格式）将在这里展示
                </div>
              )}
            </>
          )}
        </aside>
      </div>
      <TextInputDialog
        open={boardNameDialog !== null}
        title={boardNameDialog?.mode === 'rename' ? '重命名剧本项目' : '新建剧本项目'}
        body={boardNameDialog?.mode === 'rename' ? '修改后会同步更新项目树和项目上下文。' : '为新的剧本项目设置一个容易识别的名称。'}
        defaultValue={boardNameDialog?.mode === 'rename' ? boardNameDialog.board.name : ''}
        placeholder="例如：雾中的邮差"
        confirmLabel={boardNameDialog?.mode === 'rename' ? '保存名称' : '创建项目'}
        busy={boardDialogBusy}
        onConfirm={submitBoardName}
        onCancel={() => { if (!boardDialogBusy) setBoardNameDialog(null); }}
      />
      <ConfirmDialog
        open={boardDeleteDialog !== null}
        title="删除剧本项目"
        body={`删除「${boardDeleteDialog?.name ?? ''}」？项目级提示词与 RAG 配置将一并删除，会话消息保留。`}
        confirmLabel="确认删除"
        onCancel={() => setBoardDeleteDialog(null)}
        onConfirm={confirmRemoveBoard}
      />
      <ConfirmDialog
        open={resetDialog}
        title="重新生成故事"
        body="将清空当前故事进度与右侧剧本文档，确定继续吗？"
        confirmLabel="确认重置"
        onCancel={() => setResetDialog(false)}
        onConfirm={confirmReset}
      />
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
    <div className="prompt-panel" data-testid="prompt-panel">
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
    </div>
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
    <div className="rag-panel" data-testid="rag-panel">
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
    </div>
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
