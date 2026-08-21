import { useEffect, useRef, useState } from 'react';
import { fetchGenerateData, sendChat, type ChatMessage, type GenerateData, type SkillCard } from './api';
import Rail from './components/Rail';
import Sidebar, { type Conversation } from './components/Sidebar';
import SkillCards from './components/SkillCards';
import Composer from './components/Composer';
import ChatView from './components/ChatView';
import './App.css';

export default function App() {
  const [data, setData] = useState<GenerateData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeNav, setActiveNav] = useState('generate');
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConv, setActiveConv] = useState<string | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchGenerateData()
      .then(setData)
      .catch(e => setError(String(e?.message ?? e)));
  }, []);

  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });
  }, [messages]);

  const handleSend = async (text?: string) => {
    const content = (text ?? input).trim();
    if (!content || sending) return;
    const userMsg: ChatMessage = { role: 'user', content };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setSending(true);
    try {
      const { reply, title, stages } = await sendChat(content);
      setMessages(prev => [...prev, { role: 'assistant', content: reply ?? '', stages }]);
      const id = `c${Date.now()}`;
      setConversations(prev => {
        const exists = prev.some(c => c.title === title);
        return exists ? prev : [...prev, { id, title }];
      });
      setActiveConv(id);
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: '（生成失败：请确认后端服务已启动）' }]);
    } finally {
      setSending(false);
    }
  };

  const handleRegenerate = (index: number) => {
    // 找到该条 assistant 消息对应的用户消息，重新发送
    const userMsg = [...messages].slice(0, index).reverse().find(m => m.role === 'user');
    if (userMsg) void handleSend(userMsg.content);
  };

  const handleTrySkill = (skill: SkillCard) => {
    setInput(`使用技能：${skill.title}。${skill.desc}`);
  };

  const handleNewChat = () => {
    setMessages([]);
    setInput('');
    setActiveConv(null);
  };

  if (error) {
    return (
      <div className="app-error">
        <p>加载失败：{error}</p>
        <p className="app-error-hint">请确认后端服务已启动（pnpm dev）</p>
      </div>
    );
  }

  if (!data) {
    return <div className="app-loading">加载中…</div>;
  }

  const isEmpty = messages.length === 0;

  return (
    <div className="app">
      <Rail items={data.rail.items} activeId={activeNav} onSelect={setActiveNav} />
      <div className="workbench">
        <Sidebar
          createLabel={data.sidebar.createLabel}
          newChatLabel={data.sidebar.newChatLabel}
          conversations={conversations}
          activeId={activeConv}
          onNewChat={handleNewChat}
          onSelect={id => setActiveConv(id)}
        />
        <main className="main">
          {isEmpty ? (
            <div className="generate-empty">
              <h1 className="generate-title">{data.hero.title}</h1>
              <SkillCards skills={data.skills} onTry={handleTrySkill} />
            </div>
          ) : (
            <div className="chat-scroll" ref={chatRef}>
              <ChatView messages={messages} onRegenerate={handleRegenerate} />
              {sending && (
                <div className="chat-row assistant">
                  <div className="chat-avatar">
                    <svg width="28" height="28" viewBox="0 0 40 40" fill="none">
                      <rect width="40" height="40" rx="12" fill="#00cae0" />
                      <rect x="8" y="10" width="24" height="17" rx="3.5" fill="white" />
                      <path d="M8 15.5h24M13 10v5.5M27 10v5.5" stroke="#00a1c2" strokeWidth="1.6" />
                      <path d="m24.5 21.5 3 3-3 3" stroke="#00a1c2" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                      <circle cx="17.5" cy="24.5" r="3" fill="#00a1c2" />
                    </svg>
                  </div>
                  <div className="chat-bubble assistant">
                    <span className="chat-typing">
                      <i /><i /><i />
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
          <div className="composer-wrap">
            <Composer
              placeholder={data.composer.placeholder}
              composer={data.composer}
              value={input}
              onChange={setInput}
              onSubmit={() => handleSend()}
              disabled={sending}
            />
          </div>
        </main>
      </div>
    </div>
  );
}
