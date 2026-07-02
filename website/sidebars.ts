import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docsSidebar: [
    {
      type: 'category',
      label: 'Getting Started',
      collapsible: false,
      items: [
        'intro',
        'quick-start',
        'installation',
      ],
    },
    {
      type: 'category',
      label: 'Architecture',
      items: [
        'architecture/overview',
        'architecture/modules',
        'architecture/agent-lifecycle',
        'architecture/memory-system',
        'architecture/cognitive-architecture',
        'architecture/mailbox-system',
        'architecture/model-routing',
        'architecture/security',
      ],
    },
    {
      type: 'category',
      label: 'API Reference',
      items: [
        'api/overview',
        'api/agents',
        'api/tasks',
        'api/projects',
        'api/requirements',
        'api/chat',
        'api/deliverables',
        'api/integrations',
      ],
    },
    {
      type: 'category',
      label: 'Deployment',
      items: [
        'deployment/docker',
        'deployment/configuration',
        'deployment/remote-access',
      ],
    },
    {
      type: 'category',
      label: 'Contributing',
      items: [
        'contributing/how-to-contribute',
        'contributing/development-setup',
        'contributing/coding-standards',
        'contributing/testing',
        'contributing/pull-requests',
      ],
    },
    {
      type: 'link',
      label: 'System Architecture (Detailed)',
      href: 'https://github.com/markus-global/markus/blob/main/docs/ARCHITECTURE.md',
    },
    {
      type: 'link',
      label: 'State Machines',
      href: 'https://github.com/markus-global/markus/blob/main/docs/STATE-MACHINES.md',
    },
  ],
};

export default sidebars;
