import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { client } from '../api/client';
import { Icon } from '../icons';
import { ConfirmDialog } from '../panels/ConfirmDialog';
import { TextInputDialog } from '../panels/TextInputDialog';
import { resolveBoardPrompt, resolvePrompt, withArmorBreak } from './roles';
import { AiButton, EmptyState, ErrorBanner } from './role-ui';
import type { SessionMeta, StoryBoard } from '../types';
import type { AssetItem } from '../panels/AssetLibrary';
import { insertAssetMention, useAssetMentions, type MentionAsset } from '../panels/AssetMentionPicker';
import { MentionComposer } from '../panels/MentionComposer';
import {
  parseChoiceBlock,
  STORY_KICKOFF_MARKER,
  STORY_KICKOFF_MESSAGE,
  STORY_SYSTEM_MARKERS,
} from './choice';
import type { ParsedChoice } from './choice';

// images：用户消息携带的图像附件（data URL 缩略图展示；历史重载不还原，仅即时会话可见）
export interface ChatMsg {
  who: 'user' | 'agent';
  text: string;
  images?: Array<{ name: string; dataUrl: string }>;
  assetRefs?: MentionAsset[];
}

// 待发送的图像附件（预览 + 随消息发送）
export interface ChatAttachment { id: string; name: string; dataUrl: string; assetId?: string; fromMention?: boolean }

// 六步答案约定格式解析：按行匹配 `stepId: 内容`，非法行忽略（导出便于测试）
export function parseStoryAnswers(text: string): Record<string, string> {
  const STEP_IDS = ['theme', 'protagonist', 'support', 'antagonist', 'scenes', 'ending'];
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^(theme|protagonist|support|antagonist|scenes|ending):\s*(.+)$/.exec(line.trim());
    if (m && STEP_IDS.includes(m[1]!)) {
      out[m[1]!] = m[2]!.trim();
    }
  }
  return out;
}

