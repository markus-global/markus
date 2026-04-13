import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { supportedLanguages, type SupportedLanguage } from '../../i18n';

/**
 * LanguageSelector - A dropdown language switcher component
 * 
 * Features:
 * - Dropdown menu selection
 * - Shows current language name
 * - Selected state highlighting
 * - Click outside to close
 * - Keyboard accessibility
 */
export function LanguageSelector() {
  const { i18n } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const currentLanguage = supportedLanguages.find(
    (lang) => lang.code === i18n.language
  ) ?? supportedLanguages[0];

  const handleLanguageChange = (code: SupportedLanguage) => {
    i18n.changeLanguage(code);
    setIsOpen(false);
  };

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Close dropdown on escape key
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, []);

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Trigger Button */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg border border-border-default bg-surface-secondary hover:bg-surface-elevated transition-colors min-w-[140px]"
        aria-expanded={isOpen}
        aria-haspopup="listbox"
      >
        <svg
          className="w-4 h-4 text-fg-secondary flex-shrink-0"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129"
          />
        </svg>
        <span className="flex-1 text-left truncate">{currentLanguage.nativeName}</span>
        <svg
          className={`w-4 h-4 text-fg-secondary transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <div
          className="absolute right-0 mt-2 w-48 bg-surface-secondary border border-border-default rounded-lg shadow-lg py-1 z-50"
          role="listbox"
          aria-label="Select language"
        >
          {supportedLanguages.map((lang) => {
            const isSelected = lang.code === i18n.language;
            return (
              <button
                key={lang.code}
                type="button"
                onClick={() => handleLanguageChange(lang.code)}
                className={`w-full flex items-center gap-3 px-3 py-2 text-sm transition-colors ${
                  isSelected
                    ? 'bg-accent-primary/10 text-accent-primary'
                    : 'text-fg-default hover:bg-surface-elevated'
                }`}
                role="option"
                aria-selected={isSelected}
              >
                <span className="flex-1 text-left">{lang.nativeName}</span>
                <span className="text-xs text-fg-secondary">{lang.name}</span>
                {isSelected && (
                  <svg
                    className="w-4 h-4 text-accent-primary flex-shrink-0"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
