/**
 * DynamicUIRenderer - Renders external chat UI from a CustomUIConfig.
 *
 * Used by ExternalChat to apply agent-generated UI customizations
 * including theme, layout, and component composition.
 */
import { useState } from 'react';

interface UITheme {
  primaryColor: string;
  backgroundColor?: string;
  textColor?: string;
  fontFamily?: string;
  borderRadius?: string;
  logoUrl?: string;
  faviconUrl?: string;
}

interface UIComponent {
  type: 'chat' | 'form' | 'file-upload' | 'payment' | 'rating' | 'header' | 'footer' | 'custom';
  position: 'header' | 'footer' | 'sidebar' | 'inline' | 'overlay';
  config: Record<string, unknown>;
  showWhen?: 'always' | 'session_start' | 'session_end' | 'custom';
}

interface CustomUIConfig {
  layout: 'fullpage' | 'widget' | 'sidebar';
  theme: UITheme;
  components: UIComponent[];
  welcomeMessage?: string;
  placeholder?: string;
  customCss?: string;
}

interface DynamicUIRendererProps {
  config: CustomUIConfig;
  sessionState: 'not_started' | 'active' | 'ended';
  onFileUpload?: (file: File) => void;
  onFormSubmit?: (data: Record<string, string>) => void;
  onRatingSubmit?: (rating: number) => void;
  children?: React.ReactNode;
}

export function DynamicUIRenderer({
  config,
  sessionState,
  onFileUpload,
  onFormSubmit,
  onRatingSubmit,
  children,
}: DynamicUIRendererProps) {
  const { theme, components, customCss } = config;

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    height: config.layout === 'widget' ? '500px' : '100vh',
    width: config.layout === 'sidebar' ? '360px' : '100%',
    maxWidth: config.layout === 'fullpage' ? '720px' : undefined,
    margin: config.layout === 'fullpage' ? '0 auto' : undefined,
    background: theme.backgroundColor ?? 'var(--surface-primary, #fff)',
    color: theme.textColor ?? 'var(--fg-primary, #1a1a1a)',
    fontFamily: theme.fontFamily ?? 'system-ui, sans-serif',
    borderRadius: config.layout === 'widget' ? theme.borderRadius ?? '12px' : undefined,
    overflow: 'hidden',
    position: 'relative',
  };

  const shouldShow = (comp: UIComponent): boolean => {
    if (!comp.showWhen || comp.showWhen === 'always') return true;
    if (comp.showWhen === 'session_start' && sessionState === 'not_started') return true;
    if (comp.showWhen === 'session_end' && sessionState === 'ended') return true;
    return false;
  };

  const headerComponents = components.filter(c => c.position === 'header' && shouldShow(c));
  const footerComponents = components.filter(c => c.position === 'footer' && shouldShow(c));
  const inlineComponents = components.filter(c => c.position === 'inline' && shouldShow(c) && c.type !== 'chat');
  const overlayComponents = components.filter(c => c.position === 'overlay' && shouldShow(c));

  return (
    <div style={containerStyle}>
      {customCss && <style>{sanitizeCss(customCss)}</style>}

      {headerComponents.map((comp, i) => (
        <DynamicComponent key={`h-${i}`} component={comp} theme={theme} onFileUpload={onFileUpload} onFormSubmit={onFormSubmit} onRatingSubmit={onRatingSubmit} />
      ))}

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {children}

        {inlineComponents.map((comp, i) => (
          <DynamicComponent key={`i-${i}`} component={comp} theme={theme} onFileUpload={onFileUpload} onFormSubmit={onFormSubmit} onRatingSubmit={onRatingSubmit} />
        ))}
      </div>

      {footerComponents.map((comp, i) => (
        <DynamicComponent key={`f-${i}`} component={comp} theme={theme} onFileUpload={onFileUpload} onFormSubmit={onFormSubmit} onRatingSubmit={onRatingSubmit} />
      ))}

      {overlayComponents.map((comp, i) => (
        <div key={`o-${i}`} style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.4)', zIndex: 100 }}>
          <div style={{ background: theme.backgroundColor ?? 'var(--surface-elevated, #fff)', borderRadius: theme.borderRadius ?? '12px', padding: '24px', maxWidth: '90%', width: 360 }}>
            <DynamicComponent component={comp} theme={theme} onFileUpload={onFileUpload} onFormSubmit={onFormSubmit} onRatingSubmit={onRatingSubmit} />
          </div>
        </div>
      ))}
    </div>
  );
}

interface DynamicComponentProps {
  component: UIComponent;
  theme: UITheme;
  onFileUpload?: (file: File) => void;
  onFormSubmit?: (data: Record<string, string>) => void;
  onRatingSubmit?: (rating: number) => void;
}

function DynamicComponent({ component, theme, onFileUpload, onFormSubmit, onRatingSubmit }: DynamicComponentProps) {
  switch (component.type) {
    case 'header':
      return <HeaderComponent config={component.config} theme={theme} />;
    case 'footer':
      return <FooterComponent config={component.config} theme={theme} />;
    case 'file-upload':
      return <FileUploadComponent config={component.config} theme={theme} onUpload={onFileUpload} />;
    case 'rating':
      return <RatingComponent config={component.config} theme={theme} onSubmit={onRatingSubmit} />;
    case 'form':
      return <FormComponent config={component.config} theme={theme} onSubmit={onFormSubmit} />;
    default:
      return null;
  }
}

