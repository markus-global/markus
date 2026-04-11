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
  task_created: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8',
  task_status_changed: 'M23 4v6h-6 M1 20v-6h6 M3.51 9a9 9 0 0 1 14.85-3.36L23 10 M1 14l4.64 4.36A9 9 0 0 0 20.49 15',
  requirement_created: 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7 M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z',
  requirement_decision: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  agent_alert: 'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z M12 9v4 M12 17h.01',
  agent_report: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8',
  agent_chat_request: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  agent_escalation: 'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z M12 9v4 M12 17h.01',
  bounty_posted: 'M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z M19 10v2a7 7 0 0 1-14 0v-2',
  mention: 'M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M12.5 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0z M20 8v6 M23 11h-6',
  system: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
};

const TYPE_COLOR: Record<string, string> = {
  task_completed: 'text-green-500',
  task_failed: 'text-red-500',
  task_created: 'text-blue-500',
  task_review: 'text-purple-500',
  task_status_changed: 'text-blue-400',
  requirement_created: 'text-amber-500',
  requirement_decision: 'text-green-500',
  approval_request: 'text-amber-500',
  agent_alert: 'text-red-500',
  agent_escalation: 'text-red-400',
  agent_report: 'text-blue-500',
  agent_chat_request: 'text-brand-500',
  agent_notification: 'text-blue-400',
  bounty_posted: 'text-amber-500',
  mention: 'text-brand-500',
  system: 'text-fg-tertiary',
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

function actionHint(n: NotificationInfo): string | null {
  const actionType = (n as any).actionType;
  if (actionType === 'open_chat') return 'Open chat →';
  if (actionType === 'navigate') return 'View details →';
  const meta = n.metadata ?? {};
  switch (n.type) {
    case 'task_completed': case 'task_created': case 'task_review':
    case 'task_failed': case 'task_status_changed':
      return meta.taskId ? 'View task →' : null;
    case 'requirement_created': case 'requirement_decision':
      return meta.requirementId ? 'View requirement →' : null;
    case 'agent_chat_request':
      return 'Open chat →';
    case 'agent_alert': case 'agent_escalation': case 'agent_notification':
      return meta.agentId ? 'View agent →' : null;
    case 'approval_request':
      return 'View approval →';
    default:
      if (meta.taskId) return 'View task →';
      if (meta.requirementId) return 'View requirement →';
      if (meta.agentId) return 'View agent →';
      return null;
  }
}

export function NotificationBell({ collapsed, userId }: Props) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'approvals' | 'notifications'>('approvals');
  const [notifications, setNotifications] = useState<NotificationInfo[]>([]);
  const [approvals, setApprovals] = useState<ApprovalInfo[]>([]);
  const [responding, setResponding] = useState<string | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
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
      setUnreadCount(n.unreadCount ?? n.notifications.filter((x: NotificationInfo) => !x.read).length);
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

  const pendingApprovals = approvals.filter(a => a.status === 'pending').length;
  const badgeCount = unreadCount + pendingApprovals;

  const handleMarkRead = async (id: string) => {
    await api.notifications.markRead(id);
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
    setUnreadCount(prev => Math.max(0, prev - 1));
  };

  const navigateForNotification = (n: NotificationInfo) => {
    const meta = n.metadata ?? {};
    const actionType = (n as any).actionType;
    const actionTarget = (n as any).actionTarget;

    if (actionType === 'open_chat' && actionTarget) {
      try {
        const target = typeof actionTarget === 'string' ? JSON.parse(actionTarget) : actionTarget;
        if (target.agentId) {
          const params: Record<string, string> = { agentId: target.agentId };
          if (target.sessionId) params.sessionId = target.sessionId;
          navBus.navigate(PAGE.TEAM, params);
          return;
        }
      } catch { /* fallthrough */ }
    }

    if (actionType === 'navigate' && actionTarget) {
      try {
        const target = typeof actionTarget === 'string' ? JSON.parse(actionTarget) : actionTarget;
        if (target.path) {
          if (target.path.startsWith('/work')) {
            const params: Record<string, string> = {};
            const searchParams = new URLSearchParams(target.path.split('?')[1] || '');
            for (const [k, v] of searchParams.entries()) params[k] = v;
            navBus.navigate(PAGE.WORK, params);
            return;
          }
        }
      } catch { /* fallthrough */ }
    }

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
      case 'task_created':
      case 'task_review':
      case 'task_failed':
      case 'task_status_changed':
        if (meta.taskId) navBus.navigate(PAGE.WORK, { openTask: meta.taskId as string });
        else navBus.navigate(PAGE.WORK);
        break;
      case 'requirement_created':
      case 'requirement_decision':
        if (meta.requirementId) navBus.navigate(PAGE.WORK, { openRequirement: meta.requirementId as string });
        else navBus.navigate(PAGE.WORK);
        break;
      case 'agent_chat_request': {
        const params: Record<string, string> = {};
        if (meta.agentId) params.agentId = meta.agentId as string;
        if (meta.sessionId) params.sessionId = meta.sessionId as string;
        navBus.navigate(PAGE.TEAM, Object.keys(params).length > 0 ? params : undefined);
        break;
      }
      case 'agent_notification':
      case 'agent_alert':
      case 'agent_escalation':
        if (meta.agentId) navBus.navigate(PAGE.TEAM, { selectAgent: meta.agentId as string });
        else navBus.navigate(PAGE.TEAM);
        break;
      case 'bounty_posted':
        navBus.navigate(PAGE.SETTINGS);
        break;
      default:
        if (meta.taskId) navBus.navigate(PAGE.WORK, { openTask: meta.taskId as string });
        else if (meta.requirementId) navBus.navigate(PAGE.WORK, { openRequirement: meta.requirementId as string });
        else if (meta.projectId) navBus.navigate(PAGE.WORK, { projectId: meta.projectId as string });
        else if (meta.agentId) navBus.navigate(PAGE.TEAM, { selectAgent: meta.agentId as string });
        break;
    }
  };

  const handleNotificationClick = async (n: NotificationInfo) => {
    if (!n.read) handleMarkRead(n.id);
    navigateForNotification(n);
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
    try {
      await api.notifications.markAllRead(userId ?? 'default');
      setNotifications(prev => prev.map(n => ({ ...n, read: true })));
      setUnreadCount(0);
    } catch {
      const unread = displayNotifications.filter(n => !n.read);
      await Promise.all(unread.map(n => api.notifications.markRead(n.id)));
      setNotifications(prev => prev.map(n => ({ ...n, read: true })));
      setUnreadCount(0);
    }
  };

  const navigateForApproval = (a: ApprovalInfo) => {
    const taskId = a.details?.taskId as string | undefined;
    if (taskId) navBus.navigate(PAGE.WORK, { openTask: taskId });
    else navBus.navigate(PAGE.WORK);
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
          {/* Tabs + Close */}
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
            <button
              onClick={() => setOpen(false)}
              className="px-2 py-2 text-fg-tertiary hover:text-fg-primary transition-colors shrink-0"
              title="Close"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6L6 18" /><path d="M6 6l12 12" />
              </svg>
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
                  {displayNotifications.slice(0, 50).map(n => {
                    const typeColor = TYPE_COLOR[n.type] ?? 'text-fg-tertiary';
                    return (
                    <button
                      key={n.id}
                      onClick={() => handleNotificationClick(n)}
                      className={`w-full text-left px-3 py-2.5 flex gap-2.5 transition-colors ${
                        n.read ? 'opacity-50 hover:opacity-70' : 'hover:bg-surface-overlay'
                      }`}
                    >
                      <div className="shrink-0 mt-0.5">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={typeColor}>
                          <path d={TYPE_ICON[n.type] ?? TYPE_ICON.system} />
                        </svg>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          {!n.read && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${PRIORITY_DOT[n.priority] ?? PRIORITY_DOT.normal}`} />}
                          <span className="text-xs text-fg-primary font-medium truncate">{n.title}</span>
                        </div>
                        <p className="text-[11px] text-fg-tertiary line-clamp-2 mt-0.5">{n.body}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-[10px] text-fg-muted">{timeAgo(n.createdAt)}</span>
                          {actionHint(n) && (
                            <span className={`text-[10px] font-medium ${typeColor}`}>
                              {actionHint(n)}
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                    );
                  })}
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
