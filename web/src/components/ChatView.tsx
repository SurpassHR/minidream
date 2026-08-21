import type { ChatMessage } from '../api';

export default function ChatView({ messages }: { messages: ChatMessage[] }) {
  return (
    <div className="chat">
      {messages.map((m, i) =>
        m.role === 'user' ? (
          <div key={i} className="chat-row user">
            <div className="chat-bubble user">{m.content}</div>
          </div>
        ) : (
          <div key={i} className="chat-row assistant">
            <div className="chat-avatar">
              <svg width="28" height="28" viewBox="0 0 40 40" fill="none">
                <rect width="40" height="40" rx="12" fill="#00cae0" />
                <rect x="8" y="10" width="24" height="17" rx="3.5" fill="white" />
                <path d="M8 15.5h24M13 10v5.5M27 10v5.5" stroke="#00a1c2" strokeWidth="1.6" />
                <path d="m24.5 21.5 3 3-3 3" stroke="#00a1c2" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                <circle cx="17.5" cy="24.5" r="3" fill="#00a1c2" />
              </svg>
            </div>
            <div className="chat-bubble assistant">{m.content}</div>
          </div>
        ),
      )}
    </div>
  );
}
