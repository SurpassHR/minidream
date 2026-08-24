import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import zh from './zh';
import en from './en';

/** localStorage 持久化 key */
export const LANGUAGE_KEY = 'app.language';

function detectLanguage(): 'zh' | 'en' {
  const saved = localStorage.getItem(LANGUAGE_KEY);
  if (saved === 'zh' || saved === 'en') return saved;
  return navigator.language?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

void i18n.use(initReactI18next).init({
  resources: {
    zh: { translation: zh },
    en: { translation: en },
  },
  lng: detectLanguage(),
  fallbackLng: 'zh',
  interpolation: {
    // React 自身已做 XSS 转义，无需 i18next 再转义
    escapeValue: false,
  },
});

// 持久化 + 同步 <html lang>
i18n.on('languageChanged', lng => {
  localStorage.setItem(LANGUAGE_KEY, lng);
  document.documentElement.lang = lng;
});
document.documentElement.lang = i18n.language;

export default i18n;
