import { useEffect, useState } from 'react';
import { api } from '../api.ts';

interface SkillInfo {
  name: string;
  version: string;
  description: string;
  author: string;
  category: string;
  tags?: string[];
  tools: Array<{ name: string; description: string }>;
  requiredPermissions?: string[];
}

export function SkillStore() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [selected, setSelected] = useState<SkillInfo | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    fetch('/api/skills')
      .then(r => r.json())
      .then((d: { skills: SkillInfo[] }) => setSkills(d.skills))
      .catch(() => {});
  }, []);

  const filtered = filter
    ? skills.filter(s => s.category === filter || s.tags?.includes(filter))
    : skills;

  const categories = [...new Set(skills.map(s => s.category))];

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      <div className="flex items-center gap-4 px-7 h-15 border-b border-gray-800 bg-gray-900 shrink-0">
        <h2 className="text-lg font-semibold">Skill Store</h2>
        <div className="flex gap-1 ml-4">
          <button
            onClick={() => setFilter('')}
            className={`px-3 py-1 text-xs rounded-md transition-colors ${!filter ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'}`}
          >
            All
          </button>
          {categories.map(c => (
            <button
              key={c}
              onClick={() => setFilter(f => f === c ? '' : c)}
              className={`px-3 py-1 text-xs rounded-md transition-colors capitalize ${filter === c ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'}`}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-7">
        {filtered.length === 0 ? (
          <div className="text-center text-gray-500 py-20">
            <div className="text-4xl mb-3 opacity-30">◆</div>
            <div>No skills found. Skills are loaded from the server configuration.</div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map(skill => (
              <div
                key={skill.name}
                onClick={() => setSelected(selected?.name === skill.name ? null : skill)}
                className={`bg-gray-900 border rounded-xl p-5 cursor-pointer transition-colors ${
                  selected?.name === skill.name ? 'border-indigo-500' : 'border-gray-800 hover:border-gray-700'
                }`}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="font-semibold">{skill.name}</div>
                    <div className="text-xs text-gray-500 mt-0.5">v{skill.version} by {skill.author}</div>
                  </div>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-indigo-500/15 text-indigo-400 capitalize">
                    {skill.category}
                  </span>
                </div>
                <p className="text-sm text-gray-400 mt-3 line-clamp-2">{skill.description}</p>
                <div className="flex flex-wrap gap-1.5 mt-3">
                  {skill.tags?.map(t => (
                    <span key={t} className="px-2 py-0.5 text-[10px] bg-gray-800 text-gray-500 rounded-full">{t}</span>
                  ))}
                </div>
                <div className="mt-3 pt-3 border-t border-gray-800 text-xs text-gray-500">
                  {skill.tools.length} tool{skill.tools.length !== 1 ? 's' : ''}
                  {skill.requiredPermissions?.length ? ` · Requires: ${skill.requiredPermissions.join(', ')}` : ''}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Detail Panel */}
      {selected && (
        <div className="border-t border-gray-800 bg-gray-900 p-5 shrink-0 max-h-60 overflow-y-auto">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold">{selected.name} — Tools</h3>
            <button onClick={() => setSelected(null)} className="text-gray-500 hover:text-gray-300 text-sm">&times;</button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {selected.tools.map(tool => (
              <div key={tool.name} className="bg-gray-800 rounded-lg px-4 py-3">
                <div className="text-sm font-medium text-indigo-400">{tool.name}</div>
                <div className="text-xs text-gray-500 mt-1">{tool.description}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
