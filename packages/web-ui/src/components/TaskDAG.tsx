import { useMemo, useCallback, useState, useEffect, useRef } from 'react';
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
  MarkerType,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from '@dagrejs/dagre';
import type { TaskInfo, AgentInfo, RequirementInfo } from '../api.ts';
import { api } from '../api.ts';

const STATUS_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  pending:          { bg: 'bg-blue-900/40',    border: 'border-blue-500/50',   text: 'text-blue-300' },
  pending_approval: { bg: 'bg-blue-900/30',    border: 'border-blue-400/40',   text: 'text-blue-400' },
  assigned:         { bg: 'bg-cyan-900/40',     border: 'border-cyan-500/50',   text: 'text-cyan-300' },
  in_progress:      { bg: 'bg-amber-900/40',   border: 'border-amber-500/50',  text: 'text-amber-300' },
  blocked:          { bg: 'bg-surface-elevated/60',     border: 'border-gray-600/50',   text: 'text-gray-400' },
  review:           { bg: 'bg-purple-900/40',   border: 'border-purple-500/50', text: 'text-purple-300' },
  revision:         { bg: 'bg-orange-900/40',   border: 'border-orange-500/50', text: 'text-orange-300' },
  accepted:         { bg: 'bg-emerald-900/30',  border: 'border-emerald-500/40',text: 'text-emerald-400' },
  completed:        { bg: 'bg-emerald-900/40',  border: 'border-emerald-500/50',text: 'text-emerald-300' },
  failed:           { bg: 'bg-red-900/40',      border: 'border-red-500/50',    text: 'text-red-300' },
  cancelled:        { bg: 'bg-surface-elevated/40',     border: 'border-border-default/50',   text: 'text-gray-500' },
};

const PRIORITY_INDICATOR: Record<string, string> = {
  critical: 'bg-red-500',
  high: 'bg-orange-500',
  medium: 'bg-yellow-500',
  low: 'bg-blue-500',
};

