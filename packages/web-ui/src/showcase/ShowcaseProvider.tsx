import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { I18nextProvider, useTranslation } from 'react-i18next';
import i18n from '../i18n/index.ts';
import { createMockData, type MockData } from './mockData.ts';
import { ForceDesktopContext } from '../hooks/useIsMobile.ts';

interface ShowcaseProviderProps {
  children: (data: MockData) => ReactNode;
  lang?: string;
}

function ShowcaseContent({ children, lang }: ShowcaseProviderProps) {
  const { t, i18n: i18nInstance } = useTranslation('showcase');
  const [currentLang, setCurrentLang] = useState(() => i18nInstance.language);

  useEffect(() => {
    if (lang) {
      const mapped = lang === 'zh' ? 'zh-CN' : lang;
      if (i18nInstance.language !== mapped) {
        i18nInstance.changeLanguage(mapped);
      }
    }
  }, [lang, i18nInstance]);

  useEffect(() => {
    const syncLang = () => {
      const docLang = document.documentElement.getAttribute('data-lang');
      if (docLang) {
        const mapped = docLang === 'zh' ? 'zh-CN' : docLang;
        if (i18nInstance.language !== mapped) {
          i18nInstance.changeLanguage(mapped);
        }
        setCurrentLang(mapped);
      }
    };
    syncLang();
    const observer = new MutationObserver(syncLang);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-lang'] });
    return () => observer.disconnect();
  }, [i18nInstance]);

  useEffect(() => {
    const handler = (lng: string) => setCurrentLang(lng);
    i18nInstance.on('languageChanged', handler);
    return () => { i18nInstance.off('languageChanged', handler); };
  }, [i18nInstance]);

  const mockData = useMemo(() => createMockData(t), [t, currentLang]);

  return <>{children(mockData)}</>;
}

export function ShowcaseProvider({ children, lang }: ShowcaseProviderProps) {
  return (
    <ForceDesktopContext.Provider value={true}>
      <I18nextProvider i18n={i18n}>
        <ShowcaseContent lang={lang}>
          {children}
        </ShowcaseContent>
      </I18nextProvider>
    </ForceDesktopContext.Provider>
  );
}
