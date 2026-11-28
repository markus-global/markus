/**
 * Locale helpers — the single place that answers "what language is this host /
 * user running in?".
 *
 * Used to internationalize generated *display* strings (e.g. the name of the
 * default Secretary agent) so a first-run user never sees an English name in a
 * non-English environment.
 */

/** Reduce a BCP-47 / POSIX locale to its bare language subtag ('zh-CN' → 'zh'). */
export function normalizeLanguage(locale?: string): string {
  if (!locale) return 'en';
  const lang = locale.toLowerCase().trim().split(/[-_]/, 1)[0];
  return lang || 'en';
}

/**
 * Best-effort locale of the machine running Markus. Node's `Intl` reflects the
 * OS/`LANG` setting; we fall back to the raw POSIX env vars, then to 'en'.
 */
export function resolveHostLocale(): string {
  try {
    const l = Intl.DateTimeFormat().resolvedOptions().locale;
    if (l) return l;
  } catch { /* Intl unavailable — fall through */ }
  return process.env['LC_ALL'] || process.env['LC_MESSAGES'] || process.env['LANG'] || 'en';
}

/* ────────────────────────────────────────────────────────────────────────────
 * UI locale — ONE resolver for every surface
 *
 * Before this existed, "which language is the user in?" had three answers:
 * the web UI read its own preference, the desktop main process read the OS
 * locale (`app.getLocale()`), and splash.html read `navigator.language`. A user
 * who picked English in Settings on a Chinese macOS therefore got an English
 * app behind a Chinese splash screen.
 *
 * Rule, exactly as specified by the owner (2026-11-28):
 *   1. an explicit user choice wins (Settings → Appearance → Language)
 *   2. otherwise the operating-system locale decides (first run)
 *   3. otherwise English
 * ──────────────────────────────────────────────────────────────────────────── */

export const SUPPORTED_UI_LOCALES = ['en', 'zh-CN', 'es'] as const;
export type UiLocale = (typeof SUPPORTED_UI_LOCALES)[number];

/** Match a BCP-47 tag to a supported locale by language subtag ('zh-Hans-CN' → 'zh-CN'). */
function matchSupported(locale: string | null | undefined): UiLocale | null {
  if (!locale) return null;
  const tag = locale.toLowerCase().trim().replace(/_/g, '-');
  for (const supported of SUPPORTED_UI_LOCALES) {
    if (tag === supported.toLowerCase()) return supported;
  }
  const bare = normalizeLanguage(tag);
  if (bare === 'zh') return 'zh-CN';
  if (bare === 'es') return 'es';
  if (bare === 'en') return 'en';
  return null;
}

/**
 * Resolve the locale every surface should use. `preferred` is the stored user
 * choice (may be empty); `osLocale` is `app.getLocale()` / `navigator.language`.
 */
export function resolveUiLocale(preferred?: string | null, osLocale?: string | null): UiLocale {
  return matchSupported(preferred) ?? matchSupported(osLocale) ?? 'en';
}

/**
 * Copy for the desktop's own surfaces (boot screen, and anything else that must
 * render before the web UI exists).
 *
 * This table is the ONLY owner of those strings: splash.html deliberately ships
 * with no words in it and the main process injects them, so a language can never
 * be "half" applied to that screen again.
 */
export interface SplashCopy {
  subtitle: string;
  statuses: { boot: string; config: string; llm: string; services: string; ready: string };
  tips: string[];
}

export const SPLASH_COPY: Record<UiLocale, SplashCopy> = {
  en: {
    subtitle: 'Digital Workforce',
    statuses: {
      boot: 'Preparing Markus…',
      config: 'Loading your settings…',
      llm: 'Connecting your models…',
      services: 'Restoring agents and workspaces…',
      ready: 'Opening your workspace…',
    },
    tips: [
      '<b>⌘K</b> to search agents, tasks and docs',
      '<b>⌘/</b> for all keyboard shortcuts',
      'Agents are restoring their context in the background',
      'Open browser and terminal side by side: <b>⌘B</b>',
      'First upgrade checks the database — large ones take a few minutes',
    ],
  },
  'zh-CN': {
    subtitle: '数字劳动力平台',
    statuses: {
      boot: '正在准备 Markus…',
      config: '正在加载你的设置…',
      llm: '正在连接模型服务…',
      services: '正在恢复智能体与工作区…',
      ready: '正在打开工作区…',
    },
    tips: [
      '<b>⌘K</b> 打开全局搜索，找人、找任务、找文档',
      '<b>⌘/</b> 查看全部快捷键',
      'Agent 正在恢复上下文，稍后即可继续对话',
      '右侧栏可并排打开浏览器与终端：<b>⌘B</b>',
      '首次升级会检查数据库，大库可能需要几分钟',
    ],
  },
  es: {
    subtitle: 'Fuerza laboral digital',
    statuses: {
      boot: 'Preparando Markus…',
      config: 'Cargando tu configuración…',
      llm: 'Conectando tus modelos…',
      services: 'Restaurando agentes y espacios de trabajo…',
      ready: 'Abriendo tu espacio de trabajo…',
    },
    tips: [
      '<b>⌘K</b> para buscar agentes, tareas y documentos',
      '<b>⌘/</b> para ver todos los atajos',
      'Los agentes están restaurando su contexto en segundo plano',
      'Abre navegador y terminal en paralelo: <b>⌘B</b>',
      'La primera actualización revisa la base de datos; una grande tarda unos minutos',
    ],
  },
};

/** Copy for one boot stage; unknown stages fall back to the neutral "boot" line. */
export function splashStatus(locale: UiLocale, stage: string): string {
  const copy = SPLASH_COPY[locale];
  return (copy.statuses as Record<string, string>)[stage] ?? copy.statuses.boot;
}
