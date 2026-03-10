import { useMemo, useCallback } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  type NodeTypes,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from '@dagrejs/dagre';
import type { TaskInfo, AgentInfo } from '../api.ts';

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

interface TaskDAGProps {
  tasks: TaskInfo[];
  agents: AgentInfo[];
  onTaskClick?: (task: TaskInfo) => void;
}

export function TaskDAG({ tasks, agents, onTaskClick }: TaskDAGProps) {
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
            rawEdges.push({
              id: `${depId}->${task.id}`,
              source: depId,
              target: task.id,
              animated: task.status === 'blocked',
              style: { stroke: task.status === 'blocked' ? '#ef4444' : '#6b7280', strokeWidth: 1.5 },
            });
          }
        }
      }
    }

    const layouted = layoutNodes(rawNodes, rawEdges);
    return { initialNodes: layouted, initialEdges: rawEdges };
  }, [tasks, agentMap, taskMap]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  useMemo(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges, setNodes, setEdges]);

  const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    const task = taskMap.get(node.id);
    if (task && onTaskClick) onTaskClick(task);
  }, [taskMap, onTaskClick]);

  if (tasks.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
        No tasks to display
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0" style={{ height: '100%' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.3}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
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
    </div>
  );
}
