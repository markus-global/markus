import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'Markus',
  tagline: 'AI Native Digital Employee Platform — Build AI teams that actually deliver.',
  favicon: 'img/favicon.svg',

  url: 'https://markus.global',
  baseUrl: '/',

  organizationName: 'markus-global',
  projectName: 'markus',

  onBrokenLinks: 'warn',
  onBrokenMarkdownLinks: 'warn',

  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'zh-CN'],
    localeConfigs: {
      en: { label: 'English' },
      'zh-CN': { label: '中文' },
    },
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/markus-global/markus/edit/main/website/',
          showLastUpdateTime: true,
          showLastUpdateAuthor: true,
        },
        blog: {
          showReadingTime: true,
          editUrl: 'https://github.com/markus-global/markus/edit/main/website/blog/',
        },
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/markus-og.jpg',
    navbar: {
      title: 'Markus',
      logo: {
        alt: 'Markus Logo',
        src: 'img/logo.png',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docsSidebar',
          position: 'left',
          label: 'Docs',
        },
        { to: '/blog', label: 'Blog', position: 'left' },
        {
          href: 'https://github.com/markus-global/markus',
          label: 'GitHub',
          position: 'right',
        },
        {
          type: 'localeDropdown',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            { label: 'Getting Started', to: '/docs/intro' },
            { label: 'Architecture', to: '/docs/architecture/overview' },
            { label: 'API Reference', to: '/docs/api/overview' },
            { label: 'Contributing', to: '/docs/contributing/how-to-contribute' },
          ],
        },
        {
          title: 'Community',
          items: [
            { label: 'GitHub', href: 'https://github.com/markus-global/markus' },
            { label: 'Discussions', href: 'https://github.com/markus-global/markus/discussions' },
          ],
        },
        {
          title: 'More',
          items: [
            { label: 'Blog', to: '/blog' },
            { label: 'Website', href: 'https://markus.global' },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Markus. AGPL-3.0 License.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'typescript', 'json', 'yaml'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
