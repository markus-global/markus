import { useMemo, useCallback, useState, useEffect, useRef, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  type NodeTypes,
  type Connection,
  type EdgeMouseHandler,
  type ReactFlowInstance,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  useUpdateNodeInternals as useUpdateNodeInternalsHook,
  MarkerType,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from '@dagrejs/dagre';
import type { TaskInfo, AgentInfo, RequirementInfo } from '../api.ts';
import { api } from '../api.ts';

const STATUS_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  pending:     { bg: 'bg-blue-500/10',    border: 'border-blue-500/30',   text: 'text-blue-500' },
  in_progress: { bg: 'bg-amber-500/10',   border: 'border-amber-500/30',  text: 'text-amber-600' },
  blocked:     { bg: 'bg-red-500/8',      border: 'border-red-500/25',    text: 'text-red-500' },
  review:      { bg: 'bg-brand-500/10',   border: 'border-brand-500/30',  text: 'text-brand-500' },
  completed:   { bg: 'bg-green-500/10',   border: 'border-green-500/30',  text: 'text-green-600' },
  failed:      { bg: 'bg-red-500/10',     border: 'border-red-500/30',    text: 'text-red-500' },
  rejected:    { bg: 'bg-red-500/8',      border: 'border-red-500/25',    text: 'text-red-500' },
  cancelled:   { bg: 'bg-gray-500/8',     border: 'border-gray-500/20',   text: 'text-fg-tertiary' },
  archived:    { bg: 'bg-gray-500/5',     border: 'border-gray-500/15',   text: 'text-fg-tertiary' },
};

const PRIORITY_INDICATOR: Record<string, string> = {
  critical: 'bg-red-500',
  high: 'bg-amber-500',
  medium: 'bg-amber-500',
  low: 'bg-blue-500',
};

function TaskNode({ data }: { data: { task: TaskInfo; agentName?: string; selected?: boolean; direction?: 'TB' | 'LR'; isExpandedRoot?: boolean; onCollapse?: () => void } }) {
  const { t } = useTranslation(['work', 'common']);
  const { task, agentName, selected, direction = 'TB', isExpandedRoot, onCollapse } = data;
  const colors = STATUS_COLORS[task.status] ?? STATUS_COLORS['pending']!;
  const isSched = task.taskType === 'scheduled' && !!task.scheduleConfig;
  const schedLabel = isSched
    ? (task.scheduleConfig!.every
      ? t('work:task.everyInterval', { interval: task.scheduleConfig!.every })
      : task.scheduleConfig!.cron ? t('work:task.cronLabel') : '')
    : '';
  const targetPos = direction === 'LR' ? Position.Left : Position.Top;
  const sourcePos = direction === 'LR' ? Position.Right : Position.Bottom;

  return (
    <div className={`relative rounded-lg border px-3 py-2 min-w-[180px] max-w-[220px] shadow-md backdrop-blur-sm ${isSched ? `${colors.bg} border-blue-500/40 ring-1 ring-blue-500/20` : `${colors.bg} ${colors.border}`} ${selected ? 'ring-2 ring-brand-500 shadow-brand-500/25 shadow-lg' : ''}`}>
      <Handle type="target" position={targetPos} className="!bg-border-default !w-2 !h-2" />
      <div className="flex items-center gap-1.5 mb-1">
        <span className={`w-2 h-2 rounded-full shrink-0 ${PRIORITY_INDICATOR[task.priority] ?? 'bg-gray-500'}`} />
        <span className={`text-[10px] font-medium uppercase tracking-wider ${colors.text}`}>
          {t(`work:status.task.${task.status}`, { defaultValue: task.status.replace('_', ' ') })}
        </span>
        {isSched && (
          <span className="text-[9px] px-1 py-0.5 rounded bg-blue-500/15 text-blue-600 ml-auto whitespace-nowrap inline-flex items-center gap-0.5"><svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.3"/></svg>{schedLabel}</span>
        )}
      </div>
      <div className="text-xs font-medium text-fg-primary leading-snug line-clamp-2 mb-1">
        {task.title}
      </div>
      {agentName && (
        <div className="text-[10px] text-fg-tertiary truncate">
          {agentName}
        </div>
      )}
      {task.blockedBy && task.blockedBy.length > 0 && (
        <div className="text-[10px] text-fg-tertiary mt-0.5">
          {t('work:dag.depCount', { count: task.blockedBy.length })}
        </div>
      )}
      <Handle type="source" position={sourcePos} className="!bg-border-default !w-2 !h-2" />
      {isExpandedRoot && onCollapse && (
        <button
          onClick={(e) => { e.stopPropagation(); onCollapse(); }}
          className="absolute top-1/2 -translate-y-1/2 -right-7 w-5 h-5 rounded-full bg-surface-secondary border border-border-default flex items-center justify-center text-fg-tertiary hover:text-fg-primary hover:bg-surface-overlay transition-colors shadow-sm"
          title={t('work:dag.backToOverview')}
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
        </button>
      )}
    </div>
  );
}

