import { useMemo, useCallback, useState, useEffect } from 'react';
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
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  MarkerType,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from '@dagrejs/dagre';
import type { TaskInfo, AgentInfo } from '../api.ts';
import { api } from '../api.ts';

const STATUS_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  pending:          { bg: 'bg-blue-900/40',    border: 'border-blue-500/50',   text: 'text-blue-300' },
  pending_approval: { bg: 'bg-blue-900/30',    border: 'border-blue-400/40',   text: 'text-blue-400' },
  assigned:         { bg: 'bg-cyan-900/40',     border: 'border-cyan-500/50',   text: 'text-cyan-300' },
  in_progress:      { bg: 'bg-amber-900/40',   border: 'border-amber-500/50',  text: 'text-amber-300' },
  blocked:          { bg: 'bg-gray-800/60',     border: 'border-gray-600/50',   text: 'text-gray-400' },
  review:           { bg: 'bg-purple-900/40',   border: 'border-purple-500/50', text: 'text-purple-300' },
  revision:         { bg: 'bg-orange-900/40',   border: 'border-orange-500/50', text: 'text-orange-300' },
  accepted:         { bg: 'bg-emerald-900/30',  border: 'border-emerald-500/40',text: 'text-emerald-400' },
  completed:        { bg: 'bg-emerald-900/40',  border: 'border-emerald-500/50',text: 'text-emerald-300' },
  failed:           { bg: 'bg-red-900/40',      border: 'border-red-500/50',    text: 'text-red-300' },
  cancelled:        { bg: 'bg-gray-800/40',     border: 'border-gray-700/50',   text: 'text-gray-500' },
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

  return (
    <div className={`rounded-lg border px-3 py-2 min-w-[180px] max-w-[220px] shadow-lg ${colors.bg} ${colors.border}`}>
      <Handle type="target" position={Position.Top} className="!bg-gray-500 !w-2 !h-2" />
      <div className="flex items-center gap-1.5 mb-1">
        <span className={`w-2 h-2 rounded-full shrink-0 ${PRIORITY_INDICATOR[task.priority] ?? 'bg-gray-500'}`} />
        <span className={`text-[10px] font-medium uppercase tracking-wider ${colors.text}`}>
          {task.status.replace('_', ' ')}
        </span>
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

const nodeTypes: NodeTypes = {
  task: TaskNode as unknown as NodeTypes[string],
};

const NODE_WIDTH = 200;
const NODE_HEIGHT = 80;

function layoutNodes(nodes: Node[], edges: Edge[], direction: 'TB' | 'LR' = 'TB'): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: direction, nodesep: 40, ranksep: 60 });

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  return nodes.map(node => {
    const pos = g.node(node.id);
    return {
      ...node,
      position: {
        x: (pos?.x ?? 0) - NODE_WIDTH / 2,
        y: (pos?.y ?? 0) - NODE_HEIGHT / 2,
      },
    };
  });
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
  agents: AgentInfo[];
  onTaskClick?: (task: TaskInfo) => void;
  onDependencyChange?: () => void;
}

export function TaskDAG({ tasks, agents, onTaskClick, onDependencyChange }: TaskDAGProps) {
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Edge | null>(null);

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

  const makeEdge = useCallback((depId: string, taskId: string, status: string): Edge => ({
    id: `${depId}->${taskId}`,
    source: depId,
    target: taskId,
    animated: status === 'blocked',
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: status === 'blocked' ? '#ef4444' : '#6b7280' },
    style: { stroke: status === 'blocked' ? '#ef4444' : '#6b7280', strokeWidth: 1.5, cursor: 'pointer' },
  }), []);

  const { initialNodes, initialEdges } = useMemo(() => {
    const rootTasks = tasks.filter(t => !t.parentTaskId);

    const rawNodes: Node[] = rootTasks.map(task => ({
      id: task.id,
      type: 'task',
      data: { task, agentName: task.assignedAgentId ? agentMap.get(task.assignedAgentId) : undefined },
      position: { x: 0, y: 0 },
    }));

    const nodeIdSet = new Set(rawNodes.map(n => n.id));

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

    const layouted = layoutNodes(rawNodes, rawEdges);
    return { initialNodes: layouted, initialEdges: rawEdges };
  }, [tasks, agentMap, taskMap, makeEdge]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges, setNodes, setEdges]);

  const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    const task = taskMap.get(node.id);
    if (task && onTaskClick) onTaskClick(task);
  }, [taskMap, onTaskClick]);

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
          className="!bg-gray-900 !border-gray-700 !shadow-xl [&>button]:!bg-gray-800 [&>button]:!border-gray-700 [&>button]:!text-gray-300 [&>button:hover]:!bg-gray-700"
        />
        <MiniMap
          nodeColor={(node) => {
            const status = (node.data as { task: TaskInfo })?.task?.status;
            if (status === 'completed' || status === 'accepted') return '#10b981';
            if (status === 'in_progress') return '#f59e0b';
            if (status === 'blocked' || status === 'failed') return '#ef4444';
            return '#6b7280';
          }}
          maskColor="rgba(0,0,0,0.7)"
          className="!bg-gray-900 !border-gray-700"
        />
      </ReactFlow>

      {/* Hint bar */}
      <div className="absolute top-2 left-1/2 -translate-x-1/2 px-3 py-1.5 bg-gray-900/90 border border-gray-700 rounded-lg text-[11px] text-gray-400 pointer-events-none select-none backdrop-blur-sm">
        Drag from one node to another to add a dependency · Click an edge to remove it
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
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-5 shadow-2xl max-w-sm" onClick={e => e.stopPropagation()}>
            <h4 className="text-sm font-semibold text-gray-200 mb-2">Remove dependency?</h4>
            <p className="text-xs text-gray-400 mb-4 leading-relaxed">
              <span className="text-gray-300 font-medium">{targetTask?.title ?? pendingDelete.target.slice(-8)}</span>
              {' '}will no longer be blocked by{' '}
              <span className="text-gray-300 font-medium">{sourceTask?.title ?? pendingDelete.source.slice(-8)}</span>.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setPendingDelete(null)} className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 bg-gray-800 rounded-lg border border-gray-700 hover:border-gray-600 transition-colors">
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
