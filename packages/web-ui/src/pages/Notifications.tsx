import { useTranslation } from 'react-i18next';
import { NotificationBell } from '../components/NotificationBell.tsx';
import { MobileMenuButton } from '../components/MobileMenuButton.tsx';
import { useIsMobile } from '../hooks/useIsMobile.ts';

export function NotificationsPage({ authUser }: { authUser?: { id: string; name: string; role: string; orgId: string } }) {
  const { t } = useTranslation('nav');
  const isMobile = useIsMobile();

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-4 h-14">
        {isMobile && <MobileMenuButton />}
        <h2 className="text-base font-bold">{t('notifications')}</h2>
      </div>
      <div className="flex-1 overflow-hidden">
        <NotificationBell collapsed={false} userId={authUser?.id} embeddedMode />
      </div>
    </div>
  );
}
