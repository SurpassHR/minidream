import { useTranslation } from 'react-i18next';

export interface Conversation {
  id: string;
  title: string;
  updatedAt?: number;
}

function fmtSessionDate(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const pad = (n: number) => String(n).padStart(2, '0');
  if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export default function Sidebar({
  conversations,
  activeId,
  onNewChat,
  onSelect,
  onRename,
  onDelete,
}: {
  conversations: Conversation[];
  activeId: string | null;
  onNewChat: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <aside className="sidebar">
      <button className="sidebar-create" onClick={onNewChat}>
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <path d="M9 3.5v11M3.5 9h11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <span>{t('sidebar.create')}</span>
      </button>
      <div className="sidebar-section">
        <div className="sidebar-section-title">{t('sidebar.newChat')}</div>
        <ul className="sidebar-chats">
          {conversations.length === 0 && (
            <li className="sidebar-chat-empty">{t('sidebar.empty')}</li>
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
                <span className="sidebar-chat-title">{conv.title}</span>
                <span className="sidebar-chat-date">
                  {conv.updatedAt ? fmtSessionDate(conv.updatedAt) : ''}
                </span>
              </button>
              <div className="sidebar-chat-acts">
                <button
                  className="sidebar-chat-act"
                  title={t('sidebar.rename')}
                  onClick={e => {
                    e.stopPropagation();
                    onRename(conv.id);
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
                    <path d="m8.8 2.3 2.9 2.9M9.6 1.5a1.4 1.4 0 0 1 2 2L4 11.1 1.5 12l.9-2.5 7.2-8Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                  </svg>
                </button>
                <button
                  className="sidebar-chat-act danger"
                  title={t('common.delete')}
                  onClick={e => {
                    e.stopPropagation();
                    onDelete(conv.id);
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
                    <path d="M3 4.5h8M6 2.5h2M4.5 4.5l.5 7h4l.5-7M6 6.5v3M8 6.5v3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