function TaskNode({ data }: { data: { task: TaskInfo; agentName?: string } }) {
  const { task, agentName } = data;
  const colors = STATUS_COLORS[task.status] ?? STATUS_COLORS['pending']!;
  const isSched = task.taskType === 'scheduled' && !!task.scheduleConfig;
  const schedLabel = isSched ? (task.scheduleConfig!.every ? `Every ${task.scheduleConfig!.every}` : task.scheduleConfig!.cron ? 'Cron' : '') : '';

  return (
    <div className={`rounded-lg border px-3 py-2 min-w-[180px] max-w-[220px] shadow-lg ${isSched ? `${colors.bg} border-cyan-500/40 ring-1 ring-cyan-500/20` : `${colors.bg} ${colors.border}`}`}>
      <Handle type="target" position={Position.Top} className="!bg-gray-500 !w-2 !h-2" />
      <div className="flex items-center gap-1.5 mb-1">
        <span className={`w-2 h-2 rounded-full shrink-0 ${PRIORITY_INDICATOR[task.priority] ?? 'bg-gray-500'}`} />
        <span className={`text-[10px] font-medium uppercase tracking-wider ${colors.text}`}>
          {task.status.replace('_', ' ')}
        </span>
        {isSched && (
          <span className="text-[9px] px-1 py-0.5 rounded bg-cyan-500/15 text-cyan-400 ml-auto whitespace-nowrap inline-flex items-center gap-0.5"><svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.3"/></svg>{schedLabel}</span>
        )}
      </div>
      <div className="text-xs font-medium text-gray-200 leading-snug line-clamp-2 mb-1">
        {task.title}
      </div>
      {agentName && (
        <div className="text-[10px] text-gray-500 truncate">
          {agentName}
        </div>
      )}
      {task.blockedBy && task.blockedBy.length > 0 && (
        <div className="text-[10px] text-gray-600 mt-0.5">
          {task.blockedBy.length} dep{task.blockedBy.length > 1 ? 's' : ''}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-gray-500 !w-2 !h-2" />
    </div>
  );
}

const REQ_STATUS_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  draft:          { bg: 'bg-surface-elevated/60',    border: 'border-gray-600/50',   text: 'text-gray-400' },
  pending_review: { bg: 'bg-yellow-900/40',  border: 'border-yellow-500/50', text: 'text-yellow-300' },
  approved:       { bg: 'bg-blue-900/40',    border: 'border-blue-500/50',   text: 'text-blue-300' },
  in_progress:    { bg: 'bg-brand-900/40',  border: 'border-brand-500/50', text: 'text-brand-300' },
  completed:      { bg: 'bg-emerald-900/40', border: 'border-emerald-500/50',text: 'text-emerald-300' },
  rejected:       { bg: 'bg-red-900/40',     border: 'border-red-500/50',    text: 'text-red-300' },
  cancelled:      { bg: 'bg-surface-elevated/40',    border: 'border-border-default/50',   text: 'text-gray-500' },
};

const REQ_GROUP_MAP: Record<string, string> = {
  draft: 'todo', pending_review: 'todo', approved: 'todo',
  in_progress: 'in_progress',
  completed: 'done',
  rejected: 'done', cancelled: 'done',
};

function RequirementNode({ data }: { data: { req: RequirementInfo } }) {
  const { req } = data;
  const colors = REQ_STATUS_COLORS[req.status] ?? REQ_STATUS_COLORS['draft']!;
  return (
    <div className={`rounded-lg border-2 border-dashed px-3 py-2 min-w-[180px] max-w-[220px] shadow-lg ${colors.bg} ${colors.border}`}>
      <Handle type="target" position={Position.Top} className="!bg-gray-500 !w-2 !h-2" />
      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-[9px] px-1 py-0.5 rounded font-semibold bg-amber-500/15 text-amber-400">REQ</span>
        <span className={`text-[10px] font-medium uppercase tracking-wider ${colors.text}`}>
          {req.status.replace('_', ' ')}
        </span>
      </div>
      <div className="text-xs font-medium text-gray-200 leading-snug line-clamp-2 mb-1">
        {req.title}
      </div>
      {req.taskIds.length > 0 && (
        <div className="text-[10px] text-gray-500">
          {req.taskIds.length} task{req.taskIds.length > 1 ? 's' : ''}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-gray-500 !w-2 !h-2" />
    </div>
  );
}

const nodeTypes: NodeTypes = {
  task: TaskNode as unknown as NodeTypes[string],
  requirement: RequirementNode as unknown as NodeTypes[string],
};

const NODE_WIDTH = 200;
const NODE_HEIGHT = 80;

function layoutSingleComponent(nodes: Node[], edges: Edge[], direction: 'TB' | 'LR' = 'TB'): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: direction, nodesep: 40, ranksep: 60 });
  for (const node of nodes) g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const edge of edges) g.setEdge(edge.source, edge.target);
  dagre.layout(g);
  return nodes.map(node => {
    const pos = g.node(node.id);
    return { ...node, position: { x: (pos?.x ?? 0) - NODE_WIDTH / 2, y: (pos?.y ?? 0) - NODE_HEIGHT / 2 } };
  });
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

