import { useTranslation } from 'react-i18next';
import { supportedLanguages, type SupportedLanguage } from '../i18n';

export function LanguageSwitcher() {
  const { i18n } = useTranslation();

  const handleLanguageChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    i18n.changeLanguage(e.target.value as SupportedLanguage);
  };

  return (
    <select
      value={i18n.language}
      onChange={handleLanguageChange}
      className="px-2 py-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-primary)] text-sm"
    >
      {supportedLanguages.map((lang) => (
        <option key={lang.code} value={lang.code}>
          {lang.nativeName}
        </option>
      ))}
    </select>
  );
}
