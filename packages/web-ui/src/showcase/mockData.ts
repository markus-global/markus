import type { TFunction } from 'i18next';
import type {
  AgentInfo, HumanUserInfo, TeamInfo, TeamMemberInfo,
  TaskInfo, RequirementInfo, ProjectInfo, DeliverableInfo,
  OpsDashboard, GroupChatInfo, ChannelMessageInfo, StorageInfo,
} from '../api.ts';
import type { HomePreviewData } from '../pages/Home.tsx';

// ═══════════════════════════════════════════════════════════════════════════
// IDs
// ═══════════════════════════════════════════════════════════════════════════

const ORG = 'org-nexus';

const HUMAN_IDS = {
  alex: 'human-alex', sarah: 'human-sarah', james: 'human-james',
  emily: 'human-emily', michael: 'human-michael',
} as const;

const AGENT_IDS = {
  secretary: 'agent-secretary', chiefOfStaff: 'agent-cos', strategyAnalyst: 'agent-strategy',
  engLead: 'agent-eng-lead', srBackend: 'agent-sr-backend', backend: 'agent-backend',
  srFrontend: 'agent-sr-frontend', frontend: 'agent-frontend', mobile: 'agent-mobile',
  devops: 'agent-devops', qaLead: 'agent-qa-lead', qaEng: 'agent-qa-eng',
  security: 'agent-security',
  pm: 'agent-pm', uxResearcher: 'agent-ux', uiDesigner: 'agent-ui', dataAnalyst: 'agent-data',
  researchLead: 'agent-research-lead', mlEngineer: 'agent-ml', researchAnalyst: 'agent-research',
  techWriter: 'agent-tech-writer',
  contentLead: 'agent-content-lead', seo: 'agent-seo', socialMedia: 'agent-social',
  copywriter: 'agent-copywriter',
  hr: 'agent-hr', legal: 'agent-legal', finance: 'agent-finance',
} as const;

const TEAM_IDS = {
  engineering: 'team-engineering', productDesign: 'team-product-design',
  research: 'team-research', content: 'team-content',
  operations: 'team-operations', projectAlpha: 'team-project-alpha',
} as const;