const REQ_STATUS_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  pending:     { bg: 'bg-amber-500/10',    border: 'border-amber-500/30',  text: 'text-amber-600' },
  in_progress: { bg: 'bg-brand-500/10',    border: 'border-brand-500/30',  text: 'text-brand-500' },
  completed:   { bg: 'bg-green-500/10',    border: 'border-green-500/30',  text: 'text-green-600' },
  rejected:    { bg: 'bg-red-500/10',      border: 'border-red-500/30',    text: 'text-red-500' },
  cancelled:   { bg: 'bg-gray-500/8',      border: 'border-gray-500/20',   text: 'text-fg-tertiary' },
};

const REQ_GROUP_MAP: Record<string, string> = {
  pending: 'todo',
  in_progress: 'in_progress',
  completed: 'done',
  rejected: 'done', cancelled: 'done', archived: 'done',
};

function RequirementNode({ data }: { data: { req: RequirementInfo; selected?: boolean; direction?: 'TB' | 'LR'; isExpandedRoot?: boolean; onCollapse?: () => void } }) {
  const { t } = useTranslation(['work', 'common']);
  const { req, selected, direction = 'TB', isExpandedRoot, onCollapse } = data;
  const colors = REQ_STATUS_COLORS[req.status] ?? REQ_STATUS_COLORS['pending']!;
  const targetPos = direction === 'LR' ? Position.Left : Position.Top;
  const sourcePos = direction === 'LR' ? Position.Right : Position.Bottom;
  return (
    <div className={`relative rounded-lg border-2 border-dashed px-3 py-2 min-w-[180px] max-w-[220px] shadow-lg ${colors.bg} ${colors.border} ${selected ? 'ring-2 ring-brand-500 shadow-brand-500/25' : ''}`}>
      <Handle type="target" position={targetPos} className="!bg-border-default !w-2 !h-2" />
      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-[9px] px-1 py-0.5 rounded font-semibold bg-amber-500/15 text-amber-600">{t('work:dag.reqLabel')}</span>
        <span className={`text-[10px] font-medium uppercase tracking-wider ${colors.text}`}>
          {t(`work:status.requirement.${req.status}`, { defaultValue: req.status.replace('_', ' ') })}
        </span>
      </div>
      <div className="text-xs font-medium text-fg-primary leading-snug line-clamp-2 mb-1">
        {req.title}
      </div>
      {req.taskIds.length > 0 && (
        <div className="text-[10px] text-fg-tertiary">
          {t('work:dag.taskCount', { count: req.taskIds.length })}
        </div>
      )}
      <Handle type="source" position={sourcePos} className="!bg-border-default !w-2 !h-2" />
      {isExpandedRoot && onCollapse && (
        <button
          onClick={(e) => { e.stopPropagation(); onCollapse(); }}
          className="absolute top-1/2 -translate-y-1/2 -right-7 w-5 h-5 rounded-full bg-surface-secondary border border-border-default flex items-center justify-center text-fg-tertiary hover:text-fg-primary hover:bg-surface-overlay transition-colors shadow-sm"
          title={t('work:dag.backToOverview')}
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
        </button>
      )}
    </div>
  );
}

const nodeTypes: NodeTypes = {
  task: TaskNode as unknown as NodeTypes[string],
  requirement: RequirementNode as unknown as NodeTypes[string],
};

function PreviewNodeUpdater({ nodeIds, rfRef }: { nodeIds: string[]; rfRef: React.RefObject<ReactFlowInstance | null> }) {
  const updateNodeInternals = useUpdateNodeInternalsHook();
  useEffect(() => {
    if (nodeIds.length === 0) return;
    const t = setTimeout(() => {
      updateNodeInternals(nodeIds);
      requestAnimationFrame(() => {
        rfRef.current?.fitView({ padding: 0.2 });
      });
    }, 300);
    return () => clearTimeout(t);
  }, [nodeIds.length]);
  return null;
}