function layoutNodes(nodes: Node[], edges: Edge[]): Node[] {
  if (nodes.length === 0) return [];
  const components = findConnectedComponents(nodes, edges);
  if (components.length === 1) return layoutSingleComponent(nodes, edges);

  const laid: { nodes: Node[]; w: number; h: number }[] = components.map(c => {
    const laidNodes = layoutSingleComponent(c.nodes, c.edges);
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
  return result;
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
  onDependencyChange?: () => void;
}

const ALL_STATUSES = ['pending', 'pending_approval', 'assigned', 'in_progress', 'blocked', 'review', 'revision', 'accepted', 'completed', 'failed', 'cancelled'] as const;

const DAG_FILTER_GROUPS = [
  { id: 'todo',        label: 'To Do',       statuses: new Set(['pending_approval', 'pending', 'assigned']),          color: { bg: 'bg-blue-900/40', border: 'border-blue-500/50', text: 'text-blue-300' } },
  { id: 'in_progress', label: 'In Progress', statuses: new Set(['in_progress', 'blocked']),                           color: { bg: 'bg-amber-900/40', border: 'border-amber-500/50', text: 'text-amber-300' } },
  { id: 'review',      label: 'In Review',   statuses: new Set(['review', 'revision', 'accepted']),                   color: { bg: 'bg-purple-900/40', border: 'border-purple-500/50', text: 'text-purple-300' } },
  { id: 'done',        label: 'Done',        statuses: new Set(['completed', 'failed', 'cancelled']),                 color: { bg: 'bg-emerald-900/40', border: 'border-emerald-500/50', text: 'text-emerald-300' } },
] as const;

const ALL_DAG_GROUP_IDS = new Set(DAG_FILTER_GROUPS.map(g => g.id));

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const isArchivedTask = (t: TaskInfo) =>
  t.status === 'completed' && t.updatedAt && (Date.now() - new Date(t.updatedAt).getTime() > ONE_DAY_MS);

export function TaskDAG({ tasks, requirements = [], agents, showArchived: showArchivedProp, onShowArchivedChange, onTaskClick, onReqClick, onDependencyChange }: TaskDAGProps) {
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Edge | null>(null);
  const [groupFilter, setGroupFilter] = useState<Set<string>>(new Set(ALL_DAG_GROUP_IDS));
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

  const makeEdge = useCallback((depId: string, taskId: string, status: string): Edge => ({
    id: `${depId}->${taskId}`,
    source: depId,
    target: taskId,
    animated: status === 'blocked',
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: status === 'blocked' ? '#ef4444' : '#6b7280' },
    style: { stroke: status === 'blocked' ? '#ef4444' : '#6b7280', strokeWidth: 1.5, cursor: 'pointer' },
  }), []);

  const { initialNodes, initialEdges } = useMemo(() => {
    const rootTasks = tasks.filter(t => allowedStatuses.has(t.status) && (showArchived || !isArchivedTask(t)));

    const rawNodes: Node[] = rootTasks.map(task => ({
      id: task.id,
      type: 'task',
      data: { task, agentName: task.assignedAgentId ? agentMap.get(task.assignedAgentId) : undefined },
      position: { x: 0, y: 0 },
    }));

    const nodeIdSet = new Set(rawNodes.map(n => n.id));

    const allowedGroupIds = new Set<string>();
    for (const g of DAG_FILTER_GROUPS) {
      if (groupFilter.has(g.id)) allowedGroupIds.add(g.id);
    }
    const filteredReqs = requirements.filter(r => {
      const gid = REQ_GROUP_MAP[r.status];
      return gid && allowedGroupIds.has(gid);
    });
    for (const req of filteredReqs) {
      const reqNodeId = `req-${req.id}`;
      rawNodes.push({
        id: reqNodeId,
        type: 'requirement',
        data: { req },
        position: { x: 0, y: 0 },
      });
      nodeIdSet.add(reqNodeId);
    }

    const rawEdges: Edge[] = [];
    for (const task of rootTasks) {
      if (task.blockedBy) {
        for (const depId of task.blockedBy) {
          if (nodeIdSet.has(depId)) {
            rawEdges.push(makeEdge(depId, task.id, task.status));
          }
        }
      }
    }

    const reqEdgeIds = new Set<string>();
    const addReqEdge = (reqNodeId: string, taskId: string) => {
      const edgeId = `${reqNodeId}->${taskId}`;
      if (reqEdgeIds.has(edgeId)) return;
      reqEdgeIds.add(edgeId);
      rawEdges.push({
        id: edgeId,
        source: reqNodeId,
        target: taskId,
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: '#8b5cf6' },
        style: { stroke: '#8b5cf6', strokeWidth: 1.5, strokeDasharray: '4 2' },
      });
    };
    for (const req of filteredReqs) {
      const reqNodeId = `req-${req.id}`;
      for (const taskId of req.taskIds) {
        if (nodeIdSet.has(taskId)) addReqEdge(reqNodeId, taskId);
      }
    }
    for (const task of rootTasks) {
      if (task.requirementId) {
        const reqNodeId = `req-${task.requirementId}`;
        if (nodeIdSet.has(reqNodeId)) addReqEdge(reqNodeId, task.id);
      }
    }

    const layouted = layoutNodes(rawNodes, rawEdges);
    return { initialNodes: layouted, initialEdges: rawEdges };
  }, [tasks, requirements, agentMap, taskMap, makeEdge, allowedStatuses, groupFilter, showArchived]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const rfRef = useRef<ReactFlowInstance | null>(null);

  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
    requestAnimationFrame(() => {
      rfRef.current?.fitView({ padding: 0.2, duration: 300 });
    });
  }, [initialNodes, initialEdges, setNodes, setEdges]);

  const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    if (node.id.startsWith('req-')) {
      const req = reqMap.get(node.id.slice(4));
      if (req && onReqClick) onReqClick(req);
    } else {
      const task = taskMap.get(node.id);
      if (task && onTaskClick) onTaskClick(task);
    }
  }, [taskMap, reqMap, onTaskClick, onReqClick]);

  // Drag from source (blocker) → target (dependent): source blocks target
  const handleConnect = useCallback(async (connection: Connection) => {
    const { source, target } = connection;
    if (!source || !target || source === target) return;

    const targetTask = taskMap.get(target);
    if (!targetTask) return;

    if (targetTask.blockedBy?.includes(source)) {
      showToast('Dependency already exists', 'error');
      return;
    }

    if (wouldCreateCycle(taskMap, source, target)) {
      showToast('Cannot add: would create a cycle', 'error');
      return;
    }

    const newBlockedBy = [...(targetTask.blockedBy ?? []), source];
    try {
      await api.tasks.update(target, { blockedBy: newBlockedBy });
      showToast('Dependency added');
      onDependencyChange?.();
    } catch (err) {
      showToast(`Failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }, [taskMap, showToast, onDependencyChange]);

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
      showToast('Dependency removed');
      onDependencyChange?.();
    } catch (err) {
      showToast(`Failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
    setPendingDelete(null);
  }, [pendingDelete, taskMap, showToast, onDependencyChange]);

  if (tasks.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
        No tasks to display
      </div>
    );
  }

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
        onInit={(instance) => { rfRef.current = instance; }}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.3}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        connectionLineStyle={{ stroke: '#818cf8', strokeWidth: 2, strokeDasharray: '6 3' }}
      >
        <Background color="#374151" gap={20} size={1} />
        <Controls
          showInteractive={false}
          className="!bg-surface-secondary !border-border-default !shadow-xl [&>button]:!bg-surface-elevated [&>button]:!border-border-default [&>button]:!text-gray-300 [&>button:hover]:!bg-surface-overlay"
        />
        <MiniMap
          nodeColor={(node) => {
            const t = (node.data as { task: TaskInfo })?.task;
            const status = t?.status;
            if (t?.taskType === 'scheduled') return '#06b6d4';
            if (status === 'completed' || status === 'accepted') return '#10b981';
            if (status === 'in_progress') return '#f59e0b';
            if (status === 'blocked' || status === 'failed') return '#ef4444';
            return '#6b7280';
          }}
          maskColor="rgba(0,0,0,0.7)"
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
                className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${active ? `${g.color.bg} ${g.color.border} ${g.color.text}` : 'bg-surface-elevated/50 border-border-default/50 text-gray-600'}`}>
                {g.label}
              </button>
            );
          })}
          {archivedCount > 0 && (
            <button onClick={() => setShowArchived(v => !v)}
              className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${showArchived ? 'bg-surface-overlay/60 border-gray-500/50 text-gray-300' : 'bg-surface-elevated/50 border-border-default/50 text-gray-600'}`}>
              Archived {archivedCount}
            </button>
          )}
          {groupFilter.size < ALL_DAG_GROUP_IDS.size && (
            <button onClick={() => { setGroupFilter(new Set(ALL_DAG_GROUP_IDS)); setShowArchived(false); }} className="text-[10px] text-gray-500 hover:text-gray-300 px-1">Reset</button>
          )}
        </div>
        <div className="text-[10px] text-gray-500 select-none">Drag to add dependency · Click edge to remove</div>
      </div>

      {/* Toast */}
      {toast && (
        <div className={`absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg text-xs font-medium shadow-xl border backdrop-blur-sm transition-opacity ${
          toast.type === 'success'
            ? 'bg-emerald-900/80 border-emerald-600/50 text-emerald-200'
            : 'bg-red-900/80 border-red-600/50 text-red-200'
        }`}>
          {toast.msg}
        </div>
      )}

      {/* Confirm delete dialog */}
      {pendingDelete && (
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center z-50 backdrop-blur-[2px]" onClick={() => setPendingDelete(null)}>
          <div className="bg-surface-secondary border border-border-default rounded-xl p-5 shadow-2xl max-w-sm" onClick={e => e.stopPropagation()}>
            <h4 className="text-sm font-semibold text-gray-200 mb-2">Remove dependency?</h4>
            <p className="text-xs text-gray-400 mb-4 leading-relaxed">
              <span className="text-gray-300 font-medium">{targetTask?.title ?? pendingDelete.target.slice(-8)}</span>
              {' '}will no longer be blocked by{' '}
              <span className="text-gray-300 font-medium">{sourceTask?.title ?? pendingDelete.source.slice(-8)}</span>.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setPendingDelete(null)} className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 bg-surface-elevated rounded-lg border border-border-default hover:border-gray-600 transition-colors">
                Cancel
              </button>
              <button onClick={confirmDeleteEdge} className="px-3 py-1.5 text-xs text-red-200 bg-red-600/20 hover:bg-red-600/30 rounded-lg border border-red-500/40 hover:border-red-500/60 transition-colors">
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