const PROJECT_IDS = {
  payment: 'proj-payment', dashboard: 'proj-dashboard',
  research: 'proj-q2-research', mobile: 'proj-mobile', securityAudit: 'proj-security',
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// Factory
// ═══════════════════════════════════════════════════════════════════════════

export function createMockData(t: TFunction) {
  const ts = (key: string) => t(`showcase:${key}`);

  // ── Founding Team (5 humans) ───────────────────────────────────────────
  const humans: HumanUserInfo[] = [
    { id: HUMAN_IDS.alex, name: ts('humans.alex.name'), role: 'owner', orgId: ORG, avatarUrl: '/avatars/alex.jpg' },
    { id: HUMAN_IDS.sarah, name: ts('humans.sarah.name'), role: 'admin', orgId: ORG, avatarUrl: '/avatars/sarah.jpg' },
    { id: HUMAN_IDS.james, name: ts('humans.james.name'), role: 'admin', orgId: ORG, avatarUrl: '/avatars/james.jpg' },
    { id: HUMAN_IDS.emily, name: ts('humans.emily.name'), role: 'member', orgId: ORG, avatarUrl: '/avatars/emily.jpg' },
    { id: HUMAN_IDS.michael, name: ts('humans.michael.name'), role: 'member', orgId: ORG, avatarUrl: '/avatars/michael.jpg' },
  ];

  // ── Digital Employees (30 agents) ──────────────────────────────────────
  const agentDefs: Array<{ id: string; nameKey: string; roleKey: string; activityKey: string; status: string; teamId?: string; agentRole?: 'manager' | 'worker' }> = [
    { id: AGENT_IDS.secretary, nameKey: 'agents.secretary.name', roleKey: 'agents.secretary.role', activityKey: 'agents.secretary.activity', status: 'working', agentRole: 'manager' },
    { id: AGENT_IDS.chiefOfStaff, nameKey: 'agents.chiefOfStaff.name', roleKey: 'agents.chiefOfStaff.role', activityKey: 'agents.chiefOfStaff.activity', status: 'working', agentRole: 'manager' },
    { id: AGENT_IDS.strategyAnalyst, nameKey: 'agents.strategyAnalyst.name', roleKey: 'agents.strategyAnalyst.role', activityKey: 'agents.strategyAnalyst.activity', status: 'idle' },
    // Engineering
    { id: AGENT_IDS.engLead, nameKey: 'agents.engLead.name', roleKey: 'agents.engLead.role', activityKey: 'agents.engLead.activity', status: 'working', teamId: TEAM_IDS.engineering, agentRole: 'manager' },
    { id: AGENT_IDS.srBackend, nameKey: 'agents.srBackend.name', roleKey: 'agents.srBackend.role', activityKey: 'agents.srBackend.activity', status: 'working', teamId: TEAM_IDS.engineering },
    { id: AGENT_IDS.backend, nameKey: 'agents.backend.name', roleKey: 'agents.backend.role', activityKey: 'agents.backend.activity', status: 'working', teamId: TEAM_IDS.engineering },
    { id: AGENT_IDS.srFrontend, nameKey: 'agents.srFrontend.name', roleKey: 'agents.srFrontend.role', activityKey: 'agents.srFrontend.activity', status: 'working', teamId: TEAM_IDS.engineering },
    { id: AGENT_IDS.frontend, nameKey: 'agents.frontend.name', roleKey: 'agents.frontend.role', activityKey: 'agents.frontend.activity', status: 'working', teamId: TEAM_IDS.engineering },
    { id: AGENT_IDS.mobile, nameKey: 'agents.mobile.name', roleKey: 'agents.mobile.role', activityKey: 'agents.mobile.activity', status: 'idle', teamId: TEAM_IDS.engineering },
    { id: AGENT_IDS.devops, nameKey: 'agents.devops.name', roleKey: 'agents.devops.role', activityKey: 'agents.devops.activity', status: 'working', teamId: TEAM_IDS.engineering },
    { id: AGENT_IDS.qaLead, nameKey: 'agents.qaLead.name', roleKey: 'agents.qaLead.role', activityKey: 'agents.qaLead.activity', status: 'working', teamId: TEAM_IDS.engineering },
    { id: AGENT_IDS.qaEng, nameKey: 'agents.qaEng.name', roleKey: 'agents.qaEng.role', activityKey: 'agents.qaEng.activity', status: 'working', teamId: TEAM_IDS.engineering },
    { id: AGENT_IDS.security, nameKey: 'agents.security.name', roleKey: 'agents.security.role', activityKey: 'agents.security.activity', status: 'idle', teamId: TEAM_IDS.engineering },
    // Product & Design
    { id: AGENT_IDS.pm, nameKey: 'agents.pm.name', roleKey: 'agents.pm.role', activityKey: 'agents.pm.activity', status: 'working', teamId: TEAM_IDS.productDesign },
    { id: AGENT_IDS.uxResearcher, nameKey: 'agents.uxResearcher.name', roleKey: 'agents.uxResearcher.role', activityKey: 'agents.uxResearcher.activity', status: 'idle', teamId: TEAM_IDS.productDesign },
    { id: AGENT_IDS.uiDesigner, nameKey: 'agents.uiDesigner.name', roleKey: 'agents.uiDesigner.role', activityKey: 'agents.uiDesigner.activity', status: 'working', teamId: TEAM_IDS.productDesign },
    { id: AGENT_IDS.dataAnalyst, nameKey: 'agents.dataAnalyst.name', roleKey: 'agents.dataAnalyst.role', activityKey: 'agents.dataAnalyst.activity', status: 'working', teamId: TEAM_IDS.productDesign },
    // Research & AI
    { id: AGENT_IDS.researchLead, nameKey: 'agents.researchLead.name', roleKey: 'agents.researchLead.role', activityKey: 'agents.researchLead.activity', status: 'working', teamId: TEAM_IDS.research, agentRole: 'manager' },
    { id: AGENT_IDS.mlEngineer, nameKey: 'agents.mlEngineer.name', roleKey: 'agents.mlEngineer.role', activityKey: 'agents.mlEngineer.activity', status: 'working', teamId: TEAM_IDS.research },
    { id: AGENT_IDS.researchAnalyst, nameKey: 'agents.researchAnalyst.name', roleKey: 'agents.researchAnalyst.role', activityKey: 'agents.researchAnalyst.activity', status: 'working', teamId: TEAM_IDS.research },
    { id: AGENT_IDS.techWriter, nameKey: 'agents.techWriter.name', roleKey: 'agents.techWriter.role', activityKey: 'agents.techWriter.activity', status: 'working', teamId: TEAM_IDS.research },
    // Content & Growth
    { id: AGENT_IDS.contentLead, nameKey: 'agents.contentLead.name', roleKey: 'agents.contentLead.role', activityKey: 'agents.contentLead.activity', status: 'working', teamId: TEAM_IDS.content, agentRole: 'manager' },
    { id: AGENT_IDS.seo, nameKey: 'agents.seo.name', roleKey: 'agents.seo.role', activityKey: 'agents.seo.activity', status: 'idle', teamId: TEAM_IDS.content },
    { id: AGENT_IDS.socialMedia, nameKey: 'agents.socialMedia.name', roleKey: 'agents.socialMedia.role', activityKey: 'agents.socialMedia.activity', status: 'working', teamId: TEAM_IDS.content },
    { id: AGENT_IDS.copywriter, nameKey: 'agents.copywriter.name', roleKey: 'agents.copywriter.role', activityKey: 'agents.copywriter.activity', status: 'working', teamId: TEAM_IDS.content },
    // Operations
    { id: AGENT_IDS.hr, nameKey: 'agents.hr.name', roleKey: 'agents.hr.role', activityKey: 'agents.hr.activity', status: 'idle', teamId: TEAM_IDS.operations },
    { id: AGENT_IDS.legal, nameKey: 'agents.legal.name', roleKey: 'agents.legal.role', activityKey: 'agents.legal.activity', status: 'idle', teamId: TEAM_IDS.operations },
    { id: AGENT_IDS.finance, nameKey: 'agents.finance.name', roleKey: 'agents.finance.role', activityKey: 'agents.finance.activity', status: 'working', teamId: TEAM_IDS.operations },
  ];

  const agents: AgentInfo[] = agentDefs.map(d => ({
    id: d.id,
    name: ts(d.nameKey),
    role: ts(d.roleKey),
    status: d.status,
    skills: [],
    agentRole: d.agentRole ?? 'worker',
    teamId: d.teamId,
    currentActivity: d.status === 'working' ? { label: ts(d.activityKey), startedAt: new Date(Date.now() - Math.random() * 3600000).toISOString() } : undefined,
  }));

  // ── Teams ──────────────────────────────────────────────────────────────
  function member(id: string, name: string, type: 'human' | 'agent', role: string, agentRole?: 'manager' | 'worker', status?: string): TeamMemberInfo {
    return { id, name, type, role, agentRole, status, teamId: undefined };
  }

  const teams: TeamInfo[] = [
    {
      id: TEAM_IDS.engineering, orgId: ORG, name: ts('teams.engineering.name'),
      description: ts('teams.engineering.desc'),
      managerId: HUMAN_IDS.sarah, managerType: 'human', managerName: ts('humans.sarah.name'),
      members: [
        member(HUMAN_IDS.sarah, ts('humans.sarah.name'), 'human', 'admin'),
        ...agentDefs.filter(a => a.teamId === TEAM_IDS.engineering).map(a => member(a.id, ts(a.nameKey), 'agent', ts(a.roleKey), a.agentRole, a.status)),
      ],
    },
    {
      id: TEAM_IDS.productDesign, orgId: ORG, name: ts('teams.productDesign.name'),
      description: ts('teams.productDesign.desc'),
      managerId: HUMAN_IDS.james, managerType: 'human', managerName: ts('humans.james.name'),
      members: [
        member(HUMAN_IDS.james, ts('humans.james.name'), 'human', 'admin'),
        member(HUMAN_IDS.emily, ts('humans.emily.name'), 'human', 'member'),
        ...agentDefs.filter(a => a.teamId === TEAM_IDS.productDesign).map(a => member(a.id, ts(a.nameKey), 'agent', ts(a.roleKey), a.agentRole, a.status)),
      ],
    },
    {
      id: TEAM_IDS.research, orgId: ORG, name: ts('teams.research.name'),
      description: ts('teams.research.desc'),
      managerId: AGENT_IDS.researchLead, managerType: 'agent', managerName: ts('agents.researchLead.name'),
      members: agentDefs.filter(a => a.teamId === TEAM_IDS.research).map(a => member(a.id, ts(a.nameKey), 'agent', ts(a.roleKey), a.agentRole, a.status)),
    },
    {
      id: TEAM_IDS.content, orgId: ORG, name: ts('teams.content.name'),
      description: ts('teams.content.desc'),
      managerId: AGENT_IDS.contentLead, managerType: 'agent', managerName: ts('agents.contentLead.name'),
      members: agentDefs.filter(a => a.teamId === TEAM_IDS.content).map(a => member(a.id, ts(a.nameKey), 'agent', ts(a.roleKey), a.agentRole, a.status)),
    },
    {
      id: TEAM_IDS.operations, orgId: ORG, name: ts('teams.operations.name'),
      description: ts('teams.operations.desc'),
      managerId: HUMAN_IDS.michael, managerType: 'human', managerName: ts('humans.michael.name'),
      members: [
        member(HUMAN_IDS.michael, ts('humans.michael.name'), 'human', 'member'),
        ...agentDefs.filter(a => a.teamId === TEAM_IDS.operations).map(a => member(a.id, ts(a.nameKey), 'agent', ts(a.roleKey), a.agentRole, a.status)),
      ],
    },
    {
      id: TEAM_IDS.projectAlpha, orgId: ORG, name: ts('teams.projectAlpha.name'),
      description: ts('teams.projectAlpha.desc'),
      managerId: AGENT_IDS.engLead, managerType: 'agent', managerName: ts('agents.engLead.name'),
      members: [
        member(HUMAN_IDS.sarah, ts('humans.sarah.name'), 'human', 'admin'),
        member(HUMAN_IDS.james, ts('humans.james.name'), 'human', 'admin'),
        member(AGENT_IDS.engLead, ts('agents.engLead.name'), 'agent', ts('agents.engLead.role'), 'manager', 'working'),
        member(AGENT_IDS.srBackend, ts('agents.srBackend.name'), 'agent', ts('agents.srBackend.role'), 'worker', 'working'),
        member(AGENT_IDS.mobile, ts('agents.mobile.name'), 'agent', ts('agents.mobile.role'), 'worker', 'idle'),
        member(AGENT_IDS.qaLead, ts('agents.qaLead.name'), 'agent', ts('agents.qaLead.role'), 'worker', 'working'),
      ],
    },
  ];

  // ── Projects ───────────────────────────────────────────────────────────
  const now = new Date().toISOString();
  const projects: ProjectInfo[] = [
    { id: PROJECT_IDS.payment, orgId: ORG, name: ts('projects.payment.name'), description: ts('projects.payment.desc'), status: 'active', teamIds: [TEAM_IDS.engineering, TEAM_IDS.projectAlpha], createdAt: now, updatedAt: now },
    { id: PROJECT_IDS.dashboard, orgId: ORG, name: ts('projects.dashboard.name'), description: ts('projects.dashboard.desc'), status: 'active', teamIds: [TEAM_IDS.engineering, TEAM_IDS.productDesign], createdAt: now, updatedAt: now },
    { id: PROJECT_IDS.research, orgId: ORG, name: ts('projects.research.name'), description: ts('projects.research.desc'), status: 'active', teamIds: [TEAM_IDS.research, TEAM_IDS.content], createdAt: now, updatedAt: now },
    { id: PROJECT_IDS.mobile, orgId: ORG, name: ts('projects.mobile.name'), description: ts('projects.mobile.desc'), status: 'active', teamIds: [TEAM_IDS.engineering], createdAt: now, updatedAt: now },
    { id: PROJECT_IDS.securityAudit, orgId: ORG, name: ts('projects.securityAudit.name'), description: ts('projects.securityAudit.desc'), status: 'completed', teamIds: [TEAM_IDS.engineering], createdAt: now, updatedAt: now },
  ];

  // ── Tasks (board format: status -> TaskInfo[]) ─────────────────────────
  let taskCounter = 0;
  function task(titleKey: string, status: string, agentId: string, priority: string, projectId?: string, extras?: Partial<TaskInfo>): TaskInfo {
    taskCounter++;
    return {
      id: `task-${taskCounter}`, title: ts(titleKey), description: '', status, priority,
      assignedAgentId: agentId, reviewerId: HUMAN_IDS.sarah, projectId,
      createdAt: now, updatedAt: now, ...extras,
    };
  }

  const board: Record<string, TaskInfo[]> = {
    completed: [
      task('tasks.paymentWebhook', 'completed', AGENT_IDS.srBackend, 'high', PROJECT_IDS.payment),
      task('tasks.dbSchema', 'completed', AGENT_IDS.backend, 'high', PROJECT_IDS.payment),
      task('tasks.userResearch', 'completed', AGENT_IDS.uxResearcher, 'medium', PROJECT_IDS.dashboard),
      task('tasks.competitorReport', 'completed', AGENT_IDS.researchLead, 'high', PROJECT_IDS.research),
      task('tasks.cicdSetup', 'completed', AGENT_IDS.devops, 'high', PROJECT_IDS.payment),
      task('tasks.designTokens', 'completed', AGENT_IDS.uiDesigner, 'medium', PROJECT_IDS.dashboard),
      task('tasks.authFlow', 'completed', AGENT_IDS.srBackend, 'high', PROJECT_IDS.payment),
      task('tasks.loadTesting', 'completed', AGENT_IDS.qaLead, 'medium', PROJECT_IDS.payment),
      task('tasks.seoMatrix', 'completed', AGENT_IDS.seo, 'low', PROJECT_IDS.research),
      task('tasks.privacyDraft', 'completed', AGENT_IDS.legal, 'high'),
      task('tasks.q1Finance', 'completed', AGENT_IDS.finance, 'medium'),
      task('tasks.testFramework', 'completed', AGENT_IDS.qaLead, 'high', PROJECT_IDS.payment),
    ],
    in_progress: [
      task('tasks.paymentReconciliation', 'in_progress', AGENT_IDS.srBackend, 'high', PROJECT_IDS.payment),
      task('tasks.dashboardCharts', 'in_progress', AGENT_IDS.srFrontend, 'medium', PROJECT_IDS.dashboard),
      task('tasks.mobileOnboarding', 'in_progress', AGENT_IDS.mobile, 'medium', PROJECT_IDS.mobile),
      task('tasks.mlPipeline', 'in_progress', AGENT_IDS.mlEngineer, 'high', PROJECT_IDS.research),
      task('tasks.rateLimiting', 'in_progress', AGENT_IDS.backend, 'high', PROJECT_IDS.payment),
      task('tasks.editorialCalendar', 'in_progress', AGENT_IDS.contentLead, 'low'),
      task('tasks.funnelAnalysis', 'in_progress', AGENT_IDS.dataAnalyst, 'medium', PROJECT_IDS.dashboard),
      task('tasks.componentDocs', 'in_progress', AGENT_IDS.frontend, 'low', PROJECT_IDS.dashboard),
      task('tasks.regressionSuite', 'in_progress', AGENT_IDS.qaEng, 'high', PROJECT_IDS.payment),
      task('tasks.socialCampaign', 'in_progress', AGENT_IDS.socialMedia, 'low'),
    ],
    review: [
      task('tasks.idempotency', 'review', AGENT_IDS.srBackend, 'high', PROJECT_IDS.payment),
      task('tasks.landingMockup', 'review', AGENT_IDS.uiDesigner, 'medium', PROJECT_IDS.dashboard),
      task('tasks.patentReport', 'review', AGENT_IDS.researchAnalyst, 'medium', PROJECT_IDS.research),
      task('tasks.apiDocsV2', 'review', AGENT_IDS.techWriter, 'medium'),
      task('tasks.monthlyFinance', 'review', AGENT_IDS.finance, 'medium'),
      task('tasks.securityScan', 'review', AGENT_IDS.security, 'high', PROJECT_IDS.securityAudit),
    ],
    pending: [
      task('tasks.disputeHandling', 'pending', AGENT_IDS.srBackend, 'medium', PROJECT_IDS.payment),
      task('tasks.darkMode', 'pending', AGENT_IDS.srFrontend, 'low', PROJECT_IDS.dashboard),
      task('tasks.pushNotifications', 'pending', AGENT_IDS.mobile, 'medium', PROJECT_IDS.mobile),
      task('tasks.abTesting', 'pending', AGENT_IDS.dataAnalyst, 'medium'),
      task('tasks.blogAiWorkforce', 'pending', AGENT_IDS.copywriter, 'low'),
      task('tasks.offlineMode', 'pending', AGENT_IDS.mobile, 'medium', PROJECT_IDS.mobile),
      task('tasks.perfBenchmarks', 'pending', AGENT_IDS.devops, 'medium'),
      task('tasks.emailOnboarding', 'pending', AGENT_IDS.socialMedia, 'low'),
    ],
    blocked: [
      task('tasks.mobilePayment', 'blocked', AGENT_IDS.mobile, 'high', PROJECT_IDS.mobile, { blockedBy: ['task-13'] }),
      task('tasks.deepLinking', 'blocked', AGENT_IDS.mobile, 'medium', PROJECT_IDS.mobile, { blockedBy: ['task-13'] }),
    ],
    failed: [
      task('tasks.legacyMigration', 'failed', AGENT_IDS.backend, 'medium', { result: ts('tasks.legacyMigrationError') }),
    ],
  };

  // ── Requirements ───────────────────────────────────────────────────────
  const requirements: RequirementInfo[] = [
    { id: 'req-1', title: ts('requirements.stripePaypal'), description: '', status: 'in_progress', priority: 'high', source: 'human', createdBy: HUMAN_IDS.alex, taskIds: ['task-1', 'task-13'], projectId: PROJECT_IDS.payment, createdAt: now, updatedAt: now },
    { id: 'req-2', title: ts('requirements.dashboardPerf'), description: '', status: 'pending', priority: 'high', source: 'human', createdBy: HUMAN_IDS.james, taskIds: [], projectId: PROJECT_IDS.dashboard, createdAt: now, updatedAt: now },
    { id: 'req-3', title: ts('requirements.openApiDocs'), description: '', status: 'in_progress', priority: 'medium', source: 'agent', createdBy: AGENT_IDS.techWriter, taskIds: ['task-26'], createdAt: now, updatedAt: now },
    { id: 'req-4', title: ts('requirements.offlineCore'), description: '', status: 'pending', priority: 'medium', source: 'human', createdBy: HUMAN_IDS.james, taskIds: [], projectId: PROJECT_IDS.mobile, createdAt: now, updatedAt: now },
    { id: 'req-5', title: ts('requirements.gdpr'), description: '', status: 'completed', priority: 'high', source: 'human', createdBy: HUMAN_IDS.michael, taskIds: ['task-10'], createdAt: now, updatedAt: now },
    { id: 'req-6', title: ts('requirements.monthlyReport'), description: '', status: 'in_progress', priority: 'medium', source: 'human', createdBy: HUMAN_IDS.alex, taskIds: ['task-27'], createdAt: now, updatedAt: now },
    { id: 'req-7', title: ts('requirements.competitiveQuarterly'), description: '', status: 'completed', priority: 'medium', source: 'human', createdBy: HUMAN_IDS.alex, taskIds: ['task-4'], projectId: PROJECT_IDS.research, createdAt: now, updatedAt: now },
    { id: 'req-8', title: ts('requirements.paymentSla'), description: '', status: 'in_progress', priority: 'high', source: 'human', createdBy: HUMAN_IDS.sarah, taskIds: ['task-8'], projectId: PROJECT_IDS.payment, createdAt: now, updatedAt: now },
  ];

  // ── Deliverables ───────────────────────────────────────────────────────
  const deliverables: DeliverableInfo[] = [
    { id: 'del-1', type: 'file', title: ts('deliverables.paymentApiSpec'), summary: '', reference: '/deliverables/payment-api-v2.yaml', tags: ['api', 'payment'], status: 'verified', agentId: AGENT_IDS.srBackend, projectId: PROJECT_IDS.payment, accessCount: 24, createdAt: now, updatedAt: now },
    { id: 'del-2', type: 'directory', title: ts('deliverables.dashboardMockups'), summary: '', reference: '/deliverables/dashboard-redesign/', tags: ['design', 'ui'], status: 'active', agentId: AGENT_IDS.uiDesigner, projectId: PROJECT_IDS.dashboard, accessCount: 12, createdAt: now, updatedAt: now },
    { id: 'del-3', type: 'file', title: ts('deliverables.q2Report'), summary: '', reference: '/deliverables/q2-competitive-report.pdf', tags: ['research', 'strategy'], status: 'active', agentId: AGENT_IDS.researchLead, projectId: PROJECT_IDS.research, accessCount: 8, createdAt: now, updatedAt: now },
    { id: 'del-4', type: 'file', title: ts('deliverables.cicdConfig'), summary: '', reference: '/deliverables/cicd-pipeline.yaml', tags: ['devops', 'ci'], status: 'verified', agentId: AGENT_IDS.devops, projectId: PROJECT_IDS.payment, accessCount: 18, createdAt: now, updatedAt: now },
    { id: 'del-5', type: 'file', title: ts('deliverables.componentDocs'), summary: '', reference: '/deliverables/component-library.md', tags: ['docs', 'frontend'], status: 'active', agentId: AGENT_IDS.frontend, projectId: PROJECT_IDS.dashboard, accessCount: 6, createdAt: now, updatedAt: now },
    { id: 'del-6', type: 'file', title: ts('deliverables.securityReport'), summary: '', reference: '/deliverables/security-audit-q1.pdf', tags: ['security', 'audit'], status: 'verified', agentId: AGENT_IDS.security, projectId: PROJECT_IDS.securityAudit, accessCount: 15, createdAt: now, updatedAt: now },
    { id: 'del-7', type: 'directory', title: ts('deliverables.mlResults'), summary: '', reference: '/deliverables/ml-training/', tags: ['ml', 'ai'], status: 'active', agentId: AGENT_IDS.mlEngineer, projectId: PROJECT_IDS.research, accessCount: 4, createdAt: now, updatedAt: now },
    { id: 'del-8', type: 'file', title: ts('deliverables.seoMatrix'), summary: '', reference: '/deliverables/seo-keywords.xlsx', tags: ['seo', 'marketing'], status: 'verified', agentId: AGENT_IDS.seo, accessCount: 10, createdAt: now, updatedAt: now },
    { id: 'del-9', type: 'file', title: ts('deliverables.financeReport'), summary: '', reference: '/deliverables/monthly-finance-may.pdf', tags: ['finance'], status: 'active', agentId: AGENT_IDS.finance, accessCount: 3, createdAt: now, updatedAt: now },
    { id: 'del-10', type: 'file', title: ts('deliverables.apiDocsV2'), summary: '', reference: '/deliverables/api-docs-v2.md', tags: ['docs', 'api'], status: 'active', agentId: AGENT_IDS.techWriter, accessCount: 7, createdAt: now, updatedAt: now },
    { id: 'del-11', type: 'directory', title: ts('deliverables.interviewNotes'), summary: '', reference: '/deliverables/user-research/', tags: ['research', 'ux'], status: 'verified', agentId: AGENT_IDS.uxResearcher, projectId: PROJECT_IDS.dashboard, accessCount: 5, createdAt: now, updatedAt: now },
    { id: 'del-12', type: 'file', title: ts('deliverables.wireframes'), summary: '', reference: '/deliverables/mobile-wireframes.fig', tags: ['design', 'mobile'], status: 'active', agentId: AGENT_IDS.uiDesigner, projectId: PROJECT_IDS.mobile, accessCount: 9, createdAt: now, updatedAt: now },
    { id: 'del-13', type: 'file', title: ts('deliverables.patentAnalysis'), summary: '', reference: '/deliverables/patent-landscape.pdf', tags: ['research', 'legal'], status: 'active', agentId: AGENT_IDS.researchAnalyst, projectId: PROJECT_IDS.research, accessCount: 2, createdAt: now, updatedAt: now },
    { id: 'del-14', type: 'file', title: ts('deliverables.testFramework'), summary: '', reference: '/deliverables/test-framework/', artifactType: 'skill', tags: ['testing', 'automation'], status: 'verified', agentId: AGENT_IDS.qaLead, projectId: PROJECT_IDS.payment, accessCount: 11, createdAt: now, updatedAt: now },
    { id: 'del-15', type: 'directory', title: ts('deliverables.socialAssets'), summary: '', reference: '/deliverables/social-media/', tags: ['marketing', 'design'], status: 'active', agentId: AGENT_IDS.socialMedia, accessCount: 6, createdAt: now, updatedAt: now },
  ];

  // ── Group Chats ────────────────────────────────────────────────────────
  const allMembersList = [
    ...humans.map(h => ({ id: h.id, name: h.name, type: 'human' as const })),
    ...agents.map(a => ({ id: a.id, name: a.name, type: 'agent' as const })),
  ];

  const groupChats: GroupChatInfo[] = [
    { id: 'gc-general', name: ts('channels.general'), type: 'custom', channelKey: 'custom:general', memberCount: 35, members: allMembersList },
    { id: 'gc-announcements', name: ts('channels.announcements'), type: 'custom', channelKey: 'custom:announcements', memberCount: 35, members: allMembersList },
    { id: 'gc-watercooler', name: ts('channels.watercooler'), type: 'custom', channelKey: 'custom:watercooler', memberCount: 35, members: allMembersList },
  ];

  // ── Channel Messages ───────────────────────────────────────────────────
  function msg(channel: string, senderId: string, senderType: 'human' | 'agent', senderName: string, textKey: string, minutesAgo: number, mentions: string[] = []): ChannelMessageInfo {
    return {
      id: `msg-${Math.random().toString(36).slice(2, 8)}`,
      channel, senderId, senderType, senderName,
      text: ts(textKey), mentions,
      createdAt: new Date(Date.now() - minutesAgo * 60000).toISOString(),
    };
  }

  const channelMessages: ChannelMessageInfo[] = [
    // #general
    msg('custom:general', AGENT_IDS.secretary, 'agent', ts('agents.secretary.name'), 'messages.general.secretaryMorning', 120),
    msg('custom:general', HUMAN_IDS.alex, 'human', ts('humans.alex.name'), 'messages.general.alexReport', 115, [AGENT_IDS.researchLead]),
    msg('custom:general', AGENT_IDS.researchLead, 'agent', ts('agents.researchLead.name'), 'messages.general.researchLeadReply', 112),
    msg('custom:general', AGENT_IDS.engLead, 'agent', ts('agents.engLead.name'), 'messages.general.engLeadApi', 108, [AGENT_IDS.qaLead]),
    msg('custom:general', AGENT_IDS.qaLead, 'agent', ts('agents.qaLead.name'), 'messages.general.qaLeadReply', 105),
    // team:core-engineering
    msg('team:core-engineering', HUMAN_IDS.sarah, 'human', ts('humans.sarah.name'), 'messages.engineering.sarahArchitecture', 90),
    msg('team:core-engineering', AGENT_IDS.srBackend, 'agent', ts('agents.srBackend.name'), 'messages.engineering.srBackendReply', 85),
    msg('team:core-engineering', AGENT_IDS.devops, 'agent', ts('agents.devops.name'), 'messages.engineering.devopsCi', 80),
    msg('team:core-engineering', HUMAN_IDS.sarah, 'human', ts('humans.sarah.name'), 'messages.engineering.sarahBuildTime', 75, [AGENT_IDS.devops]),
    msg('team:core-engineering', AGENT_IDS.frontend, 'agent', ts('agents.frontend.name'), 'messages.engineering.frontendLib', 70),
    // team:product-design
    msg('team:product-design', HUMAN_IDS.james, 'human', ts('humans.james.name'), 'messages.product.jamesFunnel', 60, [AGENT_IDS.dataAnalyst]),
    msg('team:product-design', AGENT_IDS.pm, 'agent', ts('agents.pm.name'), 'messages.product.pmMockups', 55, [AGENT_IDS.uiDesigner]),
    msg('team:product-design', AGENT_IDS.uiDesigner, 'agent', ts('agents.uiDesigner.name'), 'messages.product.uiDesignerReply', 50),
    msg('team:product-design', HUMAN_IDS.emily, 'human', ts('humans.emily.name'), 'messages.product.emilyA11y', 45),
    msg('team:product-design', AGENT_IDS.dataAnalyst, 'agent', ts('agents.dataAnalyst.name'), 'messages.product.dataAnalystConversion', 40),
    // team:project-alpha
    msg('team:project-alpha', AGENT_IDS.engLead, 'agent', ts('agents.engLead.name'), 'messages.alpha.engLeadSprint', 30, [AGENT_IDS.mobile]),
    msg('team:project-alpha', AGENT_IDS.mobile, 'agent', ts('agents.mobile.name'), 'messages.alpha.mobileIntegration', 25),
    msg('team:project-alpha', HUMAN_IDS.james, 'human', ts('humans.james.name'), 'messages.alpha.jamesTimeline', 20, [AGENT_IDS.qaLead]),
    msg('team:project-alpha', AGENT_IDS.qaLead, 'agent', ts('agents.qaLead.name'), 'messages.alpha.qaLeadTestPlan', 15, [AGENT_IDS.security]),
  ];

  // ── Ops Dashboard ──────────────────────────────────────────────────────
  const allTasks = Object.values(board).flat();
  const ops: OpsDashboard = {
    period: '7d',
    generatedAt: now,
    systemHealth: {
      overallScore: 87,
      activeAgents: agents.filter(a => a.status === 'working').length,
      totalAgents: agents.length,
      criticalAgents: [],
      totalTokenCost: 847000000,
      totalInteractions: 1284,
    },
    taskKPI: {
      totalTasks: allTasks.length,
      statusCounts: Object.fromEntries(Object.entries(board).map(([s, t]) => [s, t.length])),
      successRate: 91.2,
      blockedCount: board.blocked?.length ?? 0,
      averageCompletionTimeMs: 15120000,
      recentActivity: allTasks.filter(t => t.status !== 'pending').slice(0, 15).map(t => ({
        taskId: t.id, title: t.title, status: t.status, updatedAt: t.updatedAt!,
      })),
    },
    agentEfficiency: agents.map((a, i) => ({
      agentId: a.id, agentName: a.name, role: a.role, agentRole: a.agentRole ?? 'worker', status: a.status,
      healthScore: Math.max(65, Math.min(98, 85 + Math.floor(Math.random() * 15 - 5))),
      tokenUsage: { input: 50000 + i * 3000, output: 30000 + i * 2000, cost: 0.5 + i * 0.1 },
      taskMetrics: {
        completed: Math.max(0, 12 - Math.floor(i / 2)),
        failed: i % 8 === 0 ? 1 : 0,
        cancelled: 0,
        averageCompletionTimeMs: 3600000 + Math.random() * 7200000,
      },
      averageResponseTimeMs: 500 + Math.random() * 2000,
      errorRate: i % 8 === 0 ? 0.08 : Math.random() * 0.05,
      totalInteractions: 30 + Math.floor(Math.random() * 60),
    })),
  };

  // ── Storage & Usage ────────────────────────────────────────────────────
  const storageInfo: StorageInfo = {
    dataDir: '/data/shared',
    totalSize: 2576980378,
    breakdown: [
      { name: 'Agents', path: '/data/shared/agents', size: 1073741824, description: 'Agent data' },
      { name: 'Deliverables', path: '/data/shared/deliverables', size: 858993459, description: 'Deliverable files' },
      { name: 'Database', path: '/data/shared/db', size: 644245095, description: 'Database' },
    ],
    agents: [],
    database: { path: '/data/shared/db/markus.db', size: 644245095 },
  };

  const usageInfo = { llmTokens: 847000000, storageBytes: 2576980378 };

  // ── Assemble HomePreviewData ───────────────────────────────────────────
  const homePreviewData: HomePreviewData = {
    agents,
    teams,
    board,
    ops,
    requirements,
    projects,
    deliverableTotal: deliverables.length,
    storageInfo,
    usageInfo,
  };

  return {
    humans,
    agents,
    teams,
    projects,
    board,
    requirements,
    deliverables,
    groupChats,
    channelMessages,
    ops,
    storageInfo,
    usageInfo,
    homePreviewData,
  };
}

export type MockData = ReturnType<typeof createMockData>;