function HeaderComponent({ config, theme }: { config: Record<string, unknown>; theme: UITheme }) {
  return (
    <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-default, rgba(0,0,0,0.08))', display: 'flex', alignItems: 'center', gap: 10 }}>
      {theme.logoUrl && <img src={theme.logoUrl} alt="" style={{ height: 28 }} />}
      {config['title'] ? <span style={{ fontWeight: 600, fontSize: 15 }}>{String(config['title'])}</span> : null}
    </div>
  );
}

function FooterComponent({ config, theme }: { config: Record<string, unknown>; theme: UITheme }) {
  return (
    <div style={{ padding: '8px 16px', borderTop: '1px solid var(--border-default, rgba(0,0,0,0.08))', textAlign: 'center', fontSize: 12, opacity: 0.6 }}>
      {config['text'] ? String(config['text']) : 'Powered by Markus'}
    </div>
  );
}

function FileUploadComponent({ config, theme, onUpload }: { config: Record<string, unknown>; theme: UITheme; onUpload?: (file: File) => void }) {
  const accept = (config['accept'] as string) ?? '*';
  return (
    <div style={{ padding: '8px 16px' }}>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', border: '1px solid var(--border-default, rgba(0,0,0,0.15))', borderRadius: theme.borderRadius ?? '8px', cursor: 'pointer', fontSize: 13 }}>
        <span>📎 Attach file</span>
        <input
          type="file"
          accept={accept}
          style={{ display: 'none' }}
          onChange={e => { const f = e.target.files?.[0]; if (f && onUpload) onUpload(f); }}
        />
      </label>
    </div>
  );
}

function RatingComponent({ config, theme, onSubmit }: { config: Record<string, unknown>; theme: UITheme; onSubmit?: (rating: number) => void }) {
  const [selected, setSelected] = useState<number | null>(null);
  const scale = (config['scale'] as number) ?? 5;
  const label = (config['label'] as string) ?? 'Rate your experience';

  return (
    <div style={{ padding: '16px', textAlign: 'center' }}>
      <p style={{ margin: '0 0 12px', fontSize: 14 }}>{label}</p>
      <div style={{ display: 'flex', justifyContent: 'center', gap: 8 }}>
        {Array.from({ length: scale }, (_, i) => (
          <button
            key={i}
            onClick={() => { setSelected(i + 1); onSubmit?.(i + 1); }}
            style={{
              width: 36, height: 36, borderRadius: '50%', border: 'none',
              background: selected === i + 1 ? theme.primaryColor : 'var(--surface-secondary, rgba(0,0,0,0.06))',
              color: selected === i + 1 ? '#fff' : theme.textColor ?? 'var(--fg-primary, #333)',
              cursor: 'pointer', fontWeight: 600, fontSize: 14,
            }}
          >
            {i + 1}
          </button>
        ))}
      </div>
      {selected && <p style={{ margin: '8px 0 0', fontSize: 12, opacity: 0.7 }}>Thanks for your feedback!</p>}
    </div>
  );
}

function FormComponent({ config, theme, onSubmit }: { config: Record<string, unknown>; theme: UITheme; onSubmit?: (data: Record<string, string>) => void }) {
  const fields = (config['fields'] as string[]) ?? [];
  const submitLabel = (config['submitLabel'] as string) ?? 'Submit';
  const [values, setValues] = useState<Record<string, string>>({});

  return (
    <div style={{ padding: '12px 16px' }}>
      {fields.map(field => (
        <div key={field} style={{ marginBottom: 8 }}>
          <label style={{ display: 'block', fontSize: 12, marginBottom: 4, textTransform: 'capitalize' }}>{field}</label>
          <input
            type="text"
            value={values[field] ?? ''}
            onChange={e => setValues(prev => ({ ...prev, [field]: e.target.value }))}
            style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--border-default, rgba(0,0,0,0.15))', borderRadius: theme.borderRadius ?? '6px', fontSize: 14, boxSizing: 'border-box', background: 'var(--surface-primary, #fff)', color: 'inherit' }}
          />
        </div>
      ))}
      <button
        onClick={() => onSubmit?.(values)}
        style={{ marginTop: 8, padding: '8px 16px', background: theme.primaryColor, color: '#fff', border: 'none', borderRadius: theme.borderRadius ?? '8px', cursor: 'pointer', fontSize: 14 }}
      >
        {submitLabel}
      </button>
    </div>
  );
}

function sanitizeCss(css: string): string {
  return css
    .replace(/<[^>]*>/g, '')
    .replace(/expression\s*\(/gi, '')
    .replace(/javascript\s*:/gi, '')
    .replace(/@import/gi, '')
    .replace(/url\s*\(\s*['"]?javascript/gi, '');
}

export default DynamicUIRenderer;
