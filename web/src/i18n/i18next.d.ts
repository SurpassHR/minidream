import 'i18next';
import type zh from './i18n/zh';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: {
      translation: typeof zh;
    };
  }
}
