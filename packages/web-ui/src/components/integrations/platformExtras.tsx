/**
 * Front-end extras registry — the *opt-in* richer panel a platform can add.
 *
 * The manifest is pure data serialised over HTTP, so it cannot carry a React
 * render function. The extras slot therefore lives here, keyed by platform id:
 * a platform with an entry gets its extra panel, a platform without one gets
 * the plain generic card and nothing else.
 *
 * `ownedFields` keeps the "one writer per field" rule intact: a field listed
 * here is rendered by the platform's own panel (e.g. a chat picker instead of a
 * free-text box), so the generic form omits it.
 */
import type { PlatformExtras } from '../../lib/platformIntegrations.ts';
import { FeishuExtras } from './FeishuExtras.tsx';

export const PLATFORM_EXTRAS: Record<string, PlatformExtras> = {
  feishu: {
    // The notification-forwarding knobs are rendered together as one panel with
    // the chat picker, rather than scattered through the generic form.
    ownedFields: ['notifyChatId', 'notifyOnApproval', 'notifyOnNotification', 'notifyPriority'],
    // Lift the panel above the generic form: its scan-to-create QR is the
    // recommended first path and must be seen before the manual credentials.
    placement: 'before',
    render: (ctx) => <FeishuExtras ctx={ctx} />,
  },
};
