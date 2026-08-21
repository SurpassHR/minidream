import type { RailItem } from '../api';

function RailIcon({ id }: { id: string }) {
  const common = {
    width: 20,
    height: 20,
    viewBox: '0 0 20 20',
    fill: 'none',
  };
  switch (id) {
    case 'inspiration':
      return (
        <svg {...common}>
          <path d="M10 2.5v1.8M10 15.7v1.8M4.2 5.4 5.5 6.7M14.5 13.3l1.3 1.3M2.5 10h1.8M15.7 10h1.8M4.2 14.6l1.3-1.3M14.5 6.7l1.3-1.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          <circle cx="10" cy="10" r="3.2" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      );
    case 'generate':
      return (
        <svg {...common}>
          <path d="m13 3 .9 2.1L16 6l-2.1.9L13 9l-.9-2.1L10 6l2.1-.9L13 3Z" fill="currentColor" />
          <path d="m7 11 .7 1.6 1.6.7-1.6.7L7 15.6l-.7-1.6-1.6-.7 1.6-.7L7 11Z" fill="currentColor" />
          <path d="M15.5 12.5v2.5M15.5 15v2.5M14.2 13.8h2.6M14.2 16.3h2.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      );
    case 'assets':
      return (
        <svg {...common}>
          <path d="M3 5.5A1.5 1.5 0 0 1 4.5 4h3l1.6 1.8h5.4A1.5 1.5 0 0 1 16 7.3v7.2a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 3 14.5v-9Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M3 8h13" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      );
    case 'canvas':
      return (
        <svg {...common}>
          <rect x="3" y="3" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
          <rect x="11" y="3" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
          <rect x="3" y="11" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
          <rect x="11" y="11" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      );
    default:
      return null;
  }
}

export default function Rail({
  items,
  loginLabel,
  pointsLabel,
  activeId,
  onSelect,
}: {
  items: RailItem[];
  loginLabel: string;
  pointsLabel: string;
  activeId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <nav className="rail" aria-label="主导航">
      <div className="rail-logo" aria-label="导演工作台">
        <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
          <rect width="40" height="40" rx="12" fill="#00cae0" />
          <rect x="8" y="10" width="24" height="17" rx="3.5" fill="white" />
          <path d="M8 15.5h24M13 10v5.5M27 10v5.5" stroke="#00a1c2" strokeWidth="1.6" />
          <path d="m24.5 21.5 3 3-3 3" stroke="#00a1c2" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="17.5" cy="24.5" r="3" fill="#00a1c2" />
        </svg>
      </div>
      <ul className="rail-menu">
        {items.map(item => (
          <li key={item.id}>
            <button
              className={`rail-item${activeId === item.id ? ' active' : ''}`}
              onClick={() => onSelect(item.id)}
              title={item.label}
            >
              <RailIcon id={item.icon} />
              <span>{item.label}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="rail-bottom">
        <button className="rail-login">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <circle cx="9" cy="6.5" r="3" stroke="currentColor" strokeWidth="1.3" />
            <path d="M3.5 15c1.1-2.4 3-3.4 5.5-3.4s4.4 1 5.5 3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          <span>{loginLabel}</span>
          <span className="rail-points">{pointsLabel}</span>
        </button>
      </div>
    </nav>
  );
}