const isLightSnapshot = () =>
  document.documentElement.classList.contains('light') ||
  (!document.documentElement.classList.contains('dark') &&
   !document.documentElement.classList.contains('cyberpunk') &&
   !document.documentElement.classList.contains('mono') &&
   window.matchMedia('(prefers-color-scheme: light)').matches);
const subscribeLightMode = (cb: () => void) => {
  const obs = new MutationObserver(cb);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  mq.addEventListener('change', cb);
  return () => { obs.disconnect(); mq.removeEventListener('change', cb); };
};
function useIsLight() { return useSyncExternalStore(subscribeLightMode, isLightSnapshot, () => false); }

const NODE_WIDTH = 200;
const NODE_HEIGHT = 80;

function layoutSingleComponent(nodes: Node[], edges: Edge[], direction: 'TB' | 'LR' = 'TB'): { nodes: Node[]; direction: 'TB' | 'LR' } {
  const doLayout = (dir: 'TB' | 'LR') => {
    const g = new dagre.graphlib.Graph();
    g.setDefaultEdgeLabel(() => ({}));
    g.setGraph({ rankdir: dir, nodesep: 40, ranksep: 60 });
    for (const node of nodes) g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
    for (const edge of edges) g.setEdge(edge.source, edge.target);
    dagre.layout(g);
    return nodes.map(node => {
      const pos = g.node(node.id);
      return { ...node, position: { x: (pos?.x ?? 0) - NODE_WIDTH / 2, y: (pos?.y ?? 0) - NODE_HEIGHT / 2 } };
    });
  };

  const result = doLayout(direction);
  if (edges.length > 0 && nodes.length > 4) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of result) {
      minX = Math.min(minX, n.position.x);
      maxX = Math.max(maxX, n.position.x + NODE_WIDTH);
      minY = Math.min(minY, n.position.y);
      maxY = Math.max(maxY, n.position.y + NODE_HEIGHT);
    }
    const w = maxX - minX;
    const h = maxY - minY;
    const flipped = direction === 'TB' ? 'LR' : 'TB';
    if (w > h * 3) return { nodes: doLayout(flipped), direction: flipped };
  }
  return { nodes: result, direction };
}

function findConnectedComponents(nodes: Node[], edges: Edge[]): { nodes: Node[]; edges: Edge[] }[] {
  const adj = new Map<string, Set<string>>();
  const nodeMap = new Map<string, Node>();
  for (const n of nodes) { nodeMap.set(n.id, n); adj.set(n.id, new Set()); }
  for (const e of edges) {
    adj.get(e.source)?.add(e.target);
    adj.get(e.target)?.add(e.source);
  }
  const visited = new Set<string>();
  const components: { nodes: Node[]; edges: Edge[] }[] = [];
  for (const n of nodes) {
    if (visited.has(n.id)) continue;
    const compIds = new Set<string>();
    const stack = [n.id];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      compIds.add(id);
      for (const neighbor of adj.get(id) ?? []) {
        if (!visited.has(neighbor)) stack.push(neighbor);
      }
    }
    components.push({
      nodes: nodes.filter(nd => compIds.has(nd.id)),
      edges: edges.filter(e => compIds.has(e.source) && compIds.has(e.target)),
    });
  }
  return components;
}

