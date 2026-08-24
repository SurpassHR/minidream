import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import type { RailItem } from '../api';

function RailIcon({ id }: { id: string }) {
  const common = {
    width: 20,
    height: 20,
    viewBox: '0 0 20 20',
    fill: 'none',
  } as const;
  const stroke = {
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  } as const;
  switch (id) {
    case 'inspiration':
      // 灵感：灯泡
      return (
        <svg {...common} {...stroke}>
          <path d="M7 7.5a5 5 0 0 1 10 0c0 1.6-.8 2.8-1.5 3.8-.5.7-.8 1.2-.9 2h-5.2c-.1-.8-.4-1.3-.9-2-.7-1-1.5-2.2-1.5-3.8Z" />
          <path d="M8.8 15.2h4.4" />
          <path d="M9.9 17.7h2.2" />
        </svg>
      );
    case 'generate':
      // 生成：魔法棒 + 星芒
      return (
        <svg {...common}>
          <path d="M11.5 2.2l.8 2.1 2.1.8-2.1.8-.8 2.1-.8-2.1-2.1-.8 2.1-.8.8-2.1Z" fill="currentColor" />
          <path d="M14.6 8.4 6.4 16.6" {...stroke} />
        </svg>
      );
    case 'drafts':
      // 草稿：文档（与资产文件夹区分）
      return (
        <svg {...common} {...stroke}>
          <path d="M13 2.5H6.5A1.5 1.5 0 0 0 5 4v12a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 15 16V5.5L13 2.5Z" />
          <path d="M13 2.5v3h3" />
          <path d="M7.5 10.5h5M7.5 13h5M7.5 15.5h3" />
        </svg>
      );
    case 'assets':
      // 资产：文件夹 + 播放（图像/视频素材库）
      return (
        <svg {...common}>
          <path d="M2.8 6.6c0-.8.6-1.4 1.4-1.4h3l1.6 1.7h6.8c.8 0 1.4.6 1.4 1.4v6.7c0 .8-.6 1.4-1.4 1.4H4.2c-.8 0-1.4-.6-1.4-1.4V6.6Z" {...stroke} />
          <path d="M8.6 10.4v3.2l2.8-1.6-2.8-1.6Z" fill="currentColor" />
        </svg>
      );
    case 'canvas':
      // 画布：四宫格
      return (
        <svg {...common} {...stroke}>
          <rect x="3.2" y="3.2" width="5.6" height="5.6" rx="1.4" />
          <rect x="11.2" y="3.2" width="5.6" height="5.6" rx="1.4" />
          <rect x="3.2" y="11.2" width="5.6" height="5.6" rx="1.4" />
          <rect x="11.2" y="11.2" width="5.6" height="5.6" rx="1.4" />
        </svg>
      );
    default:
      return null;
  }
}

export default function Rail({
  items,
  activeId,
  onSelect,
  theme,
  onToggleTheme,
  onOpenSettings,
}: {
  items: RailItem[];
  activeId: string;
  onSelect: (id: string) => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onOpenSettings: () => void;
}) {
  const { t } = useTranslation();
  const lang = i18n.language === 'zh' ? 'zh' : 'en';
  const toggleLang = () => void i18n.changeLanguage(lang === 'zh' ? 'en' : 'zh');

  return (
    <nav className="rail" aria-label={t('nav.aria')}>
      <div className="rail-logo" aria-label={t('nav.logoAria')}>
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
              title={t(`nav.${item.id}` as 'nav.unknown', { defaultValue: item.label })}
            >
              <RailIcon id={item.icon} />
              <span>{t(`nav.${item.id}` as 'nav.unknown', { defaultValue: item.label })}</span>
            </button>
          </li>
        ))}
      </ul>
      <button
        className="rail-lang"
        onClick={toggleLang}
        title={lang === 'zh' ? t('nav.switchToEn') : t('nav.switchToZh')}
        aria-label={lang === 'zh' ? t('nav.switchToEn') : t('nav.switchToZh')}
      >
        {lang === 'zh' ? 'EN' : '中'}
      </button>
      <button
        className="rail-theme"
        onClick={onToggleTheme}
        title={theme === 'dark' ? t('nav.lightMode') : t('nav.darkMode')}
        aria-label={theme === 'dark' ? t('nav.lightMode') : t('nav.darkMode')}
      >
        {theme === 'dark' ? (
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <circle cx="10" cy="10" r="3.2" stroke="currentColor" strokeWidth="1.4" />
            <path
              d="M10 2.5v1.8M10 15.7v1.8M4.2 5.4 5.5 6.7M14.5 13.3l1.3 1.3M2.5 10h1.8M15.7 10h1.8M4.2 14.6l1.3-1.3M14.5 6.7l1.3-1.3"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        ) : (
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M17 11.5A7 7 0 0 1 8.5 3a7 7 0 1 0 8.5 8.5Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          </svg>
        )}
      </button>
      <button className="rail-settings" onClick={onOpenSettings} title={t('common.settings')} aria-label={t('common.settings')}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
    </nav>
  );
}
