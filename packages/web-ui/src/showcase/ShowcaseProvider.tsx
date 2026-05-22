import { useEffect, useMemo, type ReactNode } from 'react';
import { I18nextProvider, useTranslation } from 'react-i18next';
import i18n from '../i18n/index.ts';
import { createMockData, type MockData } from './mockData.ts';

interface ShowcaseProviderProps {
  children: (data: MockData) => ReactNode;
  lang?: string;
}

function ShowcaseContent({ children, lang }: ShowcaseProviderProps) {
  const { t, i18n: i18nInstance } = useTranslation('showcase');

  useEffect(() => {
    if (lang && i18nInstance.language !== lang) {
      const mapped = lang === 'zh' ? 'zh-CN' : lang;
      i18nInstance.changeLanguage(mapped);
    }
  }, [lang, i18nInstance]);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      const docLang = document.documentElement.getAttribute('data-lang');
      if (docLang) {
        const mapped = docLang === 'zh' ? 'zh-CN' : docLang;
        if (i18nInstance.language !== mapped) {
          i18nInstance.changeLanguage(mapped);
        }
      }
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-lang'] });
    return () => observer.disconnect();
  }, [i18nInstance]);

  const mockData = useMemo(() => createMockData(t), [t]);

  return <>{children(mockData)}</>;
}

export function ShowcaseProvider({ children, lang }: ShowcaseProviderProps) {
  return (
    <I18nextProvider i18n={i18n}>
      <ShowcaseContent lang={lang}>
        {children}
      </ShowcaseContent>
    </I18nextProvider>
  );
}