function layoutNodes(nodes: Node[], edges: Edge[]): { nodes: Node[]; direction: 'TB' | 'LR' } {
  if (nodes.length === 0) return { nodes: [], direction: 'TB' };
  const components = findConnectedComponents(nodes, edges);
  if (components.length === 1) return layoutSingleComponent(nodes, edges);

  let resolvedDir: 'TB' | 'LR' = 'TB';
  const laid: { nodes: Node[]; w: number; h: number }[] = components.map(c => {
    const { nodes: laidNodes, direction: dir } = layoutSingleComponent(c.nodes, c.edges);
    resolvedDir = dir;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of laidNodes) {
      minX = Math.min(minX, n.position.x);
      maxX = Math.max(maxX, n.position.x + NODE_WIDTH);
      minY = Math.min(minY, n.position.y);
      maxY = Math.max(maxY, n.position.y + NODE_HEIGHT);
    }
    for (const n of laidNodes) { n.position.x -= minX; n.position.y -= minY; }
    return { nodes: laidNodes, w: maxX - minX, h: maxY - minY };
  });

  laid.sort((a, b) => b.h - a.h);

  const gap = 60;
  const totalArea = laid.reduce((s, c) => s + (c.w + gap) * (c.h + gap), 0);
  const targetSide = Math.sqrt(totalArea) * 1.1;

  const result: Node[] = [];
  let curX = 0, curY = 0, rowHeight = 0;
  for (const comp of laid) {
    if (curX > 0 && curX + comp.w > targetSide) {
      curX = 0;
      curY += rowHeight + gap;
      rowHeight = 0;
    }
    for (const n of comp.nodes) {
      result.push({ ...n, position: { x: n.position.x + curX, y: n.position.y + curY } });
    }
    curX += comp.w + gap;
    rowHeight = Math.max(rowHeight, comp.h);
  }
  return { nodes: result, direction: resolvedDir };
}

function wouldCreateCycle(taskMap: Map<string, TaskInfo>, sourceId: string, targetId: string): boolean {
  const visited = new Set<string>();
  const stack = [sourceId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === targetId) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    const t = taskMap.get(id);
    if (t?.blockedBy) {
      for (const dep of t.blockedBy) stack.push(dep);
    }
  }
  return false;
}

interface TaskDAGProps {
  tasks: TaskInfo[];
  requirements?: RequirementInfo[];
  agents: AgentInfo[];
  showArchived?: boolean;
  onShowArchivedChange?: (show: boolean) => void;
  onTaskClick?: (task: TaskInfo) => void;
  onReqClick?: (req: RequirementInfo) => void;
  onCollapseDAG?: () => void;
  onDependencyChange?: () => void;
  selectedTaskId?: string | null;
  selectedReqId?: string | null;
  hasDetailPanel?: boolean;
  defaultExpandedNodeId?: string | null;
  previewMode?: boolean;
}

const ALL_STATUSES = ['pending', 'in_progress', 'blocked', 'review', 'completed', 'failed', 'rejected', 'cancelled', 'archived'] as const;

const DAG_FILTER_GROUPS = [
  { id: 'todo',        statuses: new Set(['pending']),                                           color: { bg: 'bg-blue-500/10', border: 'border-blue-500/30', text: 'text-blue-500' } },
  { id: 'in_progress', statuses: new Set(['in_progress', 'blocked']),                           color: { bg: 'bg-amber-500/10', border: 'border-amber-500/30', text: 'text-amber-600' } },
  { id: 'review',      statuses: new Set(['review']),                                           color: { bg: 'bg-brand-500/10', border: 'border-brand-500/30', text: 'text-brand-500' } },
  { id: 'done',        statuses: new Set(['completed', 'failed', 'rejected', 'cancelled', 'archived']),     color: { bg: 'bg-green-500/10', border: 'border-green-500/30', text: 'text-green-600' } },
] as const;

const ALL_DAG_GROUP_IDS = new Set(DAG_FILTER_GROUPS.map(g => g.id));
const DEFAULT_DAG_GROUP_FILTER = new Set(DAG_FILTER_GROUPS.filter(g => g.id !== 'done').map(g => g.id));

const isArchivedTask = (t: TaskInfo) => t.status === 'archived';

function collectTransitiveDeps(nodeId: string, taskMap: Map<string, TaskInfo>, reqMap: Map<string, RequirementInfo>, allTasks: TaskInfo[]): Set<string> {
  const visited = new Set<string>();
  const stack = [nodeId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    if (id.startsWith('req-')) {
      const req = reqMap.get(id.slice(4));
      if (req) {
        for (const tid of req.taskIds) stack.push(tid);
      }
    } else {
      const task = taskMap.get(id);
      if (task?.blockedBy) {
        for (const dep of task.blockedBy) stack.push(dep);
      }
      if (task?.requirementId) {
        stack.push(`req-${task.requirementId}`);
      }
    }
  }
  for (const task of allTasks) {
    if (task.requirementId && visited.has(task.id)) {
      visited.add(`req-${task.requirementId}`);
    }
  }
  return visited;
}

