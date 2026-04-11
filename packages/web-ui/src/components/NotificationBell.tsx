import { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { api, type NotificationInfo, type ApprovalInfo } from '../api.ts';
import { navBus } from '../navBus.ts';
import { PAGE } from '../routes.ts';

interface Props {
  collapsed?: boolean;
  userId?: string;
}

const PRIORITY_DOT: Record<string, string> = {
  urgent: 'bg-red-500',
  high: 'bg-amber-500',
  normal: 'bg-blue-500',
  low: 'bg-gray-400',
};

const TYPE_ICON: Record<string, string> = {
  approval_request: 'M9 12l2 2 4-4 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  task_completed: 'M22 11.08V12a10 10 0 1 1-5.93-9.14 M22 4L12 14.01l-3-3',
  agent_alert: 'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z M12 9v4 M12 17h.01',
  bounty_posted: 'M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z M19 10v2a7 7 0 0 1-14 0v-2',
  system: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

export function NotificationBell({ collapsed, userId }: Props) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'approvals' | 'notifications'>('approvals');
  const [notifications, setNotifications] = useState<NotificationInfo[]>([]);
  const [approvals, setApprovals] = useState<ApprovalInfo[]>([]);
  const [responding, setResponding] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  const fetchData = useCallback(async () => {
    try {
      const [n, a] = await Promise.all([
        api.notifications.list(userId, false),
        api.approvals.list(),
      ]);
      setNotifications(n.notifications);
      setApprovals(a.approvals);
    } catch { /* */ }
  }, [userId]);

  useEffect(() => {
    fetchData();
    const timer = setInterval(fetchData, 15000);
    const onChanged = () => fetchData();
    window.addEventListener('markus:notifications-changed', onChanged);
    return () => { clearInterval(timer); window.removeEventListener('markus:notifications-changed', onChanged); };
  }, [fetchData]);

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    setPos({ top: rect.top, left: rect.right + 8 });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (
        btnRef.current?.contains(e.target as Node) ||
        panelRef.current?.contains(e.target as Node)
      ) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const approvalIds = new Set(approvals.map(a => a.id));
  const displayNotifications = notifications.filter(n => {
    if (n.type === 'approval_request' && n.metadata?.approvalId && approvalIds.has(n.metadata.approvalId as string)) {
      return false;
    }
    return true;
  });

  const unreadCount = displayNotifications.filter(n => !n.read).length;
  const pendingApprovals = approvals.filter(a => a.status === 'pending').length;
  const badgeCount = unreadCount + pendingApprovals;

  const handleMarkRead = async (id: string) => {
    await api.notifications.markRead(id);
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
  };

  const navigateForNotification = (n: NotificationInfo) => {
    const meta = n.metadata ?? {};
    switch (n.type) {
      case 'approval_request': {
        const approvalId = meta.approvalId as string | undefined;
        const approval = approvalId ? approvals.find(a => a.id === approvalId) : undefined;
        const taskId = (approval?.details?.taskId ?? meta.taskId) as string | undefined;
        if (taskId) navBus.navigate(PAGE.WORK, { openTask: taskId });
        else navBus.navigate(PAGE.WORK);
        break;
      }
      case 'task_completed':
        if (meta.taskId) navBus.navigate(PAGE.WORK, { openTask: meta.taskId as string });
        else navBus.navigate(PAGE.WORK);
        break;
      case 'agent_alert':
        if (meta.agentId) navBus.navigate(PAGE.TEAM, { selectAgent: meta.agentId as string });
        else navBus.navigate(PAGE.TEAM);
        break;
      case 'bounty_posted':
        navBus.navigate(PAGE.SETTINGS);
        break;
      default:
        if (meta.taskId) navBus.navigate(PAGE.WORK, { openTask: meta.taskId as string });
        else if (meta.projectId) navBus.navigate(PAGE.WORK, { projectId: meta.projectId as string });
        else if (meta.agentId) navBus.navigate(PAGE.TEAM, { selectAgent: meta.agentId as string });
        break;
    }
  };

  const handleNotificationClick = async (n: NotificationInfo) => {
    if (!n.read) handleMarkRead(n.id);
    navigateForNotification(n);
    setOpen(false);
  };

  const handleApprovalResponse = async (id: string, approved: boolean) => {
    setResponding(id);
    try {
      const { approval } = await api.approvals.respond(id, approved, userId);
      setApprovals(prev => prev.map(a => a.id === id ? approval : a));

      const relatedNotif = notifications.find(
        n => n.type === 'approval_request' && n.metadata?.approvalId === id
      );
      if (relatedNotif && !relatedNotif.read) {
        api.notifications.markRead(relatedNotif.id);
        setNotifications(prev => prev.map(n => n.id === relatedNotif.id ? { ...n, read: true } : n));
      }
      window.dispatchEvent(new CustomEvent('markus:notifications-changed'));
    } catch { /* */ }
    setResponding(null);
  };

  const handleMarkAllRead = async () => {
    const unread = displayNotifications.filter(n => !n.read);
    await Promise.all(unread.map(n => api.notifications.markRead(n.id)));
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
  };

  const navigateForApproval = (a: ApprovalInfo) => {
    const taskId = a.details?.taskId as string | undefined;
    if (taskId) navBus.navigate(PAGE.WORK, { openTask: taskId });
    else navBus.navigate(PAGE.WORK);
    setOpen(false);
  };

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => { setOpen(!open); if (!open) fetchData(); }}
        className={`relative flex items-center justify-center rounded-md transition-colors ${
          collapsed ? 'w-8 h-8' : 'w-7 h-7'
        } ${open ? 'bg-surface-overlay text-fg-primary' : 'text-fg-tertiary hover:text-fg-secondary hover:bg-surface-overlay'}`}
        title="Notifications"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {badgeCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center leading-none">
            {badgeCount > 99 ? '99+' : badgeCount}
          </span>
        )}
      </button>

      {open && createPortal(
        <div ref={panelRef} className="fixed w-80 max-h-[28rem] bg-surface-secondary border border-border-default rounded-xl shadow-2xl z-[9999] flex flex-col overflow-hidden" style={{ top: pos.top, left: pos.left }}>
          {/* Tabs */}
          <div className="flex border-b border-border-default shrink-0">
            <button
              onClick={() => setTab('approvals')}
              className={`flex-1 px-3 py-2.5 text-xs font-medium transition-colors ${
                tab === 'approvals' ? 'text-fg-primary border-b-2 border-brand-500' : 'text-fg-tertiary hover:text-fg-secondary'
              }`}
            >
              Approvals{pendingApprovals > 0 ? ` (${pendingApprovals})` : ''}
            </button>
            <button
              onClick={() => setTab('notifications')}
              className={`flex-1 px-3 py-2.5 text-xs font-medium transition-colors ${
                tab === 'notifications' ? 'text-fg-primary border-b-2 border-brand-500' : 'text-fg-tertiary hover:text-fg-secondary'
              }`}
            >
              Notifications{unreadCount > 0 ? ` (${unreadCount})` : ''}
            </button>
          </div>

          {/* Actions bar */}
          {tab === 'notifications' && unreadCount > 0 && (
            <div className="flex justify-end px-3 py-1.5 border-b border-border-default/50 shrink-0">
              <button onClick={handleMarkAllRead} className="text-[10px] text-brand-500 hover:text-brand-400 transition-colors">Mark all read</button>
            </div>
          )}

          {/* Content */}
          <div className="flex-1 overflow-y-auto">
            {tab === 'approvals' && (
              approvals.length === 0 ? (
                <div className="p-6 text-center text-xs text-fg-tertiary">No approval requests</div>
              ) : (
                <div className="divide-y divide-border-default/50">
                  {approvals.filter(a => a.status === 'pending').map(a => (
                    <div key={a.id} className="px-3 py-3 space-y-2">
                      <button onClick={() => navigateForApproval(a)} className="w-full text-left flex items-start gap-2 hover:bg-surface-overlay rounded transition-colors">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-amber-500 mt-0.5 shrink-0">
                          <path d={TYPE_ICON.approval_request} />
                        </svg>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs text-fg-primary font-medium">{a.title}</div>
                          <div className="text-[11px] text-fg-tertiary mt-0.5">{a.agentName} &middot; {timeAgo(a.requestedAt)}</div>
                          <p className="text-[11px] text-fg-secondary mt-1 line-clamp-3">{a.description}</p>
                        </div>
                      </button>
                      <div className="flex gap-2 pl-5">
                        <button
                          disabled={responding === a.id}
                          onClick={() => handleApprovalResponse(a.id, true)}
                          className="flex-1 px-2.5 py-1.5 text-[11px] font-medium bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50 transition-colors"
                        >Approve</button>
                        <button
                          disabled={responding === a.id}
                          onClick={() => handleApprovalResponse(a.id, false)}
                          className="flex-1 px-2.5 py-1.5 text-[11px] font-medium border border-border-default text-fg-secondary rounded-md hover:bg-surface-overlay disabled:opacity-50 transition-colors"
                        >Reject</button>
                      </div>
                    </div>
                  ))}
                  {approvals.filter(a => a.status !== 'pending').slice(0, 20).map(a => (
                    <button key={a.id} onClick={() => navigateForApproval(a)} className="w-full text-left px-3 py-2.5 opacity-50 hover:opacity-70 transition-colors">
                      <div className="flex items-center gap-2">
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${a.status === 'approved' ? 'bg-green-500' : 'bg-red-500'}`} />
                        <span className="text-xs text-fg-secondary truncate flex-1">{a.title}</span>
                        <span className="text-[10px] text-fg-tertiary shrink-0">{a.status}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )
            )}

            {tab === 'notifications' && (
              displayNotifications.length === 0 ? (
                <div className="p-6 text-center text-xs text-fg-tertiary">No notifications</div>
              ) : (
                <div className="divide-y divide-border-default/50">
                  {displayNotifications.slice(0, 50).map(n => (
                    <button
                      key={n.id}
                      onClick={() => handleNotificationClick(n)}
                      className={`w-full text-left px-3 py-2.5 flex gap-2.5 transition-colors ${
                        n.read ? 'opacity-50 hover:opacity-70' : 'hover:bg-surface-overlay'
                      }`}
                    >
                      <div className="shrink-0 mt-0.5">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-fg-tertiary">
                          <path d={TYPE_ICON[n.type] ?? TYPE_ICON.system} />
                        </svg>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          {!n.read && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${PRIORITY_DOT[n.priority] ?? PRIORITY_DOT.normal}`} />}
                          <span className="text-xs text-fg-primary font-medium truncate">{n.title}</span>
                        </div>
                        <p className="text-[11px] text-fg-tertiary line-clamp-2 mt-0.5">{n.body}</p>
                        <span className="text-[10px] text-fg-muted mt-0.5">{timeAgo(n.createdAt)}</span>
                      </div>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-fg-muted shrink-0 mt-1 opacity-0 group-hover:opacity-100">
                        <polyline points="9 18 15 12 9 6" />
                      </svg>
                    </button>
                  ))}
                </div>
              )
            )}
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
