import { useTranslation } from 'react-i18next';
import { NotificationBell } from '../components/NotificationBell.tsx';

export function NotificationsPage({ authUser }: { authUser?: { id: string; name: string; role: string; orgId: string } }) {
  const { t } = useTranslation('nav');

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-center px-4 h-14 border-b border-border-default bg-surface-secondary/50">
        <h2 className="text-base font-bold">{t('notifications')}</h2>
      </div>
      <div className="flex-1 overflow-hidden">
        <NotificationBell collapsed={false} userId={authUser?.id} embeddedMode />
      </div>
    </div>
  );
}
