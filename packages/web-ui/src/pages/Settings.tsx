import { useEffect, useState } from 'react';
import { api } from '../api.ts';

export function Settings() {
  const [health, setHealth] = useState<{ status: string; version: string; agents: number } | null>(null);

  useEffect(() => {
    api.health().then(setHealth).catch(() => {});
  }, []);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-7 h-15 flex items-center border-b border-gray-800 bg-gray-900">
        <h2 className="text-lg font-semibold">Settings</h2>
      </div>
      <div className="p-7 space-y-8 max-w-3xl">
        {/* System Status */}
        <Section title="System Status">
          {health ? (
            <div className="grid grid-cols-3 gap-4">
              <InfoCard label="Status" value={health.status === 'ok' ? 'Healthy' : health.status} color="green" />
              <InfoCard label="Version" value={health.version} color="indigo" />
              <InfoCard label="Active Agents" value={String(health.agents)} color="purple" />
            </div>
          ) : (
            <div className="text-sm text-gray-500">Loading...</div>
          )}
        </Section>

        {/* Organization */}
        <Section title="Organization">
          <SettingRow label="Organization Name" description="Name of your AI organization">
            <input defaultValue="My Organization" className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm w-60 focus:border-indigo-500 outline-none" />
          </SettingRow>
          <SettingRow label="Max Agents" description="Maximum number of agents allowed">
            <input defaultValue="5" type="number" className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm w-24 focus:border-indigo-500 outline-none" />
          </SettingRow>
        </Section>

        {/* LLM Providers */}
        <Section title="LLM Providers">
          <SettingRow label="Default Provider" description="Primary LLM provider for agents">
            <select className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm w-40 focus:border-indigo-500 outline-none">
              <option>deepseek</option>
              <option>anthropic</option>
              <option>openai</option>
            </select>
          </SettingRow>
          <SettingRow label="Anthropic API Key" description="For Claude models">
            <input type="password" placeholder="sk-ant-..." className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm w-60 focus:border-indigo-500 outline-none" />
          </SettingRow>
          <SettingRow label="OpenAI API Key" description="For GPT models">
            <input type="password" placeholder="sk-..." className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm w-60 focus:border-indigo-500 outline-none" />
          </SettingRow>
          <SettingRow label="DeepSeek API Key" description="For DeepSeek models">
            <input type="password" placeholder="sk-..." className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm w-60 focus:border-indigo-500 outline-none" />
          </SettingRow>
        </Section>

        {/* Integrations */}
        <Section title="Integrations">
          <SettingRow label="Feishu / Lark" description="Connect to Feishu for messaging and document access">
            <button className="px-4 py-1.5 text-sm border border-gray-700 rounded-lg hover:border-indigo-500 transition-colors">Configure</button>
          </SettingRow>
          <SettingRow label="GitHub" description="Connect to GitHub for code operations">
            <button className="px-4 py-1.5 text-sm border border-gray-700 rounded-lg hover:border-indigo-500 transition-colors">Configure</button>
          </SettingRow>
        </Section>

        {/* Security */}
        <Section title="Security">
          <SettingRow label="Shell Command Policy" description="Control which shell commands agents can execute">
            <select className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm w-40 focus:border-indigo-500 outline-none">
              <option>Default (Safe)</option>
              <option>Restricted</option>
              <option>Permissive</option>
            </select>
          </SettingRow>
          <SettingRow label="File Access Policy" description="Control which paths agents can read/write">
            <select className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm w-40 focus:border-indigo-500 outline-none">
              <option>Default (Safe)</option>
              <option>Restricted</option>
              <option>Permissive</option>
            </select>
          </SettingRow>
        </Section>

        {/* Database */}
        <Section title="Storage">
          <SettingRow label="Database URL" description="PostgreSQL connection string">
            <input type="password" placeholder="postgresql://..." className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm w-60 focus:border-indigo-500 outline-none" />
          </SettingRow>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">{title}</h3>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function SettingRow({ label, description, children }: { label: string; description: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between bg-gray-900 border border-gray-800 rounded-xl px-5 py-4">
      <div>
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-gray-500 mt-0.5">{description}</div>
      </div>
      {children}
    </div>
  );
}

function InfoCard({ label, value, color }: { label: string; value: string; color: string }) {
  const bg = color === 'green' ? 'bg-green-500/10 text-green-400' : color === 'indigo' ? 'bg-indigo-500/10 text-indigo-400' : 'bg-purple-500/10 text-purple-400';
  return (
    <div className={`rounded-xl px-5 py-4 ${bg}`}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs mt-1 opacity-70">{label}</div>
    </div>
  );
}
