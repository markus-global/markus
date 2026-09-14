import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import enCommon from '../locales/en/common.json';
import enNav from '../locales/en/nav.json';
import enAuth from '../locales/en/auth.json';
import enHome from '../locales/en/home.json';
import enTeam from '../locales/en/team.json';
import enWork from '../locales/en/work.json';
import enSettings from '../locales/en/settings.json';
import enOnboarding from '../locales/en/onboarding.json';
import enBuilder from '../locales/en/builder.json';
import enStore from '../locales/en/store.json';
import enAgent from '../locales/en/agent.json';
import enDeliverables from '../locales/en/deliverables.json';
import enReports from '../locales/en/reports.json';
import enShowcase from '../locales/en/showcase.json';

import zhCommon from '../locales/zh-CN/common.json';
import zhNav from '../locales/zh-CN/nav.json';
import zhAuth from '../locales/zh-CN/auth.json';
import zhHome from '../locales/zh-CN/home.json';
import zhTeam from '../locales/zh-CN/team.json';
import zhWork from '../locales/zh-CN/work.json';
import zhSettings from '../locales/zh-CN/settings.json';
import zhOnboarding from '../locales/zh-CN/onboarding.json';
import zhBuilder from '../locales/zh-CN/builder.json';
import zhStore from '../locales/zh-CN/store.json';
import zhAgent from '../locales/zh-CN/agent.json';
import zhDeliverables from '../locales/zh-CN/deliverables.json';
import zhReports from '../locales/zh-CN/reports.json';
import zhShowcase from '../locales/zh-CN/showcase.json';

import esCommon from '../locales/es/common.json';
import esNav from '../locales/es/nav.json';
import esAuth from '../locales/es/auth.json';
import esHome from '../locales/es/home.json';
import esTeam from '../locales/es/team.json';
import esWork from '../locales/es/work.json';
import esSettings from '../locales/es/settings.json';
import esOnboarding from '../locales/es/onboarding.json';
import esBuilder from '../locales/es/builder.json';
import esStore from '../locales/es/store.json';
import esAgent from '../locales/es/agent.json';
import esDeliverables from '../locales/es/deliverables.json';
import esReports from '../locales/es/reports.json';
import esShowcase from '../locales/es/showcase.json';

export const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'zh-CN', label: '中文' },
  { code: 'es', label: 'Español' },
] as const;

export const DEFAULT_NS = 'common';
export const NAMESPACES = [
  'common', 'nav', 'auth', 'home', 'team', 'work',
  'settings', 'onboarding', 'builder', 'store',
  'agent', 'deliverables', 'reports', 'showcase',
] as const;

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: {
        common: enCommon,
        nav: enNav,
        auth: enAuth,
        home: enHome,
        team: enTeam,
        work: enWork,
        settings: enSettings,
        onboarding: enOnboarding,
        builder: enBuilder,
        store: enStore,
        agent: enAgent,
        deliverables: enDeliverables,
        reports: enReports,
        showcase: enShowcase,
      },
      'zh-CN': {
        common: zhCommon,
        nav: zhNav,
        auth: zhAuth,
        home: zhHome,
        team: zhTeam,
        work: zhWork,
        settings: zhSettings,
        onboarding: zhOnboarding,
        builder: zhBuilder,
        store: zhStore,
        agent: zhAgent,
        deliverables: zhDeliverables,
        reports: zhReports,
        showcase: zhShowcase,
      },
      es: {
        common: esCommon,
        nav: esNav,
        auth: esAuth,
        home: esHome,
        team: esTeam,
        work: esWork,
        settings: esSettings,
        onboarding: esOnboarding,
        builder: esBuilder,
        store: esStore,
        agent: esAgent,
        deliverables: esDeliverables,
        reports: esReports,
        showcase: esShowcase,
      },
    },
    fallbackLng: 'en',
    defaultNS: DEFAULT_NS,
    ns: [...NAMESPACES],
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'markus-language',
      caches: ['localStorage'],
    },
  });

export default i18n;
