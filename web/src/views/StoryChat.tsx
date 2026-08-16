import { useEffect, useRef, useState } from 'react';
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
}) {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false); // 发送/总结/回填共用 busy（防并发）
  const [action, setAction] = useState<'summarize' | 'backfill' | null>(null);
  const dirtyRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 项目切换/挂载时加载历史
  useEffect(() => {
    dirtyRef.current = false;
    setMsgs([]);
    setLoaded(false);
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
    dirtyRef.current = true;
    setInput('');
    setBusy(true);
    setError('');
    setMsgs((m) => [...m, { who: 'user', text }]);
    client.storyChat(text, appendStream)
      .catch(() => appendStream('\n\n（agent 连接失败）'))
      .finally(() => setBusy(false));
  };

  // 跑一次「总结成稿」或「回填向导」：让 AI 基于全部对话输出六步答案。
  // 发送的 message 是组装好的角色+指令 prompt（后端会把它当用户消息落盘，
  // 落盘文本用「（请总结成稿）」等标记，避免把长指令污染进对话历史）；
  // 流式累积输出 → 解析六步答案 → 回调父组件。
  const runAction = (kind: 'summarize' | 'backfill') => {
    if (busy) return;
    setBusy(true);
    setAction(kind);
    setError('');
    const system = kind === 'summarize' ? STORY_SUMMARIZE_PROMPT : STORY_BACKFILL_PROMPT;
    const prompt = `${STORY_CHAT_SYSTEM}\n\n${system}`;
    let acc = '';
    setMsgs((m) => [...m, { who: 'user', text: kind === 'summarize' ? '（请总结成稿）' : '（请回填向导）' }]);
    client.storyChat(prompt, (chunk) => {
      acc += chunk;
      appendStream(chunk);
    }).catch(() => appendStream('\n\n（agent 连接失败）')).then(() => {
      const answers = parseStoryAnswers(acc);
      if (Object.keys(answers).length === 0) {
        setError('未识别到答案格式，请重试');
      } else if (kind === 'backfill') {
        props.onBackfill(answers);
      } else {
        props.onSummarized(answers);
      }
    }).finally(() => {
      setBusy(false);
      setAction(null);
    });
  };

  const summarize = () => runAction('summarize');
  const backfill = () => runAction('backfill');

  if (!loaded) {
    return <div className="chat-wrap"><div className="role-loading">加载中…</div></div>;
  }

  return (
    <div className="chat-wrap">
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
          ref={inputRef}
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