export function TaskDAG({ tasks, requirements = [], agents, showArchived: showArchivedProp, onShowArchivedChange, onTaskClick, onReqClick, onCollapseDAG, onDependencyChange, selectedTaskId, selectedReqId, hasDetailPanel, defaultExpandedNodeId, previewMode }: TaskDAGProps) {
  const { t } = useTranslation(['work', 'common']);
  const isLight = useIsLight();
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Edge | null>(null);
  const [groupFilter, setGroupFilter] = useState<Set<string>>(() => new Set(DEFAULT_DAG_GROUP_FILTER));
  const [expandedNodeId, setExpandedNodeId] = useState<string | null>(defaultExpandedNodeId ?? null);
  const [localShowArchived, setLocalShowArchived] = useState(showArchivedProp ?? false);
  const showArchived = showArchivedProp ?? localShowArchived;
  const setShowArchived = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    const next = typeof v === 'function' ? v(showArchived) : v;
    setLocalShowArchived(next);
    onShowArchivedChange?.(next);
  }, [showArchived, onShowArchivedChange]);

  useEffect(() => {
    if (showArchivedProp !== undefined) setLocalShowArchived(showArchivedProp);
  }, [showArchivedProp]);

  useEffect(() => {
    if (defaultExpandedNodeId) setExpandedNodeId(defaultExpandedNodeId);
  }, [defaultExpandedNodeId]);

  const archivedCount = useMemo(() => tasks.filter(t => isArchivedTask(t)).length, [tasks]);

  const allowedStatuses = useMemo(() => {
    const s = new Set<string>();
    for (const g of DAG_FILTER_GROUPS) {
      if (groupFilter.has(g.id)) {
        for (const st of g.statuses) s.add(st);
      }
    }
    return s;
  }, [groupFilter]);

  const presentGroups = useMemo(() => {
    const activeGroupIds = new Set<string>();
    for (const t of tasks) {
      for (const g of DAG_FILTER_GROUPS) {
        if (g.statuses.has(t.status)) { activeGroupIds.add(g.id); break; }
      }
    }
    for (const r of requirements) {
      const gid = REQ_GROUP_MAP[r.status];
      if (gid) activeGroupIds.add(gid);
    }
    return DAG_FILTER_GROUPS.filter(g => activeGroupIds.has(g.id));
  }, [tasks, requirements]);

  const toggleGroup = useCallback((groupId: string) => {
    setGroupFilter(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId); else next.add(groupId);
      return next;
    });
  }, []);

  const showToast = useCallback((msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2500);
  }, []);

  const agentMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agents) m.set(a.id, a.name);
    return m;
  }, [agents]);

  const taskMap = useMemo(() => {
    const m = new Map<string, TaskInfo>();
    for (const t of tasks) m.set(t.id, t);
    return m;
  }, [tasks]);

  const reqMap = useMemo(() => {
    const m = new Map<string, RequirementInfo>();
    for (const r of requirements) m.set(r.id, r);
    return m;
  }, [requirements]);

  const userHasInteracted = useRef(false);

  const collapseDAG = useCallback(() => {
    userHasInteracted.current = false;
    setExpandedNodeId(null);
    onCollapseDAG?.();
  }, [onCollapseDAG]);

  const edgeDefault = isLight ? '#94a3b8' : '#6b7280';
  const makeEdge = useCallback((depId: string, taskId: string, status: string): Edge => ({
    id: `${depId}->${taskId}`,
    source: depId,
    target: taskId,
    animated: status === 'blocked',
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: status === 'blocked' ? '#ef4444' : edgeDefault },
    style: { stroke: status === 'blocked' ? '#ef4444' : edgeDefault, strokeWidth: 1.5, cursor: 'pointer' },
  }), [edgeDefault]);

  const { initialNodes, initialEdges, topLevelIds } = useMemo(() => {
    const buildNodesAndEdges = (srcTasks: TaskInfo[], srcReqs: RequirementInfo[]) => {
      const nodeIdSet = new Set<string>();
      const nodes: Node[] = srcTasks.map(task => {
        nodeIdSet.add(task.id);
        return {
          id: task.id,
          type: 'task' as const,
          data: { task, agentName: task.assignedAgentId ? agentMap.get(task.assignedAgentId) : undefined, selected: task.id === selectedTaskId },
          position: { x: 0, y: 0 },
        };
      });
      for (const req of srcReqs) {
        const reqNodeId = `req-${req.id}`;
        nodeIdSet.add(reqNodeId);
        nodes.push({
          id: reqNodeId,
          type: 'requirement' as const,
          data: { req, selected: req.id === selectedReqId },
          position: { x: 0, y: 0 },
        });
      }
      const edges: Edge[] = [];
      for (const task of srcTasks) {
        if (task.blockedBy) {
          for (const depId of task.blockedBy) {
            if (nodeIdSet.has(depId)) edges.push(makeEdge(depId, task.id, task.status));
          }
        }
      }
      const reqEdgeIds = new Set<string>();
      const addReqEdge = (reqNodeId: string, taskId: string) => {
        const edgeId = `${reqNodeId}->${taskId}`;
        if (reqEdgeIds.has(edgeId)) return;
        reqEdgeIds.add(edgeId);
        edges.push({
          id: edgeId,
          source: reqNodeId,
          target: taskId,
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: '#8b5cf6' },
          style: { stroke: '#8b5cf6', strokeWidth: 1.5, strokeDasharray: '4 2' },
        });
      };
      for (const req of srcReqs) {
        const reqNodeId = `req-${req.id}`;
        for (const taskId of req.taskIds) {
          if (nodeIdSet.has(taskId)) addReqEdge(reqNodeId, taskId);
        }
      }
      for (const task of srcTasks) {
        if (task.requirementId) {
          const reqNodeId = `req-${task.requirementId}`;
          if (nodeIdSet.has(reqNodeId)) addReqEdge(reqNodeId, task.id);
        }
      }
      return { nodes, edges };
    };

    // Overview: filtered by status groups
    const filteredTasks = tasks.filter(t => allowedStatuses.has(t.status) && (showArchived || !isArchivedTask(t)));
    const allowedGroupIds = new Set<string>();
    for (const g of DAG_FILTER_GROUPS) {
      if (groupFilter.has(g.id)) allowedGroupIds.add(g.id);
    }
    const filteredReqs = requirements.filter(r => {
      const gid = REQ_GROUP_MAP[r.status];
      return gid && allowedGroupIds.has(gid);
    });

    const { nodes: overviewNodes, edges: overviewEdges } = buildNodesAndEdges(filteredTasks, filteredReqs);
    const dependedUpon = new Set<string>();
    for (const e of overviewEdges) dependedUpon.add(e.target);
    const topLevel = new Set(overviewNodes.filter(n => !dependedUpon.has(n.id)).map(n => n.id));

    if (!expandedNodeId || !topLevel.has(expandedNodeId)) {
      const visibleNodes = overviewNodes.filter(n => topLevel.has(n.id));
      const { nodes: layouted, direction: layoutDir } = layoutNodes(visibleNodes, []);
      const withDir: Node[] = layouted.map(n => ({ ...n, data: { ...n.data, direction: layoutDir } }));
      return { initialNodes: withDir, initialEdges: [] as Edge[], topLevelIds: topLevel };
    }

    // Expanded: use ALL tasks/requirements regardless of status filter
    const { nodes: allNodes, edges: allEdges } = buildNodesAndEdges(tasks, requirements);
    const visible = collectTransitiveDeps(expandedNodeId, taskMap, reqMap, tasks);
    const visibleNodes = allNodes.filter(n => visible.has(n.id)).map(n =>
      n.id === expandedNodeId ? { ...n, data: { ...n.data, isExpandedRoot: true, onCollapse: collapseDAG } } : n
    );
    const visibleEdges = allEdges.filter(e => visible.has(e.source) && visible.has(e.target));

    const { nodes: layouted, direction: layoutDir } = layoutNodes(visibleNodes, visibleEdges);
    const withDir: Node[] = layouted.map(n => ({ ...n, data: { ...n.data, direction: layoutDir } }));
    return { initialNodes: withDir, initialEdges: visibleEdges, topLevelIds: topLevel };
  }, [tasks, requirements, agentMap, taskMap, reqMap, makeEdge, allowedStatuses, groupFilter, showArchived, selectedTaskId, selectedReqId, expandedNodeId, collapseDAG]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const rfRef = useRef<ReactFlowInstance | null>(null);
  const prevFilterRef = useRef({ groupFilter, showArchived });

  useEffect(() => {
    const prev = prevFilterRef.current;
    if (prev.groupFilter !== groupFilter || prev.showArchived !== showArchived) {
      userHasInteracted.current = false;
      setExpandedNodeId(null);
      prevFilterRef.current = { groupFilter, showArchived };
    }
  }, [groupFilter, showArchived]);

  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
    if (!userHasInteracted.current) {
      requestAnimationFrame(() => {
        rfRef.current?.fitView({ padding: 0.2, duration: 300 });
      });
    }
  }, [initialNodes, initialEdges, setNodes, setEdges]);

  useEffect(() => {
    const timer = setTimeout(() => {
      rfRef.current?.fitView({ padding: 0.2, duration: 300 });
    }, 50);
    return () => clearTimeout(timer);
  }, [hasDetailPanel]);

  const handleMoveEnd = useCallback((_event: MouseEvent | TouchEvent | null) => {
    if (_event) {
      userHasInteracted.current = true;
    }
  }, []);

  const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    if (!expandedNodeId && topLevelIds.has(node.id)) {
      userHasInteracted.current = false;
      setExpandedNodeId(node.id);
    }
    if (node.id.startsWith('req-')) {
      const req = reqMap.get(node.id.slice(4));
      if (req && onReqClick) onReqClick(req);
    } else {
      const task = taskMap.get(node.id);
      if (task && onTaskClick) onTaskClick(task);
    }
  }, [taskMap, reqMap, onTaskClick, onReqClick, topLevelIds, expandedNodeId]);

  // Drag from source (blocker) → target (dependent): source blocks target
  const handleConnect = useCallback(async (connection: Connection) => {
    const { source, target } = connection;
    if (!source || !target || source === target) return;

    const targetTask = taskMap.get(target);
    if (!targetTask) return;

    if (targetTask.blockedBy?.includes(source)) {
      showToast(t('work:dag.toast.dependencyExists'), 'error');
      return;
    }

    if (wouldCreateCycle(taskMap, source, target)) {
      showToast(t('work:dag.toast.cycleError'), 'error');
      return;
    }

    const newBlockedBy = [...(targetTask.blockedBy ?? []), source];
    try {
      await api.tasks.update(target, { blockedBy: newBlockedBy });
      showToast(t('work:dag.toast.dependencyAdded'));
      onDependencyChange?.();
    } catch (err) {
      showToast(t('work:dag.toast.failed', { message: err instanceof Error ? err.message : String(err) }), 'error');
    }
  }, [taskMap, showToast, onDependencyChange, t]);

  const handleEdgeClick: EdgeMouseHandler = useCallback((_event, edge) => {
    setPendingDelete(edge);
  }, []);

  const confirmDeleteEdge = useCallback(async () => {
    if (!pendingDelete) return;
    const targetTask = taskMap.get(pendingDelete.target);
    if (!targetTask) { setPendingDelete(null); return; }

    const newBlockedBy = (targetTask.blockedBy ?? []).filter(id => id !== pendingDelete.source);
    try {
      await api.tasks.update(pendingDelete.target, { blockedBy: newBlockedBy });
      showToast(t('work:dag.toast.dependencyRemoved'));
      onDependencyChange?.();
    } catch (err) {
      showToast(t('work:dag.toast.failed', { message: err instanceof Error ? err.message : String(err) }), 'error');
    }
    setPendingDelete(null);
  }, [pendingDelete, taskMap, showToast, onDependencyChange, t]);

  if (tasks.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-fg-tertiary text-sm">
        {t('work:dag.noTasks')}
      </div>
    );
  }

  const isDefaultFilter = groupFilter.size === DEFAULT_DAG_GROUP_FILTER.size
    && [...DEFAULT_DAG_GROUP_FILTER].every(id => groupFilter.has(id))
    && !showArchived;

  const sourceTask = pendingDelete ? taskMap.get(pendingDelete.source) : null;
  const targetTask = pendingDelete ? taskMap.get(pendingDelete.target) : null;

  return (
    <div className="flex-1 min-h-0 relative" style={{ height: '100%' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        onConnect={handleConnect}
        onEdgeClick={handleEdgeClick}
        onMoveEnd={handleMoveEnd}
        onInit={(instance) => { rfRef.current = instance; }}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.3}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        connectionLineStyle={{ stroke: '#818cf8', strokeWidth: 2, strokeDasharray: '6 3' }}
      >
        {previewMode && <PreviewNodeUpdater nodeIds={nodes.map(n => n.id)} rfRef={rfRef} />}
        <Background color={isLight ? '#cbd5e1' : '#374151'} gap={20} size={1} />
        <Controls
          showInteractive={false}
          className="!bg-surface-secondary !border-border-default !shadow-xl [&>button]:!bg-surface-elevated [&>button]:!border-border-default [&>button]:!text-fg-secondary [&>button:hover]:!bg-surface-overlay"
        />
        <MiniMap
          nodeColor={(node) => {
            const t = (node.data as { task: TaskInfo })?.task;
            const status = t?.status;
            if (t?.taskType === 'scheduled') return '#8b8fa3';
            if (status === 'completed' || status === 'accepted') return '#10b981';
            if (status === 'in_progress') return '#f59e0b';
            if (status === 'blocked' || status === 'failed') return '#ef4444';
            return isLight ? '#94a3b8' : '#6b7280';
          }}
          maskColor={isLight ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.7)'}
          className="!bg-surface-secondary !border-border-default"
        />
      </ReactFlow>

      {/* Filter + hint bar */}
      <div className="absolute top-2 left-1/2 -translate-x-1/2 px-3 py-1.5 bg-surface-secondary/90 border border-border-default rounded-lg backdrop-blur-sm z-10 flex flex-col items-center gap-1">
        <div className="flex items-center gap-1 flex-wrap justify-center">
          {presentGroups.map(g => {
            const active = groupFilter.has(g.id);
            return (
              <button key={g.id} onClick={() => toggleGroup(g.id)}
                className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${active ? `${g.color.bg} ${g.color.border} ${g.color.text}` : 'bg-surface-elevated/50 border-border-default/50 text-fg-tertiary'}`}>
                {t(`work:dag.filter.${g.id}`)}
              </button>
            );
          })}
          {archivedCount > 0 && (
            <button onClick={() => setShowArchived(v => !v)}
              className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${showArchived ? 'bg-surface-overlay/60 border-gray-500/50 text-fg-secondary' : 'bg-surface-elevated/50 border-border-default/50 text-fg-tertiary'}`}>
              {t('work:dag.archivedToggle', { count: archivedCount })}
            </button>
          )}
          {!isDefaultFilter && (
            <button onClick={() => { setGroupFilter(new Set(DEFAULT_DAG_GROUP_FILTER)); setShowArchived(false); }} className="text-[10px] text-fg-tertiary hover:text-fg-secondary px-1">{t('work:dag.reset')}</button>
          )}
        </div>
        <div className="text-[10px] text-fg-tertiary select-none flex items-center gap-2">
          {expandedNodeId ? (
            <button onClick={collapseDAG} className="text-brand-500 hover:text-brand-400 transition-colors">
              {t('work:dag.backToOverview')}
            </button>
          ) : (
            <span>{t('work:dag.expandHint')}</span>
          )}
          <span className="text-fg-tertiary/50">·</span>
          <span>{t('work:dag.dragHint')}</span>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div className={`absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg text-xs font-medium shadow-xl border backdrop-blur-sm transition-opacity ${
          toast.type === 'success'
            ? 'bg-green-500/15 border-green-500/30 text-green-600'
            : 'bg-red-500/15 border-red-500/30 text-red-600'
        }`}>
          {toast.msg}
        </div>
      )}

      {/* Confirm delete dialog */}
      {pendingDelete && (
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center z-50 backdrop-blur-[2px]" onClick={() => setPendingDelete(null)}>
          <div className="bg-surface-secondary border border-border-default rounded-xl p-5 shadow-2xl max-w-sm" onClick={e => e.stopPropagation()}>
            <h4 className="text-sm font-semibold text-fg-primary mb-2">{t('work:dag.removeDependencyTitle')}</h4>
            <p className="text-xs text-fg-secondary mb-4 leading-relaxed">
              {t('work:dag.removeDependencyBody', {
                target: targetTask?.title ?? pendingDelete.target.slice(-8),
                source: sourceTask?.title ?? pendingDelete.source.slice(-8),
              })}
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setPendingDelete(null)} className="px-3 py-1.5 text-xs text-fg-secondary hover:text-fg-primary bg-surface-elevated rounded-lg border border-border-default hover:border-gray-600 transition-colors">
                {t('common:cancel')}
              </button>
              <button onClick={confirmDeleteEdge} className="px-3 py-1.5 text-xs text-red-500 bg-red-600/20 hover:bg-red-600/30 rounded-lg border border-red-500/40 hover:border-red-500/60 transition-colors">
                {t('common:remove')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
