export interface Conversation {
  id: string;
  title: string;
}

export default function Sidebar({
  createLabel,
  newChatLabel,
  conversations,
  activeId,
  onNewChat,
  onSelect,
}: {
  createLabel: string;
  newChatLabel: string;
  conversations: Conversation[];
  activeId: string | null;
  onNewChat: () => void;
  onSelect: (id: string) => void;
}) {
  return (
    <aside className="sidebar">
      <button className="sidebar-create" onClick={onNewChat}>
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <path d="M9 3.5v11M3.5 9h11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <span>{createLabel}</span>
      </button>
      <div className="sidebar-section">
        <div className="sidebar-section-title">{newChatLabel}</div>
        <ul className="sidebar-chats">
          {conversations.length === 0 && (
            <li className="sidebar-chat-empty">暂无对话，开启你的第一部作品</li>
          )}
          {conversations.map(conv => (
            <li key={conv.id}>
              <button
                className={`sidebar-chat${activeId === conv.id ? ' active' : ''}`}
                onClick={() => onSelect(conv.id)}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <rect x="2" y="2.5" width="10" height="8" rx="2" stroke="currentColor" strokeWidth="1.2" />
                  <path d="M4.5 6h5M4.5 8.2h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                </svg>
                <span>{conv.title}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
