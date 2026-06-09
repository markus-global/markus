import { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { api, invalidateApiCache, wsClient, type NotificationInfo, type ApprovalInfo } from '../api.ts';
import { navBus } from '../navBus.ts';
import { PAGE } from '../routes.ts';
import { MarkdownMessage } from './MarkdownMessage.tsx';

interface Props {
  collapsed?: boolean;
  userId?: string;
  embeddedMode?: boolean;
  onClose?: () => void;
  sidebarMode?: boolean;
  isActive?: boolean;
  label?: string;
  iconPath?: string;
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
  task_review: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8',
  task_failed: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8',
  requirement_created: 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7 M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z',
  requirement_decision: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  agent_report: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8',
  direct_message: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  group_message: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
  system: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
};

const TYPE_COLOR: Record<string, string> = {
  approval_request: 'text-amber-500',
  task_completed: 'text-green-500',
  task_failed: 'text-red-500',
  task_created: 'text-blue-500',
  task_review: 'text-purple-500',
  requirement_created: 'text-amber-500',
  requirement_decision: 'text-green-500',
  agent_report: 'text-blue-500',
  direct_message: 'text-green-500',
  group_message: 'text-brand-500',
  system: 'text-fg-tertiary',
};

function timeAgo(iso: string, t: TFunction): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t('common:time.now');
  if (mins < 60) return t('common:time.minutesAgo', { count: mins });
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return t('common:time.hoursAgo', { count: hrs });
  return t('common:time.daysAgo', { count: Math.floor(hrs / 24) });
}

function actionHint(n: NotificationInfo, t: TFunction): string | null {
  const actionType = (n as any).actionType;
  if (actionType === 'open_chat') return t('team:notifications.actionHints.openChat');
  if (actionType === 'navigate') return t('team:notifications.actionHints.viewDetails');
  const meta = n.metadata ?? {};
  switch (n.type) {
    case 'task_completed': case 'task_created': case 'task_review': case 'task_failed':
      return meta.taskId ? t('team:notifications.actionHints.viewTask') : null;
    case 'requirement_created': case 'requirement_decision':
      return meta.requirementId ? t('team:notifications.actionHints.viewRequirement') : null;
    case 'agent_report':
      return meta.agentId ? t('team:notifications.actionHints.viewAgent') : null;
    case 'direct_message':
      return t('team:notifications.actionHints.openChat');
    case 'group_message':
      return t('team:notifications.actionHints.openChat');
    case 'approval_request':
      return t('team:notifications.actionHints.viewApproval');
    default:
      if (meta.taskId) return t('team:notifications.actionHints.viewTask');
      if (meta.requirementId) return t('team:notifications.actionHints.viewRequirement');
      if (meta.agentId) return t('team:notifications.actionHints.viewAgent');
      return null;
  }
}

function playNotificationSound() {
  try {
    const ctx = new AudioContext();
    const now = ctx.currentTime;

    const g = ctx.createGain();
    g.connect(ctx.destination);
    g.gain.setValueAtTime(0.15, now);
    g.gain.exponentialRampToValueAtTime(0.01, now + 0.6);

    const o1 = ctx.createOscillator();
    o1.type = 'sine';
    o1.frequency.setValueAtTime(880, now);
    o1.frequency.setValueAtTime(1174.66, now + 0.15);
    o1.connect(g);
    o1.start(now);
    o1.stop(now + 0.6);

    o1.onended = () => ctx.close();
  } catch { /* audio not available */ }
}

