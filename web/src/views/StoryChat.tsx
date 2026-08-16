import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { client } from '../api/client';
import { STORY_BACKFILL_PROMPT, STORY_CHAT_SYSTEM, STORY_SUMMARIZE_PROMPT } from './roles';
import { AiButton, EmptyState, ErrorBanner } from './role-ui';

export interface ChatMsg { who: 'user' | 'agent'; text: string }

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

export function StoryChat(props: {
  projectName: string;
  // 回填向导成功回调：携带解析出的答案（父组件写入 story.json 并切回向导式）
  onBackfill: (answers: Record<string, string>) => void;
  // 总结成稿成功回调：携带解析出的答案（父组件先 saveStory 再 completeStory 入库）
  onSummarized: (answers: Record<string, string>) => void;
  // 故事完成时间（总结成稿入库后非空）：对话式顶部显示完成提示条
  completedAt?: string | null;
  // 提示词库（角色系统提示词；未配置键回退内置默认）
  prompts?: Record<string, string>;
}) {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false); // 发送/总结/回填共用 busy（防并发）
  const [action, setAction] = useState<'summarize' | 'backfill' | null>(null);

  // 项目切换/挂载时加载历史
  useEffect(() => {
    setMsgs([]);
    setLoaded(false);
    setError(''); // 切项目清残留错误（新项目可能有独立状态）
    let disposed = false;
    void client.getStoryChatHistory().then((h) => {
      if (disposed) return;
      setMsgs(h.map((m) => ({ who: m.who, text: m.text })));
      setLoaded(true);
    }).catch(() => {
      if (!disposed) { setError('加载对话历史失败'); setLoaded(true); }
    });
    return () => { disposed = true; };
  }, [props.projectName]);

  // 追加流式 chunk 到最后一条 agent 消息
  const appendStream = (chunk: string) => {
    setMsgs((m) => {
      const next = [...m];
      const last = next[next.length - 1];
      if (last && last.who === 'agent') {
        next[next.length - 1] = { ...last, text: last.text + chunk };
      } else {
        next.push({ who: 'agent', text: chunk });
      }
      return next;
    });
  };

  const send = () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setBusy(true);
    setError('');
    setMsgs((m) => [...m, { who: 'user', text }]);
    client.storyChat(text, appendStream)
      .catch(() => appendStream('\n\n（agent 连接失败）'))
      .finally(() => setBusy(false));
  };

  // 跑一次「总结成稿」或「回填向导」：让 AI 基于全部对话输出六步答案。
  // 发送的 message 是组装好的角色+指令 prompt；persistAs 标记（「（请总结成稿）」/「（请回填向导）」）
  // 让后端落盘时用标记替代长指令原文——避免长指令消耗 100 条历史上限并污染下次对话上下文。
  // 流式累积输出 → 解析六步答案 → 回调父组件。
  // try/catch/finally：连接失败时只提示连接失败，跳过解析与回调（
  // 避免与「未识别到答案格式」同时出现两条矛盾提示）。
  const runAction = async (kind: 'summarize' | 'backfill') => {
    if (busy) return;
    setBusy(true);
    setAction(kind);
    setError('');
    const system = kind === 'summarize' ? STORY_SUMMARIZE_PROMPT : STORY_BACKFILL_PROMPT;
    const prompt = `${STORY_CHAT_SYSTEM}\n\n${system}`;
    const persistAs = kind === 'summarize' ? '（请总结成稿）' : '（请回填向导）';
    let acc = '';
    setMsgs((m) => [...m, { who: 'user', text: persistAs }]);
    try {
      await client.storyChat(prompt, (chunk) => {
        acc += chunk;
        appendStream(chunk);
      }, undefined, undefined, persistAs);
      const answers = parseStoryAnswers(acc);
      if (Object.keys(answers).length === 0) {
        setError('未识别到答案格式，请重试');
      } else if (kind === 'backfill') {
        props.onBackfill(answers);
      } else {
        props.onSummarized(answers);
      }
    } catch {
      appendStream('\n\n（agent 连接失败）');
    } finally {
      setBusy(false);
      setAction(null);
    }
  };

  const summarize = () => runAction('summarize');
  const backfill = () => runAction('backfill');

  if (!loaded) {
    return <div className="chat-wrap"><div className="role-loading">加载中…</div></div>;
  }

  return (
    <div className="chat-wrap">
      {props.completedAt && (
        <div className="story-banner">✅ 已完成 · 已生成故事文档进素材库</div>
      )}
      <div className="chat-msgs">
        {msgs.length === 0 && (
          <EmptyState icon="💬" text="还没有对话，从任意创意开始吧——主题、角色、情节都可以聊" />
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`chat-msg ${m.who}`}>
            <div className="chat-who">{m.who === 'user' ? 'YOU' : 'AI · 编剧'}</div>
            <div className="chat-bubble">
              {m.who === 'agent' ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
              ) : m.text}
            </div>
          </div>
        ))}
        {busy && <div className="chat-thinking">⏳ AI 思考中…</div>}
      </div>
      <div className="chat-input-row">
        <textarea
          className="ne-input chat-input" data-testid="chat-input"
          placeholder="和编剧聊聊你的故事…（Enter 发送 · Shift+Enter 换行）"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
        />
        <button className="btn-primary" onClick={send} disabled={busy || !input.trim()}>发送</button>
      </div>
      <div className="chat-actions">
        <AiButton busy={busy && action === 'summarize'} onClick={summarize}>✨ 总结成稿</AiButton>
        <AiButton busy={busy && action === 'backfill'} onClick={backfill}>↩ 回填向导</AiButton>
        <span className="chat-hint">总结成稿：对话 → 完整故事文档入库；回填向导：对话 → 六步答案写入向导</span>
      </div>
      {error && <ErrorBanner text={error} />}
    </div>
  );
}
