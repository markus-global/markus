import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import HttpBackend from 'i18next-http-backend';

// Supported languages
export const supportedLanguages = [
  { code: 'en', name: 'English', nativeName: 'English' },
  { code: 'zh-CN', name: 'Simplified Chinese', nativeName: '简体中文' },
  { code: 'zh-TW', name: 'Traditional Chinese', nativeName: '繁體中文' },
] as const;

export type SupportedLanguage = (typeof supportedLanguages)[number]['code'];

// Default language
export const defaultLanguage: SupportedLanguage = 'en';

// Configuration for i18next
i18n
  .use(HttpBackend) // Load translations from public/locales/
  .use(LanguageDetector) // Detect user language from browser
  .use(initReactI18next) // Bind react-i18next to React
  .init({
    // Supported languages
    supportedLngs: supportedLanguages.map((lang) => lang.code),
    
    // Default language
    lng: defaultLanguage,
    fallbackLng: defaultLanguage,
    
    // Debug mode (set to false in production)
    debug: false,
    
    // Non-exclusive loading (load all languages)
    ns: ['translation'],
    defaultNS: 'translation',
    
    // Backend configuration
    backend: {
      // Path to translation files
      loadPath: '/locales/{{lng}}/{{ns}}.json',
    },
    
    // Language detector options
    detection: {
      // Order of preference for language detection
      order: ['localStorage', 'navigator', 'htmlTag'],
      // Cache the language choice in localStorage
      caches: ['localStorage'],
      // Storage key for the language preference
      lookupLocalStorage: 'markus-language',
    },
    
    // Interpolation settings (escape by default for React)
    interpolation: {
      escapeValue: false, // React already escapes values
    },
    
    // React options
    react: {
      // Use suspense for loading translations
      useSuspense: true,
    },
  });

export default i18n;