export function NotificationBell({ collapsed, userId, embeddedMode, onClose, sidebarMode, isActive, label, iconPath }: Props) {
  const { t } = useTranslation(['team', 'common']);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'approvals' | 'notifications'>('approvals');
  const [notifications, setNotifications] = useState<NotificationInfo[]>([]);
  const [approvals, setApprovals] = useState<ApprovalInfo[]>([]);
  const [responding, setResponding] = useState<string | null>(null);
  const [adjustingId, setAdjustingId] = useState<string | null>(null);
  const [freeformTexts, setFreeformTexts] = useState<Record<string, string>>({});
  const [unreadCount, setUnreadCount] = useState(0);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; maxHeight: number }>({ top: 0, left: 0, width: 448, maxHeight: 576 });
  const prevPendingRef = useRef<number | null>(null);
  const initialFetchDone = useRef(false);
  const [hasMoreNotifications, setHasMoreNotifications] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const notifScrollRef = useRef<HTMLDivElement>(null);
  const lastTabRef = useRef<'approvals' | 'notifications'>('approvals');

  const NOTIF_PAGE_SIZE = 30;

  const fetchData = useCallback(async () => {
    try {
      const [n, a] = await Promise.all([
        api.notifications.list(userId, false, { limit: NOTIF_PAGE_SIZE, offset: 0 }),
        api.approvals.list(),
      ]);
      setNotifications(n.notifications);
      setUnreadCount(n.unreadCount ?? n.notifications.filter((x: NotificationInfo) => !x.read).length);
      setHasMoreNotifications(n.totalCount != null ? n.notifications.length < n.totalCount : n.notifications.length >= NOTIF_PAGE_SIZE);
      setApprovals(a.approvals);
      if (!initialFetchDone.current) {
        const pending = a.approvals.filter((ap: any) => ap.status === 'pending').length;
        prevPendingRef.current = pending;
        initialFetchDone.current = true;
      }
    } catch { /* */ }
  }, [userId]);

  const loadMoreNotifications = useCallback(async () => {
    if (loadingMore || !hasMoreNotifications) return;
    setLoadingMore(true);
    try {
      const n = await api.notifications.list(userId, false, { limit: NOTIF_PAGE_SIZE, offset: notifications.length });
      if (n.notifications.length > 0) {
        setNotifications(prev => [...prev, ...n.notifications.filter(nn => !prev.some(p => p.id === nn.id))]);
      }
      setHasMoreNotifications(n.totalCount != null ? notifications.length + n.notifications.length < n.totalCount : n.notifications.length >= NOTIF_PAGE_SIZE);
    } catch { /* */ }
    setLoadingMore(false);
  }, [userId, notifications.length, loadingMore, hasMoreNotifications]);

  const markReadByRef = useCallback((e: Event) => {
    const detail = (e as CustomEvent).detail as { taskId?: string; requirementId?: string } | undefined;
    if (!detail) return;
    const { taskId, requirementId } = detail;
    if (!taskId && !requirementId) return;
    setNotifications(prev => {
      const toMark = prev.filter(n =>
        !n.read &&
        ((taskId && n.metadata?.taskId === taskId) ||
         (requirementId && n.metadata?.requirementId === requirementId))
      );
      if (toMark.length === 0) return prev;
      for (const n of toMark) api.notifications.markRead(n.id).catch(() => {});
      setUnreadCount(c => Math.max(0, c - toMark.length));
      return prev.map(n => toMark.some(m => m.id === n.id) ? { ...n, read: true } : n);
    });
  }, []);

  useEffect(() => {
    fetchData();
    const timer = setInterval(fetchData, 60000);
    const onChanged = () => fetchData();
    const onOpenNotifications = () => { setOpen(true); fetchData(); };
    window.addEventListener('markus:notifications-changed', onChanged);
    window.addEventListener('markus:mark-read-by-ref', markReadByRef);
    window.addEventListener('markus:open-notifications', onOpenNotifications);
    const unsubNotif = wsClient.on('notification:created', () => fetchData());
    const unsubApproval = wsClient.on('approval:created', () => fetchData());
    return () => { clearInterval(timer); window.removeEventListener('markus:notifications-changed', onChanged); window.removeEventListener('markus:mark-read-by-ref', markReadByRef); window.removeEventListener('markus:open-notifications', onOpenNotifications); unsubNotif(); unsubApproval(); };
  }, [fetchData, markReadByRef]);

  const reposition = useCallback(() => {
    if (!btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const panelW = Math.min(448, vw - 16);
    const panelMaxH = Math.min(576, vh - 16);

    let left = rect.right + 8;
    let top = rect.top;

    if (left + panelW > vw - 8) left = Math.max(8, vw - panelW - 8);
    if (top + panelMaxH > vh - 8) top = Math.max(8, vh - panelMaxH - 8);

    setPos({ top, left, width: panelW, maxHeight: panelMaxH });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', reposition);
    return () => window.removeEventListener('resize', reposition);
  }, [open, reposition]);

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

  useEffect(() => {
    if (!open) return;
    const hasPending = approvals.some(a => a.status === 'pending');
    const hasUnread = notifications.some(n => !n.read);
    if (hasPending && !hasUnread) {
      setTab('approvals');
    } else if (!hasPending && hasUnread) {
      setTab('notifications');
    } else {
      setTab(lastTabRef.current);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pendingApprovalIds = new Set(approvals.filter(a => a.status === 'pending').map(a => a.id));
  const allApprovalIds = new Set(approvals.map(a => a.id));
  const displayNotifications = notifications.filter(n => {
    if (n.type === 'approval_request' && n.metadata?.approvalId && allApprovalIds.has(n.metadata.approvalId as string)) {
      return false;
    }
    return true;
  });

  // Count unread notifications excluding those that have matching pending approvals
  // (pending approvals are counted separately to avoid double-counting)
  const hiddenUnreadApprovalCount = notifications.filter(n =>
    n.type === 'approval_request' && !n.read &&
    n.metadata?.approvalId && pendingApprovalIds.has(n.metadata.approvalId as string)
  ).length;
  const adjustedUnreadCount = Math.max(0, unreadCount - hiddenUnreadApprovalCount);
  const pendingApprovals = pendingApprovalIds.size;
  const badgeCount = adjustedUnreadCount + pendingApprovals;

  useEffect(() => {
    if (prevPendingRef.current !== null && pendingApprovals > prevPendingRef.current) {
      playNotificationSound();
    }
    prevPendingRef.current = pendingApprovals;
  }, [pendingApprovals]);

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
          if (target.path.startsWith('/team')) {
            const params: Record<string, string> = {};
            const searchParams = new URLSearchParams(target.path.split('?')[1] || '');
            for (const [k, v] of searchParams.entries()) params[k] = v;
            navBus.navigate(PAGE.TEAM, params);
            return;
          }
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
        const requirementId = (approval?.details?.requirementId ?? meta.requirementId) as string | undefined;
        const apAgentId = (approval?.details?.agentId ?? approval?.agentId) as string | undefined;
        if (taskId) navBus.navigate(PAGE.WORK, { openTask: taskId });
        else if (requirementId) navBus.navigate(PAGE.WORK, { openRequirement: requirementId });
        else if (apAgentId) navBus.navigate(PAGE.TEAM, { agentId: apAgentId });
        else navBus.navigate(PAGE.WORK);
        break;
      }
      case 'task_completed':
      case 'task_created':
      case 'task_review':
      case 'task_failed':
        if (meta.taskId) navBus.navigate(PAGE.WORK, { openTask: meta.taskId as string });
        else navBus.navigate(PAGE.WORK);
        break;
      case 'requirement_created':
      case 'requirement_decision':
        if (meta.requirementId) navBus.navigate(PAGE.WORK, { openRequirement: meta.requirementId as string });
        else navBus.navigate(PAGE.WORK);
        break;
      case 'agent_report':
      case 'system': {
        if (meta.agentId) {
          const params: Record<string, string> = { agentId: meta.agentId as string };
          if (meta.sessionId) params.sessionId = meta.sessionId as string;
          navBus.navigate(PAGE.TEAM, params);
        } else {
          navBus.navigate(PAGE.TEAM);
        }
        break;
      }
      case 'direct_message': {
        const dmUserId = meta.senderId as string | undefined;
        if (dmUserId) navBus.navigate(PAGE.TEAM, { dm: dmUserId });
        else navBus.navigate(PAGE.TEAM);
        break;
      }
      case 'group_message': {
        const ch = meta.channel as string | undefined;
        if (ch) navBus.navigate(PAGE.TEAM, { channel: ch });
        else navBus.navigate(PAGE.TEAM);
        break;
      }
      default:
        if (meta.taskId) navBus.navigate(PAGE.WORK, { openTask: meta.taskId as string });
        else if (meta.requirementId) navBus.navigate(PAGE.WORK, { openRequirement: meta.requirementId as string });
        else if (meta.projectId) navBus.navigate(PAGE.WORK, { projectId: meta.projectId as string });
        else if (meta.agentId) navBus.navigate(PAGE.TEAM, { agentId: meta.agentId as string });
        break;
    }
  };

  const handleNotificationClick = async (n: NotificationInfo) => {
    if (!n.read) handleMarkRead(n.id);
    const meta = n.metadata ?? {};
    const targetTaskId = meta.taskId as string | undefined;
    const targetReqId = meta.requirementId as string | undefined;
    if (targetTaskId || targetReqId) {
      const related = notifications.filter(other =>
        other.id !== n.id && !other.read &&
        ((targetTaskId && (other.metadata?.taskId === targetTaskId)) ||
         (targetReqId && (other.metadata?.requirementId === targetReqId)))
      );
      for (const r of related) handleMarkRead(r.id);
    }
    navigateForNotification(n);
  };

  const handleApprovalResponse = async (id: string, approved: boolean, comment?: string, selectedOption?: string) => {
    setResponding(id);
    try {
      const { approval } = await api.approvals.respond(id, approved, userId, comment, selectedOption);
      setApprovals(prev => prev.map(a => a.id === id ? approval : a));
      setAdjustingId(null);
      setFreeformTexts(prev => { const next = { ...prev }; delete next[id]; return next; });

      const taskId = approval.details?.taskId as string | undefined;
      const requirementId = approval.details?.requirementId as string | undefined;
      const relatedNotifs = notifications.filter(n =>
        !n.read && (
          (n.type === 'approval_request' && n.metadata?.approvalId === id) ||
          (taskId && n.metadata?.taskId === taskId) ||
          (requirementId && n.metadata?.requirementId === requirementId)
        )
      );
      if (relatedNotifs.length > 0) {
        for (const rn of relatedNotifs) api.notifications.markRead(rn.id).catch(() => {});
        const ids = new Set(relatedNotifs.map(rn => rn.id));
        setNotifications(prev => prev.map(n => ids.has(n.id) ? { ...n, read: true } : n));
        setUnreadCount(prev => Math.max(0, prev - relatedNotifs.length));
      }
      invalidateApiCache('/approvals');
      invalidateApiCache('/notifications');
      invalidateApiCache('/tasks');
      invalidateApiCache('/taskboard');
      invalidateApiCache('/requirements');
      window.dispatchEvent(new CustomEvent('markus:data-changed'));
      window.dispatchEvent(new CustomEvent('markus:notifications-changed'));
      setTimeout(() => fetchData(), 800);
    } catch { /* */ }
    setResponding(null);
  };

  const handleMarkAllRead = async () => {
    try {
      if (!userId) return;
      await api.notifications.markAllRead(userId);
      setNotifications(prev => prev.map(n => ({ ...n, read: true })));
      setUnreadCount(0);
      invalidateApiCache('/notifications');
    } catch {
      const unread = displayNotifications.filter(n => !n.read);
      await Promise.all(unread.map(n => api.notifications.markRead(n.id)));
      setNotifications(prev => prev.map(n => ({ ...n, read: true })));
      setUnreadCount(0);
      invalidateApiCache('/notifications');
    }
  };

  const approvalTypeLabel = (a: ApprovalInfo): string | null => {
    const sub = a.details?.subType as string | undefined;
    if (sub === 'requirement_resubmit') return t('team:notifications.approvalType.requirementResubmit');
    if (sub === 'requirement' || a.details?.requirementId) return t('team:notifications.approvalType.requirement');
    if (sub === 'task_review') return t('team:notifications.approvalType.taskReview');
    if (sub === 'task' || a.details?.taskId) return t('team:notifications.approvalType.task');
    if (a.details?.toolName) return t('team:notifications.approvalType.toolExecution');
    return null;
  };

  const approvalSourceLabel = (a: ApprovalInfo): string => {
    const parts: string[] = [];
    parts.push(a.agentName);
    const taskTitle = a.details?.taskTitle as string | undefined;
    const taskId = a.details?.taskId as string | undefined;
    if (taskTitle) {
      parts.push(taskTitle);
    } else if (taskId) {
      parts.push(`Task ${taskId.slice(0, 8)}`);
    }
    const reqId = a.details?.requirementId as string | undefined;
    if (reqId && !taskId) {
      parts.push(`Req ${reqId.slice(0, 8)}`);
    }
    return parts.join(' · ');
  };

  const sortedApprovals = [...approvals].sort((a, b) =>
    new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime()
  );
  const pendingList = sortedApprovals.filter(a => a.status === 'pending');
  const historyList = sortedApprovals.filter(a => a.status !== 'pending');

  const navigateForApproval = (a: ApprovalInfo) => {
    const taskId = a.details?.taskId as string | undefined;
    const requirementId = a.details?.requirementId as string | undefined;
    const agentId = (a.details?.agentId ?? a.agentId) as string | undefined;
    if (taskId) navBus.navigate(PAGE.WORK, { openTask: taskId });
    else if (requirementId) navBus.navigate(PAGE.WORK, { openRequirement: requirementId });
    else if (agentId) navBus.navigate(PAGE.TEAM, { agentId });
    else navBus.navigate(PAGE.WORK);
  };

  const closePanel = () => {
    setOpen(false);
    onClose?.();
  };

  const panelContent = (
    <>
      {/* Tabs + Close */}
      <div className="flex border-b border-border-default shrink-0">
        <button
          onClick={() => { setTab('approvals'); lastTabRef.current = 'approvals'; }}
          className={`flex-1 px-3 py-2.5 text-xs font-medium transition-colors ${
            tab === 'approvals' ? 'text-fg-primary border-b-2 border-brand-500' : 'text-fg-tertiary hover:text-fg-secondary'
          }`}
        >
          {t('team:notifications.approvals')}{pendingApprovals > 0 ? ` (${pendingApprovals})` : ''}
        </button>
        <button
          onClick={() => { setTab('notifications'); lastTabRef.current = 'notifications'; }}
          className={`flex-1 px-3 py-2.5 text-xs font-medium transition-colors ${
            tab === 'notifications' ? 'text-fg-primary border-b-2 border-brand-500' : 'text-fg-tertiary hover:text-fg-secondary'
          }`}
        >
          {t('team:notifications.notifications')}{adjustedUnreadCount > 0 ? ` (${adjustedUnreadCount})` : ''}
        </button>
        <button
          onClick={closePanel}
          className="px-2 py-2 text-fg-tertiary hover:text-fg-primary transition-colors shrink-0"
          title={t('common:close')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6L6 18" /><path d="M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Actions bar */}
      {tab === 'notifications' && unreadCount > 0 && (
        <div className="flex justify-end px-3 py-1.5 border-b border-border-default/50 shrink-0">
          <button onClick={handleMarkAllRead} className="text-[10px] text-brand-500 hover:text-brand-400 transition-colors">{t('team:notifications.markAllRead')}</button>
        </div>
      )}

      {/* Content */}
      <div ref={notifScrollRef} className="flex-1 overflow-y-auto" onScroll={(e) => {
        if (tab !== 'notifications' || !hasMoreNotifications || loadingMore) return;
        const el = e.currentTarget;
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) loadMoreNotifications();
      }}>
            {tab === 'approvals' && (
              approvals.length === 0 ? (
                <div className="p-6 text-center text-xs text-fg-tertiary">{t('team:notifications.noApprovals')}</div>
              ) : (
                <div className="divide-y divide-border-default/50">
                  {pendingList.map(a => {
                    const cmd = a.details?.command as string | undefined;
                    const descClean = cmd ? a.description.replace(/\s*Command:.*$/, '') : a.description;
                    return (
                    <div key={a.id} className="px-3 py-3 space-y-2.5">
                      <div
                        className="cursor-pointer hover:bg-surface-overlay/50 -mx-3 -mt-3 px-3 pt-3 pb-1 rounded-t-md transition-colors"
                        onClick={() => navigateForApproval(a)}
                      >
                        <div className="flex items-start gap-2">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-amber-500 mt-0.5 shrink-0">
                            <path d={TYPE_ICON.approval_request} />
                          </svg>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              {approvalTypeLabel(a) && <span className="text-[10px] text-amber-500 font-medium shrink-0">{approvalTypeLabel(a)}</span>}
                              <span className="text-xs text-fg-primary font-medium truncate">{a.title}</span>
                              <span className="text-[10px] text-fg-tertiary shrink-0">{timeAgo(a.requestedAt, t)}</span>
                            </div>
                            <div className="text-[11px] text-fg-tertiary mt-0.5">{a.agentName}</div>
                          </div>
                        </div>
                        <div className="mt-2.5 text-[11px] text-fg-secondary leading-relaxed">
                          <MarkdownMessage content={descClean} className="text-[11px] [&_h1]:text-xs [&_h2]:text-[11px] [&_h3]:text-[11px] [&_p]:text-[11px] [&_li]:text-[11px]" />
                        </div>
                        {cmd && (
                          <pre className="text-[11px] text-fg-primary bg-surface-overlay border border-border-default rounded-md px-2.5 py-2 overflow-x-auto whitespace-pre-wrap break-all font-mono leading-relaxed mt-2">{cmd}</pre>
                        )}
                      </div>
                      {(() => {
                        const sub = a.details?.subType as string | undefined;
                        const isStructured = sub === 'task' || sub === 'requirement' || sub === 'requirement_resubmit';
                        const hasOptions = a.options && a.options.length > 0;
                        const txt = (freeformTexts[a.id] ?? '').trim();

                        if (hasOptions) {
                          return (
                            <div className="space-y-1.5">
                              {a.options!.map((opt, idx) => (
                                <button
                                  key={opt.id}
                                  disabled={responding === a.id}
                                  onClick={() => handleApprovalResponse(a.id, opt.id !== 'reject', txt || undefined, opt.id)}
                                  className={`w-full px-3 py-2 text-left text-[11px] font-medium rounded-md disabled:opacity-50 transition-colors flex items-center gap-2 ${
                                    opt.id === 'reject' || opt.id === 'request_changes'
                                      ? 'border border-border-default text-fg-secondary hover:bg-surface-overlay'
                                      : 'bg-brand-600 text-white hover:bg-brand-700'
                                  }`}
                                  title={opt.description}
                                >
                                  <span className="w-5 h-5 rounded-full bg-white/20 flex items-center justify-center text-[10px] font-bold shrink-0">
                                    {String.fromCharCode(65 + idx)}
                                  </span>
                                  {opt.label}
                                </button>
                              ))}
                              <div className="flex gap-1.5 mt-1">
                                <input
                                  type="text"
                                  placeholder={t('team:notifications.freeformPlaceholder')}
                                  value={freeformTexts[a.id] ?? ''}
                                  onChange={e => setFreeformTexts(prev => ({ ...prev, [a.id]: e.target.value }))}
                                  onKeyDown={e => { if (e.key === 'Enter' && (freeformTexts[a.id] ?? '').trim()) handleApprovalResponse(a.id, true, (freeformTexts[a.id] ?? '').trim(), 'custom'); }}
                                  className="flex-1 px-2.5 py-1.5 text-[11px] bg-surface-overlay border border-border-default rounded-md text-fg-primary placeholder:text-fg-tertiary focus:outline-none focus:ring-1 focus:ring-brand-500/50"
                                />
                                <button
                                  disabled={responding === a.id || !(freeformTexts[a.id] ?? '').trim()}
                                  onClick={() => handleApprovalResponse(a.id, true, (freeformTexts[a.id] ?? '').trim(), 'custom')}
                                  className="px-2.5 py-1.5 text-[11px] font-medium bg-brand-600 text-white rounded-md hover:bg-brand-700 disabled:opacity-50 transition-colors"
                                >{t('common:send')}</button>
                              </div>
                            </div>
                          );
                        }

                        if (isStructured) {
                          return (
                            <div className="space-y-1.5">
                              <div className="flex items-center gap-2">
                                <button
                                  disabled={responding === a.id}
                                  onClick={() => handleApprovalResponse(a.id, true, undefined, 'approve')}
                                  className="px-3 py-1.5 text-[11px] font-medium bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5"
                                >
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                                  {t('common:approve')}
                                </button>
                                <button
                                  disabled={responding === a.id}
                                  onClick={() => handleApprovalResponse(a.id, false, undefined, 'reject')}
                                  className="px-3 py-1.5 text-[11px] font-medium bg-red-600/80 text-white rounded-md hover:bg-red-700 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5"
                                >
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18" /><path d="M6 6l12 12" /></svg>
                                  {t('common:reject')}
                                </button>
                                {adjustingId !== a.id && (
                                  <button
                                    disabled={responding === a.id}
                                    onClick={() => setAdjustingId(a.id)}
                                    className="px-3 py-1.5 text-[11px] font-medium border border-amber-500/50 text-amber-500 rounded-md hover:bg-amber-500/10 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5"
                                  >
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
                                    {t('team:notifications.needsAdjustment')}
                                  </button>
                                )}
                              </div>
                              {adjustingId === a.id && (
                                <div className="space-y-1.5">
                                  <input
                                    type="text"
                                    autoFocus
                                    placeholder={t('team:notifications.adjustmentPlaceholder')}
                                    value={freeformTexts[a.id] ?? ''}
                                    onChange={e => setFreeformTexts(prev => ({ ...prev, [a.id]: e.target.value }))}
                                    onKeyDown={e => {
                                      if (e.key === 'Enter' && (freeformTexts[a.id] ?? '').trim()) handleApprovalResponse(a.id, false, (freeformTexts[a.id] ?? '').trim(), 'needs_adjustment');
                                      if (e.key === 'Escape') setAdjustingId(null);
                                    }}
                                    className="w-full px-2.5 py-1.5 text-[11px] bg-surface-overlay border border-border-default rounded-md text-fg-primary placeholder:text-fg-tertiary focus:outline-none focus:ring-1 focus:ring-amber-500/50"
                                  />
                                  <div className="flex gap-2">
                                    <button
                                      disabled={responding === a.id || !(freeformTexts[a.id] ?? '').trim()}
                                      onClick={() => handleApprovalResponse(a.id, false, (freeformTexts[a.id] ?? '').trim(), 'needs_adjustment')}
                                      className="px-2.5 py-1.5 text-[11px] font-medium bg-amber-600 text-white rounded-md hover:bg-amber-700 disabled:opacity-50 transition-colors"
                                    >{t('team:notifications.confirmAdjustment')}</button>
                                    <button
                                      onClick={() => setAdjustingId(null)}
                                      className="px-2.5 py-1.5 text-[11px] font-medium border border-border-default text-fg-secondary rounded-md hover:bg-surface-overlay transition-colors"
                                    >{t('common:cancel')}</button>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        }

                        return (
                          <div className="space-y-1.5">
                            <input
                              type="text"
                              placeholder={t('team:notifications.commentPlaceholder')}
                              value={freeformTexts[a.id] ?? ''}
                              onChange={e => setFreeformTexts(prev => ({ ...prev, [a.id]: e.target.value }))}
                              onKeyDown={e => { if (e.key === 'Enter') handleApprovalResponse(a.id, true, txt || undefined, 'approve'); }}
                              className="w-full px-2.5 py-1.5 text-[11px] bg-surface-overlay border border-border-default rounded-md text-fg-primary placeholder:text-fg-tertiary focus:outline-none focus:ring-1 focus:ring-brand-500/50"
                            />
                            <div className="flex gap-2">
                              <button
                                disabled={responding === a.id}
                                onClick={() => handleApprovalResponse(a.id, true, txt || undefined, 'approve')}
                                className="flex-1 px-2.5 py-1.5 text-[11px] font-medium bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50 transition-colors"
                              >{t('common:approve')}</button>
                              <button
                                disabled={responding === a.id}
                                onClick={() => handleApprovalResponse(a.id, false, txt || undefined, 'reject')}
                                className="flex-1 px-2.5 py-1.5 text-[11px] font-medium border border-border-default text-fg-secondary rounded-md hover:bg-surface-overlay disabled:opacity-50 transition-colors"
                              >{t('common:reject')}</button>
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                    );
                  })}
                  {historyList.length > 0 && (
                    <>
                      {pendingList.length > 0 && (
                        <div className="px-3 py-1.5 text-[10px] font-medium text-fg-tertiary uppercase tracking-wider bg-surface-overlay/30">
                          {t('team:notifications.approvalHistory')}
                        </div>
                      )}
                      {historyList.slice(0, 50).map(a => (
                        <button key={a.id} onClick={() => navigateForApproval(a)} className="w-full text-left px-3 py-2.5 hover:bg-surface-overlay/50 transition-colors group">
                          <div className="flex items-center gap-2">
                            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${a.status === 'approved' ? 'bg-green-500' : a.status === 'cancelled' || a.status === 'expired' ? 'bg-gray-400' : 'bg-red-500'}`} />
                            {approvalTypeLabel(a) && <span className="text-[10px] text-fg-tertiary font-medium shrink-0">{approvalTypeLabel(a)}</span>}
                            <span className="text-xs text-fg-secondary truncate flex-1 group-hover:text-fg-primary">{a.title}</span>
                            <span className={`text-[10px] font-medium shrink-0 ${a.status === 'approved' ? 'text-green-500' : a.status === 'cancelled' || a.status === 'expired' ? 'text-fg-muted' : 'text-red-500'}`}>
                              {t(`common:status.${a.status}`, { defaultValue: a.status })}
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5 mt-0.5 pl-3.5">
                            <span className="text-[10px] text-fg-muted truncate">{approvalSourceLabel(a)}</span>
                            <span className="text-[10px] text-fg-muted shrink-0">·</span>
                            <span className="text-[10px] text-fg-muted shrink-0">{timeAgo(a.respondedAt ?? a.requestedAt, t)}</span>
                          </div>
                          {a.responseComment && (
                            <p className="text-[10px] text-fg-muted mt-0.5 pl-3.5 truncate">&ldquo;{a.responseComment}&rdquo;</p>
                          )}
                        </button>
                      ))}
                    </>
                  )}
                </div>
              )
            )}

            {tab === 'notifications' && (
              displayNotifications.length === 0 ? (
                <div className="p-6 text-center text-xs text-fg-tertiary">{t('team:notifications.noNotifications')}</div>
              ) : (
                <div className="divide-y divide-border-default/50">
                  {displayNotifications.map(n => {
                    const typeColor = TYPE_COLOR[n.type] ?? 'text-fg-tertiary';
                    return (
                    <div
                      key={n.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => handleNotificationClick(n)}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleNotificationClick(n); } }}
                      className={`w-full text-left px-3 py-2.5 flex gap-2.5 transition-colors cursor-pointer ${
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
                        <div className="text-[11px] text-fg-tertiary mt-0.5 ">
                          <MarkdownMessage content={n.body} className="text-[11px] [&_h1]:text-xs [&_h2]:text-[11px] [&_h3]:text-[11px] [&_p]:text-[11px] [&_li]:text-[11px] [&_p]:text-fg-tertiary" />
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-[10px] text-fg-muted">{timeAgo(n.createdAt, t)}</span>
                          {actionHint(n, t) && (
                            <span className={`text-[10px] font-medium ${typeColor}`}>
                              {actionHint(n, t)}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    );
                  })}
                  {loadingMore && (
                    <div className="py-3 text-center">
                      <svg className="animate-spin h-4 w-4 text-fg-tertiary mx-auto" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                    </div>
                  )}
                </div>
              )
            )}
          </div>
    </>
  );

  if (embeddedMode) {
    const tabs: Array<'approvals' | 'notifications'> = ['approvals', 'notifications'];
    const tabIdx = tabs.indexOf(tab);

    const handleSwipe = (() => {
      let startX = 0;
      let startY = 0;
      return {
        onTouchStart: (e: React.TouchEvent) => { startX = e.touches[0].clientX; startY = e.touches[0].clientY; },
        onTouchEnd: (e: React.TouchEvent) => {
          const dx = e.changedTouches[0].clientX - startX;
          const dy = e.changedTouches[0].clientY - startY;
          if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
            if (dx < 0 && tabIdx < tabs.length - 1) setTab(tabs[tabIdx + 1]);
            if (dx > 0 && tabIdx > 0) setTab(tabs[tabIdx - 1]);
          }
        },
      };
    })();

    return (
      <div className="flex flex-col h-full overflow-hidden">
        {/* Tabs */}
        <div className="flex border-b border-border-default shrink-0">
          {tabs.map((t_id) => (
            <button
              key={t_id}
              onClick={() => setTab(t_id)}
              className={`flex-1 px-3 py-3 text-sm font-medium transition-colors ${
                tab === t_id ? 'text-fg-primary border-b-2 border-brand-500' : 'text-fg-tertiary'
              }`}
            >
              {t_id === 'approvals'
                ? <>{t('team:notifications.approvals')}{pendingApprovals > 0 ? ` (${pendingApprovals})` : ''}</>
                : <>{t('team:notifications.notifications')}{adjustedUnreadCount > 0 ? ` (${adjustedUnreadCount})` : ''}</>
              }
            </button>
          ))}
        </div>

        {/* Actions bar */}
        {tab === 'notifications' && unreadCount > 0 && (
          <div className="flex justify-end px-3 py-1.5 border-b border-border-default/50 shrink-0">
            <button onClick={handleMarkAllRead} className="text-[10px] text-brand-500 hover:text-brand-400 transition-colors">{t('team:notifications.markAllRead')}</button>
          </div>
        )}

        {/* Swipeable content */}
        <div className="flex-1 overflow-hidden relative" {...handleSwipe}>
          <div
            className="flex h-full transition-transform duration-300 ease-out"
            style={{ transform: `translateX(-${tabIdx * 100}%)` }}
          >
            <div className="w-full shrink-0 h-full overflow-y-auto scrollbar-thin">
              {approvals.length === 0 ? (
                <div className="p-6 text-center text-xs text-fg-tertiary">{t('team:notifications.noApprovals')}</div>
              ) : (
                <div className="divide-y divide-border-default/50">
                  {pendingList.map(a => {
                    const cmd = a.details?.command as string | undefined;
                    const descClean = cmd ? a.description.replace(/\s*Command:.*$/, '') : a.description;
                    return (
                      <div key={a.id} className="px-3 py-3 space-y-2.5">
                        <div className="cursor-pointer hover:bg-surface-overlay/50 -mx-3 -mt-3 px-3 pt-3 pb-1 rounded-t-md transition-colors" onClick={() => navigateForApproval(a)}>
                          <div className="flex items-start gap-2">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-amber-500 mt-0.5 shrink-0"><path d={TYPE_ICON.approval_request} /></svg>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                {approvalTypeLabel(a) && <span className="text-[10px] text-amber-500 font-medium shrink-0">{approvalTypeLabel(a)}</span>}
                                <span className="text-xs text-fg-primary font-medium truncate">{a.title}</span>
                                <span className="text-[10px] text-fg-tertiary shrink-0">{timeAgo(a.requestedAt, t)}</span>
                              </div>
                              <div className="text-[11px] text-fg-tertiary mt-0.5">{a.agentName}</div>
                            </div>
                          </div>
                          <div className="mt-2.5 text-[11px] text-fg-secondary leading-relaxed">
                            <MarkdownMessage content={descClean} className="text-[11px] [&_h1]:text-xs [&_h2]:text-[11px] [&_h3]:text-[11px] [&_p]:text-[11px] [&_li]:text-[11px]" />
                          </div>
                          {cmd && <pre className="text-[11px] text-fg-primary bg-surface-overlay border border-border-default rounded-md px-2.5 py-2 overflow-x-auto whitespace-pre-wrap break-all font-mono leading-relaxed mt-2">{cmd}</pre>}
                        </div>
                        {(() => {
                          const sub = a.details?.subType as string | undefined;
                          const isStructured = sub === 'task' || sub === 'requirement' || sub === 'requirement_resubmit';
                          const hasOptions = a.options && a.options.length > 0;
                          const txt = (freeformTexts[a.id] ?? '').trim();

                          if (hasOptions) {
                            return (
                              <div className="space-y-1.5">
                                {a.options!.map((opt, idx) => (
                                  <button
                                    key={opt.id}
                                    disabled={responding === a.id}
                                    onClick={() => handleApprovalResponse(a.id, opt.id !== 'reject', txt || undefined, opt.id)}
                                    className={`w-full px-3 py-2 text-left text-[11px] font-medium rounded-md disabled:opacity-50 transition-colors flex items-center gap-2 ${
                                      opt.id === 'reject' || opt.id === 'request_changes'
                                        ? 'border border-border-default text-fg-secondary hover:bg-surface-overlay'
                                        : 'bg-brand-600 text-white hover:bg-brand-700'
                                    }`}
                                    title={opt.description}
                                  >
                                    <span className="w-5 h-5 rounded-full bg-white/20 flex items-center justify-center text-[10px] font-bold shrink-0">
                                      {String.fromCharCode(65 + idx)}
                                    </span>
                                    {opt.label}
                                  </button>
                                ))}
                                <div className="flex gap-1.5 mt-1">
                                  <input
                                    type="text"
                                    placeholder={t('team:notifications.freeformPlaceholder')}
                                    value={freeformTexts[a.id] ?? ''}
                                    onChange={e => setFreeformTexts(prev => ({ ...prev, [a.id]: e.target.value }))}
                                    onKeyDown={e => { if (e.key === 'Enter' && (freeformTexts[a.id] ?? '').trim()) handleApprovalResponse(a.id, true, (freeformTexts[a.id] ?? '').trim(), 'custom'); }}
                                    className="flex-1 px-2.5 py-1.5 text-[11px] bg-surface-overlay border border-border-default rounded-md text-fg-primary placeholder:text-fg-tertiary focus:outline-none focus:ring-1 focus:ring-brand-500/50"
                                  />
                                  <button
                                    disabled={responding === a.id || !(freeformTexts[a.id] ?? '').trim()}
                                    onClick={() => handleApprovalResponse(a.id, true, (freeformTexts[a.id] ?? '').trim(), 'custom')}
                                    className="px-2.5 py-1.5 text-[11px] font-medium bg-brand-600 text-white rounded-md hover:bg-brand-700 disabled:opacity-50 transition-colors"
                                  >{t('common:send')}</button>
                                </div>
                              </div>
                            );
                          }

                          if (isStructured) {
                            return (
                              <div className="space-y-1.5">
                                <div className="flex items-center gap-2">
                                  <button
                                    disabled={responding === a.id}
                                    onClick={() => handleApprovalResponse(a.id, true, undefined, 'approve')}
                                    className="px-3 py-1.5 text-[11px] font-medium bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5"
                                  >
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                                    {t('common:approve')}
                                  </button>
                                  <button
                                    disabled={responding === a.id}
                                    onClick={() => handleApprovalResponse(a.id, false, undefined, 'reject')}
                                    className="px-3 py-1.5 text-[11px] font-medium bg-red-600/80 text-white rounded-md hover:bg-red-700 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5"
                                  >
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18" /><path d="M6 6l12 12" /></svg>
                                    {t('common:reject')}
                                  </button>
                                  {adjustingId !== a.id && (
                                    <button
                                      disabled={responding === a.id}
                                      onClick={() => setAdjustingId(a.id)}
                                      className="px-3 py-1.5 text-[11px] font-medium border border-amber-500/50 text-amber-500 rounded-md hover:bg-amber-500/10 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5"
                                    >
                                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
                                      {t('team:notifications.needsAdjustment')}
                                    </button>
                                  )}
                                </div>
                                {adjustingId === a.id && (
                                  <div className="space-y-1.5">
                                    <input
                                      type="text"
                                      autoFocus
                                      placeholder={t('team:notifications.adjustmentPlaceholder')}
                                      value={freeformTexts[a.id] ?? ''}
                                      onChange={e => setFreeformTexts(prev => ({ ...prev, [a.id]: e.target.value }))}
                                      onKeyDown={e => {
                                        if (e.key === 'Enter' && (freeformTexts[a.id] ?? '').trim()) handleApprovalResponse(a.id, false, (freeformTexts[a.id] ?? '').trim(), 'needs_adjustment');
                                        if (e.key === 'Escape') setAdjustingId(null);
                                      }}
                                      className="w-full px-2.5 py-1.5 text-[11px] bg-surface-overlay border border-border-default rounded-md text-fg-primary placeholder:text-fg-tertiary focus:outline-none focus:ring-1 focus:ring-amber-500/50"
                                    />
                                    <div className="flex gap-2">
                                      <button
                                        disabled={responding === a.id || !(freeformTexts[a.id] ?? '').trim()}
                                        onClick={() => handleApprovalResponse(a.id, false, (freeformTexts[a.id] ?? '').trim(), 'needs_adjustment')}
                                        className="px-2.5 py-1.5 text-[11px] font-medium bg-amber-600 text-white rounded-md hover:bg-amber-700 disabled:opacity-50 transition-colors"
                                      >{t('team:notifications.confirmAdjustment')}</button>
                                      <button
                                        onClick={() => setAdjustingId(null)}
                                        className="px-2.5 py-1.5 text-[11px] font-medium border border-border-default text-fg-secondary rounded-md hover:bg-surface-overlay transition-colors"
                                      >{t('common:cancel')}</button>
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          }

                          return (
                            <div className="space-y-1.5">
                              <input
                                type="text"
                                placeholder={t('team:notifications.commentPlaceholder')}
                                value={freeformTexts[a.id] ?? ''}
                                onChange={e => setFreeformTexts(prev => ({ ...prev, [a.id]: e.target.value }))}
                                onKeyDown={e => { if (e.key === 'Enter') handleApprovalResponse(a.id, true, txt || undefined, 'approve'); }}
                                className="w-full px-2.5 py-1.5 text-[11px] bg-surface-overlay border border-border-default rounded-md text-fg-primary placeholder:text-fg-tertiary focus:outline-none focus:ring-1 focus:ring-brand-500/50"
                              />
                              <div className="flex gap-2">
                                <button
                                  disabled={responding === a.id}
                                  onClick={() => handleApprovalResponse(a.id, true, txt || undefined, 'approve')}
                                  className="flex-1 px-2.5 py-1.5 text-[11px] font-medium bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50 transition-colors"
                                >{t('common:approve')}</button>
                                <button
                                  disabled={responding === a.id}
                                  onClick={() => handleApprovalResponse(a.id, false, txt || undefined, 'reject')}
                                  className="flex-1 px-2.5 py-1.5 text-[11px] font-medium border border-border-default text-fg-secondary rounded-md hover:bg-surface-overlay disabled:opacity-50 transition-colors"
                                >{t('common:reject')}</button>
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    );
                  })}
                  {historyList.length > 0 && (
                    <>
                      {pendingList.length > 0 && <div className="px-3 py-1.5 text-[10px] font-medium text-fg-tertiary uppercase tracking-wider bg-surface-overlay/30">{t('team:notifications.approvalHistory')}</div>}
                      {historyList.slice(0, 50).map(a => (
                        <button key={a.id} onClick={() => navigateForApproval(a)} className="w-full text-left px-3 py-2.5 hover:bg-surface-overlay/50 transition-colors">
                          <div className="flex items-center gap-2">
                            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${a.status === 'approved' ? 'bg-green-500' : a.status === 'cancelled' || a.status === 'expired' ? 'bg-gray-400' : 'bg-red-500'}`} />
                            <span className="text-xs text-fg-secondary truncate flex-1">{a.title}</span>
                            <span className={`text-[10px] font-medium shrink-0 ${a.status === 'approved' ? 'text-green-500' : a.status === 'cancelled' || a.status === 'expired' ? 'text-fg-muted' : 'text-red-500'}`}>{t(`common:status.${a.status}`, { defaultValue: a.status })}</span>
                          </div>
                          <div className="flex items-center gap-1.5 mt-0.5 pl-3.5">
                            <span className="text-[10px] text-fg-muted truncate">{approvalSourceLabel(a)}</span>
                            <span className="text-[10px] text-fg-muted shrink-0">·</span>
                            <span className="text-[10px] text-fg-muted shrink-0">{timeAgo(a.respondedAt ?? a.requestedAt, t)}</span>
                          </div>
                        </button>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
            <div className="w-full shrink-0 h-full overflow-y-auto scrollbar-thin">
              {displayNotifications.length === 0 ? (
                <div className="p-6 text-center text-xs text-fg-tertiary">{t('team:notifications.noNotifications')}</div>
              ) : (
                <div className="divide-y divide-border-default/50">
                  {displayNotifications.slice(0, 50).map(n => {
                    const typeColor = TYPE_COLOR[n.type] ?? 'text-fg-tertiary';
                    return (
                      <button key={n.id} onClick={() => handleNotificationClick(n)} className={`w-full text-left px-3 py-2.5 flex gap-2.5 transition-colors ${n.read ? 'opacity-50 hover:opacity-70' : 'hover:bg-surface-overlay'}`}>
                        <div className="shrink-0 mt-0.5">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={typeColor}><path d={TYPE_ICON[n.type] ?? TYPE_ICON.system} /></svg>
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            {!n.read && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${PRIORITY_DOT[n.priority] ?? PRIORITY_DOT.normal}`} />}
                            <span className="text-xs text-fg-primary font-medium truncate">{n.title}</span>
                          </div>
                          <div className="text-[11px] text-fg-tertiary mt-0.5 ">
                            <MarkdownMessage content={n.body} className="text-[11px] [&_h1]:text-xs [&_h2]:text-[11px] [&_h3]:text-[11px] [&_p]:text-[11px] [&_li]:text-[11px] [&_p]:text-fg-tertiary" />
                          </div>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-[10px] text-fg-muted">{timeAgo(n.createdAt, t)}</span>
                            {actionHint(n, t) && <span className={`text-[10px] font-medium ${typeColor}`}>{actionHint(n, t)}</span>}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (sidebarMode) {
    const d = iconPath || 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9 M13.73 21a2 2 0 0 1-3.46 0';
    return (
      <>
        <button
          ref={btnRef}
          onClick={() => { setOpen(!open); if (!open) fetchData(); }}
          title={collapsed ? (label || t('team:notifications.bellTitle')) : undefined}
          className={`w-full flex items-center ${collapsed ? 'flex-col justify-center px-1 py-1.5 gap-0.5' : 'gap-3 px-3 py-[7px]'} rounded-lg text-[13px] font-medium mb-0.5 transition-colors relative text-fg-primary ${
            open || isActive
              ? 'bg-surface-overlay'
              : 'hover:bg-surface-overlay/60'
          }`}
        >
          <svg width={collapsed ? 16 : 18} height={collapsed ? 16 : 18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
            <path d={d} />
          </svg>
          {collapsed
            ? <span className="text-[9px] leading-tight truncate w-full text-center">{label}</span>
            : <span className="truncate">{label}</span>
          }
          {badgeCount > 0 && (
            <span className={`absolute ${collapsed ? 'top-0.5 right-1' : 'top-1 left-[22px]'} min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center leading-none`}>
              {badgeCount > 99 ? t('common:badgeOverLimit') : badgeCount}
            </span>
          )}
        </button>

        {open && createPortal(
          <div ref={panelRef} className="fixed bg-surface-secondary border border-border-default rounded-xl shadow-2xl z-[9999] flex flex-col overflow-hidden" style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxHeight }}>
            {panelContent}
          </div>,
          document.body
        )}
      </>
    );
  }

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => { setOpen(!open); if (!open) fetchData(); }}
        className={`relative flex items-center justify-center rounded-md transition-colors ${
          collapsed ? 'w-8 h-8' : 'w-7 h-7'
        } ${open ? 'bg-surface-overlay text-fg-primary' : 'text-fg-tertiary hover:text-fg-secondary hover:bg-surface-overlay'}`}
        title={t('team:notifications.bellTitle')}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {badgeCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center leading-none">
            {badgeCount > 99 ? t('common:badgeOverLimit') : badgeCount}
          </span>
        )}
      </button>

      {open && createPortal(
        <div ref={panelRef} className="fixed bg-surface-secondary border border-border-default rounded-xl shadow-2xl z-[9999] flex flex-col overflow-hidden" style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxHeight }}>
          {panelContent}
        </div>,
        document.body
      )}
    </>
  );
}