// 会话更新时间 → 短日期：当天显示 HH:mm，否则 MM-DD（同 AGENT 面板）
function fmtSessionDate(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function StoryChat(props: {
  projectName: string;
  // 总结成稿成功回调：携带解析出的答案（父组件先 saveStory 再 completeStory 入库）
  onSummarized: (answers: Record<string, string>) => void;
  // 提示词库（角色系统提示词；未配置键回退内置默认）
  prompts?: Record<string, string>;
  // 破甲预设：开启且文本非空时插入到所有系统提示词之前
  armorBreak?: string;
  armorBreakEnabled?: boolean;
  // 默认模型与思考强度（来自全局设置；透传到 /api/story/chat body，缺省走 pi 默认）
  agentModel?: string;
  thinkingLevel?: string;
  // 当前模型的视觉能力（来自 pi --list-models；未知时由后端错误回退）
  modelSupportsImages?: boolean;
  // 剧本项目（board）：boardId 归组会话 + 项目级系统提示词（board → 全局 → 内置）
  board?: StoryBoard | null;
  // 外部会话挂载点：故事页将会话树放进当前项目项下；独立渲染时回退到聊天区
  sessionHost?: HTMLElement | null;
  // 故事页项目行上的“新建会话”按钮复用此组件内部的会话状态
  onCreateSessionReady?: (handler: (() => void) | null) => void;
}) {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  // 多会话：会话列表 + 当前会话 id（左侧列表面板）
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false); // 发送/总结共用 busy（防并发）
  const [action, setAction] = useState<'summarize' | null>(null);
  const [hasKickoffMarker, setHasKickoffMarker] = useState(false);
  const [historyReady, setHistoryReady] = useState(false);
  const [renameTarget, setRenameTarget] = useState<SessionMeta | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SessionMeta | null>(null);
  const [sessionDialogBusy, setSessionDialogBusy] = useState(false);
  // 图像附件：Ctrl+V 粘贴 / 附件按钮选择 → 预览列表 → 随下一条消息发送
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [assetRefs, setAssetRefs] = useState<MentionAsset[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeIdRef = useRef<string | null>(null);
  const requestSeqRef = useRef(0);
  const requestRef = useRef<{ id: number; sessionId: string | null; kind: 'kickoff' | 'chat' | 'summarize' } | null>(null);
  const kickoffAttemptedRef = useRef(new Set<string>());
  const rawAgentTextRef = useRef('');
  const busyRef = useRef(false);
  const choiceRef = useRef<ParsedChoice | null>(null);
  const mentionOpenRef = useRef(false);
  // 当前剧本项目 id（归组会话 + 后端解析项目级提示词/RAG）
  const boardId = props.board?.id ?? null;
  const assetMention = useAssetMentions(input);
  const latestAgent = [...msgs].reverse().find((message) => message.who === 'agent');
  const latestChoice = !busy && latestAgent ? parseChoiceBlock(latestAgent.text) : null;
  choiceRef.current = latestChoice;
  mentionOpenRef.current = assetMention.open;
  busyRef.current = busy;

  // 发送/总结完成后重新拉取会话列表：后端在首条用户消息后自动命名会话并 bump updatedAt，
  // 不刷新则当前会话一直显示「新会话」直到页面重载
  const refreshSessions = () => {
    void client.listStorySessions(boardId).then((r) => setSessions(r.sessions)).catch(() => {});
  };

  // 项目/剧本项目切换或挂载时：加载会话列表 → 无会话自动新建 → 加载当前会话历史
  useEffect(() => {
    setMsgs([]);
    setLoaded(false);
    setHistoryReady(false);
    setHasKickoffMarker(false);
    setActiveId(null);
    setError(''); // 切项目清残留错误（新项目可能有独立状态）
    activeIdRef.current = null;
    requestRef.current = null;
    kickoffAttemptedRef.current = new Set();
    let disposed = false;
    const load = async () => {
      try {
        let r = await client.listStorySessions(boardId);
        if (!r.activeId) r = await client.createStorySession(boardId);
        if (disposed) return;
        setSessions(r.sessions);
        activeIdRef.current = r.activeId;
        setActiveId(r.activeId);
        if (r.activeId) {
          const history = await client.getStoryChatHistory(r.activeId);
          if (!disposed) {
            setHasKickoffMarker(history.some((m) => m.who === 'user' && m.text.trim() === STORY_KICKOFF_MARKER));
            setMsgs(history
              .filter((m) => !(m.who === 'user' && m.text.trim() === STORY_KICKOFF_MARKER))
              .map((m) => ({ who: m.who, text: m.text })));
            setHistoryReady(true);
          }
        } else if (!disposed) {
          setHistoryReady(true);
        }
        if (!disposed) setLoaded(true);
      } catch {
        if (!disposed) { setError('加载对话历史失败'); setHistoryReady(true); setLoaded(true); }
      }
    };
    void load();
    return () => { disposed = true; };
    // boardId 变化 = 切换剧本项目：整套提示词 + RAG + 会话列表一起切换
  }, [props.projectName, boardId]);

  const isCurrentRequest = (request: { id: number; sessionId: string | null }) => (
    requestRef.current?.id === request.id && activeIdRef.current === request.sessionId
  );

  const streamingPrompt = (text: string): string => {
    const start = text.search(/(?:^|\r?\n)```choice[ \t]*\r?\n/m);
    return start < 0 ? text : text.slice(0, start).trimEnd();
  };

  // rawAgentTextRef 保留完整模型原文；流式期间只临时隐藏可能尚未闭合的 choice 围栏。
  const appendStream = (chunk: string, request: { id: number; sessionId: string | null }) => {
    if (!isCurrentRequest(request)) return;
    rawAgentTextRef.current += chunk;
    const displayText = streamingPrompt(rawAgentTextRef.current);
    setMsgs((m) => {
      const next = [...m];
      const last = next[next.length - 1];
      if (last && last.who === 'agent') {
        next[next.length - 1] = { ...last, text: displayText };
      } else {
        next.push({ who: 'agent', text: displayText });
      }
      return next;
    });
  };

  const finalizeStream = (request: { id: number; sessionId: string | null }) => {
    if (!isCurrentRequest(request)) return;
    const raw = rawAgentTextRef.current;
    setMsgs((m) => {
      const next = [...m];
      const last = next[next.length - 1];
      if (last?.who === 'agent') next[next.length - 1] = { ...last, text: raw };
      else if (raw) next.push({ who: 'agent', text: raw });
      return next;
    });
  };

  const beginRequest = (sessionId: string | null, kind: 'kickoff' | 'chat' | 'summarize') => {
    const request = { id: ++requestSeqRef.current, sessionId, kind };
    requestRef.current = request;
    rawAgentTextRef.current = '';
    busyRef.current = true;
    setBusy(true);
    setError('');
    return request;
  };

  const kickoff = async (sessionId: string) => {
    if (busyRef.current || kickoffAttemptedRef.current.has(sessionId)) return;
    kickoffAttemptedRef.current.add(sessionId);
    setHasKickoffMarker(true);
    const request = beginRequest(sessionId, 'kickoff');
    const sysPrompt = boardId ? undefined : resolvePrompt(props.prompts, 'storyTeller');
    try {
      await client.storyChat(
        STORY_KICKOFF_MESSAGE,
        (chunk) => appendStream(chunk, request),
        props.agentModel || undefined,
        props.thinkingLevel || undefined,
        STORY_KICKOFF_MARKER,
        sessionId,
        sysPrompt,
        boardId,
        undefined,
        props.modelSupportsImages,
      );
      finalizeStream(request);
    } catch (err) {
      const message = `\n\n（agent 连接失败：${err instanceof Error ? err.message : '未知错误'}）`;
      appendStream(message, request);
      if (isCurrentRequest(request)) setError(message.trim());
    } finally {
      if (isCurrentRequest(request)) {
        requestRef.current = null;
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  useEffect(() => {
    if (!loaded || !historyReady || busy || !activeId || hasKickoffMarker) return;
    const hasAgent = msgs.some((message) => message.who === 'agent');
    const hasRealUser = msgs.some((message) => (
      message.who === 'user' && !(STORY_SYSTEM_MARKERS as readonly string[]).includes(message.text.trim())
    ));
    if (!hasAgent && !hasRealUser && !kickoffAttemptedRef.current.has(activeId)) {
      void kickoff(activeId);
    }
  }, [activeId, busy, hasKickoffMarker, historyReady, loaded, msgs]);

  // 新建会话：流式中禁止（busy 期间切换会打乱正在落盘/流式的会话上下文）
  const newSession = async () => {
    if (busy) return;
    const r = await client.createStorySession(boardId).catch(() => null);
    if (!r) return;
    setSessions(r.sessions);
    activeIdRef.current = r.activeId;
    setActiveId(r.activeId);
    setHistoryReady(true);
    setHasKickoffMarker(false);
    if (r.activeId) kickoffAttemptedRef.current.delete(r.activeId);
    setError(''); // 新空会话清残留错误（旧会话可能报过加载/格式错误）
    setMsgs([]);
  };

  // 父级项目行提供新建按钮，但实际创建仍复用本组件的会话状态与 API。
  useEffect(() => {
    if (!props.onCreateSessionReady) return;
    props.onCreateSessionReady(() => { void newSession(); });
    return () => props.onCreateSessionReady?.(null);
  }, [props.onCreateSessionReady, busy, boardId]);

  // 点选历史会话：流式中禁止
  const selectSession = (id: string) => {
    if (busy) return;
    if (id === activeId) return;
    activeIdRef.current = id;
    setActiveId(id);
    setHistoryReady(false);
    setHasKickoffMarker(false);
    setMsgs([]);
    void client.getStoryChatHistory(id).then((history) => {
      if (activeIdRef.current !== id) return;
      setHasKickoffMarker(history.some((m) => m.who === 'user' && m.text.trim() === STORY_KICKOFF_MARKER));
      setMsgs(history
        .filter((m) => !(m.who === 'user' && m.text.trim() === STORY_KICKOFF_MARKER))
        .map((m) => ({ who: m.who, text: m.text })));
      setHistoryReady(true);
    }).catch(() => {});
  };

  const renameSession = (s: SessionMeta) => setRenameTarget(s);
  const submitRenameSession = async (title: string) => {
    const target = renameTarget;
    if (!target) return;
    setSessionDialogBusy(true);
    const r = await client.renameStorySession(target.id, title, boardId).catch(() => null);
    if (r) {
      setSessions(r.sessions);
      setRenameTarget(null);
    }
    setSessionDialogBusy(false);
  };

  // 删除会话：流式中禁止（否则在途流式 POST 会落盘到刚删除的会话，幽灵 AI 文本进入空视图）
  const deleteSession = (s: SessionMeta) => {
    if (busy) return;
    setDeleteTarget(s);
  };
  const confirmDeleteSession = async () => {
    const target = deleteTarget;
    if (!target) return;
    setDeleteTarget(null);
    let r = await client.deleteStorySession(target.id, boardId).catch(() => null);
    if (!r) return;
    if (!r.activeId) {
      // 删光会话：自动新建一个空会话，避免下次发送聊进 UI 看不见的会话（后端自动创建，UI 无从得知）
      const created = await client.createStorySession(boardId).catch(() => null);
      r = created ?? r;
    }
    setSessions(r.sessions);
    activeIdRef.current = r.activeId;
    setActiveId(r.activeId);
    setHistoryReady(false);
    setHasKickoffMarker(false);
    setMsgs([]);
    if (r.activeId) {
      void client.getStoryChatHistory(r.activeId).then((history) => {
        if (activeIdRef.current !== r.activeId) return;
        setHasKickoffMarker(history.some((m) => m.who === 'user' && m.text.trim() === STORY_KICKOFF_MARKER));
        setMsgs(history
          .filter((m) => !(m.who === 'user' && m.text.trim() === STORY_KICKOFF_MARKER))
          .map((m) => ({ who: m.who, text: m.text })));
        setHistoryReady(true);
      }).catch(() => {});
    }
  };

  // 读取图片文件为 data URL 并加入附件列表（粘贴/选择共用）
  const addAttachment = (file: File) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? '');
      if (!dataUrl) return;
      setAttachments((prev) => [...prev, { id, name: file.name || '粘贴图片.png', dataUrl }]);
    };
    reader.readAsDataURL(file);
  };

  // Ctrl+V 粘贴：剪贴板含图像 → 转为附件（不发送、可预览/移除）；纯文本保持默认粘贴
  const handlePaste = (e: React.ClipboardEvent) => {
    const images = Array.from(e.clipboardData?.items ?? [])
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null);
    if (images.length === 0) return;
    e.preventDefault();
    for (const f of images) addAttachment(f);
  };

  const pickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // 允许重复选择同一文件
    for (const f of files) addAttachment(f);
  };

  const removeAttachment = (id: string) => {
    const removed = attachments.find((a) => a.id === id);
    setAttachments((prev) => prev.filter((a) => a.id !== id));
    if (removed?.assetId) setAssetRefs((prev) => prev.filter((asset) => asset.id !== removed.assetId));
  };

  const removeAssetRef = (id: string) => {
    setAssetRefs((prev) => prev.filter((a) => a.id !== id));
  };

  // 从全局素材库拖入故事对话：图像转图片附件，文本/视频保留为素材引用。
  const addAssetAttachment = async (item: AssetItem, fromMention = false) => {
    if (item.kind !== 'img') {
      if (!item.id) {
        setError('素材缺少可引用的 id');
        return;
      }
      setAssetRefs((prev) => prev.some((a) => a.id === item.id)
        ? prev
        : [...prev, { id: item.id!, name: item.name, kind: item.kind as 'txt' | 'vid' }]);
      setError('');
      return;
    }
    if (!item.id) {
      setError('图像素材缺少可读取的 id');
      return;
    }
    try {
      const res = await fetch(`/api/assets/${encodeURIComponent(item.id)}/file`);
      if (!res.ok) throw new Error(`素材读取失败：${res.status}`);
      const blob = await res.blob();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(new Error('素材读取失败'));
        reader.readAsDataURL(blob);
      });
      setAttachments((prev) => [...prev, {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: item.name,
        dataUrl,
        assetId: item.id,
        fromMention,
      }]);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '素材读取失败');
    }
  };

  const selectAssetMention = (item: MentionAsset) => {
    setInput(insertAssetMention(input, item));
    setAssetRefs((prev) => prev.some((asset) => asset.id === item.id) ? prev : [...prev, item]);

  };

  const handleInputChange = (value: string) => {
    setInput(value);
    setAssetRefs((prev) => prev.filter((asset) => value.includes(`@${asset.name}`)));
    setAttachments((prev) => prev.filter((attachment) => !attachment.fromMention || value.includes(`@${attachment.name}`)));
  };

  const handleAssetDrop = (e: React.DragEvent) => {
    const raw = e.dataTransfer.getData('application/x-asset');
    if (!raw) return;
    e.preventDefault();
    try {
      const item = JSON.parse(raw) as AssetItem;
      setInput((value) => `${value}${value && !/\s$/.test(value) ? ' ' : ''}@${item.name} `);
      void addAssetAttachment(item);
    } catch {
      setError('无法读取拖入的素材');
    }
  };

  const sendMessage = (message: string, options: { includeExtras?: boolean } = {}) => {
    const includeExtras = options.includeExtras !== false;
    const text = message.trim();
    if (busyRef.current || (!text && (!includeExtras || (attachments.length === 0 && assetRefs.length === 0)))) return;

    const imgs = includeExtras ? attachments.map((a) => ({ name: a.name, data: a.dataUrl })) : [];
    const refs = includeExtras ? [...assetRefs] : [];
    const msgImages = includeExtras ? attachments.map((a) => ({ name: a.name, dataUrl: a.dataUrl })) : [];
    if (includeExtras) {
      setInput('');
      setAttachments([]);
      setAssetRefs([]);
    }
    const sessionId = activeIdRef.current;
    const request = beginRequest(sessionId, 'chat');
    setMsgs((m) => [...m, {
      who: 'user', text,
      images: msgImages.length > 0 ? msgImages : undefined,
      assetRefs: refs.length > 0 ? refs : undefined,
    }]);
    const sysPrompt = boardId ? undefined : resolvePrompt(props.prompts, 'storyTeller');
    void client.storyChat(
      text,
      (chunk) => appendStream(chunk, request),
      props.agentModel || undefined,
      props.thinkingLevel || undefined,
      undefined,
      sessionId,
      sysPrompt,
      boardId,
      imgs.length > 0 ? imgs : undefined,
      props.modelSupportsImages,
      refs.length > 0 ? refs : undefined,
    )
      .then(() => finalizeStream(request))
      .catch((err) => {
        const message = `\n\n（agent 连接失败：${err instanceof Error ? err.message : '未知错误'}）`;
        appendStream(message, request);
        if (isCurrentRequest(request)) setError(message.trim());
      })
      .finally(() => {
        if (!isCurrentRequest(request)) return;
        requestRef.current = null;
        busyRef.current = false;
        setBusy(false);
        refreshSessions();
      });
  };

  const send = () => sendMessage(input, { includeExtras: true });

  useEffect(() => {
    const handleChoiceKey = (event: KeyboardEvent) => {
      const choice = choiceRef.current;
      if (!choice || busyRef.current || event.defaultPrevented || event.isComposing) return;
      if (mentionOpenRef.current) return;
      const active = document.activeElement as HTMLElement | null;
      if (active?.matches('input, textarea, [contenteditable="true"]')) return;
      if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      if (!/^[1-4]$/.test(event.key)) return;
      const option = choice.options[Number(event.key) - 1];
      if (!option) return;
      event.preventDefault();
      sendMessage(option.label, { includeExtras: false });
    };
    window.addEventListener('keydown', handleChoiceKey);
    return () => window.removeEventListener('keydown', handleChoiceKey);
  }, []);

  // 跑一次「总结成稿」：让 AI 基于全部对话输出六步答案。
  // 发送的 message 是组装好的角色+指令 prompt；persistAs 标记（「（请总结成稿）」）
  // 让后端落盘时用标记替代长指令原文——避免长指令消耗 100 条历史上限并污染下次对话上下文。
  // 流式累积输出 → 解析六步答案 → 回调父组件。
  // try/catch/finally：连接失败时只提示连接失败，跳过解析与回调（
  // 避免与「未识别到答案格式」同时出现两条矛盾提示）。
  const runAction = async () => {
    if (busyRef.current) return;
    // 剧本项目存在：消息只带项目 storySummarize 指令（后端注入项目 storyTeller 人格 + 跳过 RAG）；
    // 无项目（旧路径）：消息带完整 storyTeller + storySummarize，systemPrompt 由前端解析全局/内置
    const summarizePrompt = boardId
      ? resolveBoardPrompt(props.board, props.prompts, 'storySummarize')
      : `${resolvePrompt(props.prompts, 'storyTeller')}\n\n${resolvePrompt(props.prompts, 'storySummarize')}`;
    const prompt = withArmorBreak(summarizePrompt, props.armorBreak, props.armorBreakEnabled);
    const sessionId = activeIdRef.current;
    const request = beginRequest(sessionId, 'summarize');
    setAction('summarize');
    let acc = '';
    setMsgs((m) => [...m, { who: 'user', text: '（请总结成稿）' }]);
    try {
      await client.storyChat(prompt, (chunk) => {
        if (!isCurrentRequest(request)) return;
        acc += chunk;
        appendStream(chunk, request);
      }, props.agentModel || undefined, props.thinkingLevel || undefined, '（请总结成稿）', sessionId, undefined, boardId);
      finalizeStream(request);
      if (isCurrentRequest(request)) {
        const answers = parseStoryAnswers(acc);
        if (Object.keys(answers).length === 0) setError('未识别到答案格式，请重试');
        else props.onSummarized(answers);
      }
    } catch (err) {
      const message = `\n\n（agent 连接失败：${err instanceof Error ? err.message : '未知错误'}）`;
      appendStream(message, request);
      if (isCurrentRequest(request)) setError(message.trim());
    } finally {
      if (!isCurrentRequest(request)) return;
      requestRef.current = null;
      busyRef.current = false;
      setBusy(false);
      setAction(null);
      refreshSessions(); // 总结也落盘消息：刷新列表同步标题/updatedAt
    }
  };

  const summarize = () => runAction();

  if (!loaded) {
    return <div className="chat-wrap"><div className="role-loading">加载中…</div></div>;
  }

  // 会话操作仍由 StoryChat 管理，但视觉位置由父级故事布局决定。
  // 通过 portal 放入左侧项目栏，避免为了移动 DOM 而复制会话 API/状态逻辑。
  const sessionPanel = (
    <div className="session-panel" data-testid="session-panel">
      {!props.sessionHost && (
        <button type="button" className="btn-ghost session-new" data-testid="session-new" onClick={() => { void newSession(); }}>＋ 新建会话</button>
      )}
      <div className="session-list">
        {sessions.map((s) => (
          <div key={s.id} className={`session-item${s.id === activeId ? ' active' : ''}`} data-testid={`session-item-${s.id}`}>
            <button type="button" className="session-select" onClick={() => selectSession(s.id)}>
              <span className="session-title">{s.title}</span>
              <span className="session-date">{fmtSessionDate(s.updatedAt)}</span>
            </button>
            <div className="session-acts">
              <button type="button" className="session-act" data-testid={`session-rename-${s.id}`} title="重命名"
                onClick={() => { void renameSession(s); }}><Icon name="pencil" /></button>
              <button type="button" className="session-act" data-testid={`session-del-${s.id}`} title="删除"
                onClick={() => { void deleteSession(s); }}><Icon name="trash" /></button>
            </div>
          </div>
        ))}
        {sessions.length === 0 && <div className="session-empty">暂无会话</div>}
      </div>
    </div>
  );

  const visibleMsgs = msgs.filter((message) => (
    !(message.who === 'user' && message.text.trim() === STORY_KICKOFF_MARKER)
  ));

  return (
    <div className="chat-wrap">
      {!props.sessionHost ? sessionPanel : createPortal(sessionPanel, props.sessionHost)}
      <div className="chat-main">
        <div
          className="chat-msgs chat-conversation"
          data-testid="chat-conversation"
          data-layout="reading-column"
        >
          {visibleMsgs.length === 0 && (
            <EmptyState icon={<Icon name="chat" />} text="还没有对话，从任意创意开始吧——主题、角色、情节都可以聊" />
          )}
          {visibleMsgs.map((m, i) => (
            <article key={i} className={`chat-msg ${m.who}`} data-testid={`chat-message-${i}`}>
              <div className="chat-avatar" aria-hidden="true">{m.who === 'user' ? '你' : '✦'}</div>
              <div className="chat-message-body" data-testid="chat-message-body">
                <div className="chat-message-meta" data-testid="chat-message-meta">
                  <strong>{m.who === 'user' ? '你' : '编剧'}</strong>
                  <time>{m.who === 'user' ? '刚刚' : '现在'}</time>
                </div>
                <div className="chat-message-content chat-bubble">
                  {m.images && m.images.length > 0 && (
                    <div className="chat-msg-imgs">
                      {m.images.map((img) => (
                        <img key={img.dataUrl} src={img.dataUrl} alt={img.name} title={img.name} />
                      ))}
                    </div>
                  )}
                  {m.assetRefs && m.assetRefs.length > 0 && (
                    <div className="chat-msg-assets" data-testid="chat-msg-assets">
                      {m.assetRefs.map((asset) => (
                        <span key={asset.id} className="chat-msg-asset"><Icon name={asset.kind === 'txt' ? 'file-text' : 'video'} />{asset.name}</span>
                      ))}
                    </div>
                  )}
                  {m.who === 'agent' ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{parseChoiceBlock(m.text)?.prompt ?? m.text}</ReactMarkdown>
                  ) : (
                    <p>{m.text}</p>
                  )}
                </div>
              </div>
            </article>
          ))}
          {busy && <div className="chat-thinking"><Icon name="loader" /> AI 思考中…</div>}
        </div>
        <div
          className="chat-composer"
          data-testid="chat-composer"
          data-layout="inset-composer"
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('application/x-asset')) e.preventDefault();
          }}
          onDrop={handleAssetDrop}
        >
          {attachments.some((a) => !a.fromMention) && (
            <div className="chat-attach-row" data-testid="chat-attach-row">
              {attachments.filter((a) => !a.fromMention).map((a) => (
                <div key={a.id} className="chat-attach" data-testid={`chat-attach-${a.id}`}>
                  <img src={a.dataUrl} alt={a.name} />
                  <span className="chat-attach-name">{a.name}</span>
                  <span
                    className="chat-attach-x" role="button" tabIndex={0} title="移除附件"
                    onClick={() => removeAttachment(a.id)}
                  ><Icon name="x" /></span>
                </div>
              ))}
            </div>
          )}
          {latestChoice && !busy && (
            <div className="chat-choice" data-testid="chat-choice">
              <div className="chat-choice-q">{latestChoice.question}</div>
              <div className="chat-choice-options">
                {latestChoice.options.map((option, index) => (
                  <button
                    key={option.id}
                    type="button"
                    className="chat-choice-opt"
                    disabled={busy}
                    onClick={() => sendMessage(option.label, { includeExtras: false })}
                  >
                    <span className="chat-choice-key">{index + 1}</span>
                    <span>{option.label}</span>
                  </button>
                ))}
              </div>
              <div className="chat-choice-divider" />
            </div>
          )}
          <div className="chat-input-row" data-layout="centered-controls">
            <button
              type="button" className="chat-attach-btn" data-testid="chat-attach-btn"
              title="添加图片附件（Ctrl+V 粘贴）"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
            ><Icon name="paperclip" /></button>
            <input
              ref={fileInputRef} type="file" accept="image/*" multiple disabled={busy} style={{ display: 'none' }}
              onChange={(e) => pickFiles(e)}
            />
            <MentionComposer
              className="chat-input"
              testId="chat-input"
              value={input}
              assets={assetMention.assets}
              placeholder={latestChoice ? '其他… 可 @ 引用素材，或直接输入' : '和编剧聊聊你的故事…（Enter 发送 · Ctrl+V 粘贴图片作为参考）'}
              mentionOpen={assetMention.open}
              mentionItems={assetMention.candidates}
              mentionActiveIndex={assetMention.activeIndex}
              mentionTestIdPrefix="chat"
              disabled={busy}
              onChange={handleInputChange}
              onPaste={handlePaste}
              onSelectMention={selectAssetMention}
              onKeyDown={(e) => {
                if (assetMention.handleKeyDown(e, selectAssetMention)) return;
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <button className="btn-primary" onClick={send} disabled={busy || (!input.trim() && attachments.length === 0 && assetRefs.length === 0)}>发送</button>
          </div>
          <div className="chat-actions">
            <AiButton busy={busy && action === 'summarize'} onClick={summarize}><Icon name="sparkles" />总结成稿</AiButton>
            <span className="chat-hint">总结成稿：对话 → 完整故事文档入库</span>
          </div>
        </div>
        {error && <ErrorBanner text={error} />}
      </div>
      <TextInputDialog
        open={renameTarget !== null}
        title="重命名会话"
        body="为这段创作保留一个容易识别的标题。"
        defaultValue={renameTarget?.title ?? ''}
        placeholder="例如：开场与人物关系"
        confirmLabel="保存名称"
        busy={sessionDialogBusy}
        onConfirm={(value) => { void submitRenameSession(value); }}
        onCancel={() => { if (!sessionDialogBusy) setRenameTarget(null); }}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除会话"
        body={`删除「${deleteTarget?.title ?? ''}」？其中的消息也会一并删除。`}
        confirmLabel="确认删除"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => { void confirmDeleteSession(); }}
      />
    </div>
  );
}
