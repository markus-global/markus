import { useState } from 'react';
import { api } from '../api.ts';

interface Props {
  onComplete: () => void;
}

export function Onboarding({ onComplete }: Props) {
  const [step, setStep] = useState(0);
  const [agentName, setAgentName] = useState('Alice');
  const [agentRole, setAgentRole] = useState('developer');
  const [creating, setCreating] = useState(false);

  const steps = [
    {
      title: 'Welcome to Markus',
      subtitle: 'Your AI Digital Employee Platform',
      content: (
        <div className="space-y-4 text-gray-300 text-sm leading-relaxed">
          <p>Markus is not another AI chatbot. It's a platform for building <strong className="text-white">AI teams</strong> — digital employees that work autonomously, collaborate with each other, and communicate with you naturally.</p>
          <div className="grid grid-cols-2 gap-3 mt-6">
            {[
              ['Always Online', 'Agents work 24/7, no need to start/stop'],
              ['Team Collaboration', 'Agents talk to each other via A2A messaging'],
              ['Smart Routing', 'Messages auto-route to the right agent'],
              ['Tool Capable', 'Shell, files, web, git, browser tools'],
            ].map(([title, desc]) => (
              <div key={title} className="bg-gray-800/50 rounded-lg p-3">
                <div className="font-medium text-white text-xs">{title}</div>
                <div className="text-gray-400 text-xs mt-1">{desc}</div>
              </div>
            ))}
          </div>
        </div>
      ),
    },
    {
      title: 'Hire Your First Agent',
      subtitle: 'Give them a name and role',
      content: (
        <div className="space-y-4">
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Agent Name</label>
            <input
              value={agentName}
              onChange={e => setAgentName(e.target.value)}
              className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-sm focus:border-indigo-500 outline-none"
              placeholder="e.g. Alice, Bob, DevBot"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Role</label>
            <select
              value={agentRole}
              onChange={e => setAgentRole(e.target.value)}
              className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-sm focus:border-indigo-500 outline-none"
            >
              <option value="developer">Software Developer</option>
              <option value="devops">DevOps Engineer</option>
              <option value="product-manager">Product Manager</option>
              <option value="marketing">Marketing Specialist</option>
              <option value="support">Customer Support</option>
              <option value="content-writer">Content Writer</option>
            </select>
          </div>
          <p className="text-xs text-gray-500">You can hire more agents later from the Team page or by telling the Manager.</p>
        </div>
      ),
    },
    {
      title: 'You\'re All Set!',
      subtitle: 'Start working with your AI team',
      content: (
        <div className="space-y-4 text-gray-300 text-sm">
          <p>Here's how to interact with your agents:</p>
          <div className="space-y-2">
            {[
              ['Workspace (Chat)', 'Talk to agents directly or let Smart Route pick the best one'],
              ['Command Bar', 'Use the bottom bar for quick commands like "hire a QA engineer"'],
              ['Tasks', 'Create and track tasks on the kanban board'],
              ['Agent Profile', 'View each agent\'s skills, proficiency, and work history'],
            ].map(([title, desc]) => (
              <div key={title} className="flex gap-3 bg-gray-800/50 rounded-lg p-3">
                <div className="text-indigo-400 mt-0.5">→</div>
                <div>
                  <div className="font-medium text-white text-xs">{title}</div>
                  <div className="text-gray-400 text-xs">{desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ),
    },
  ];

  const handleNext = async () => {
    if (step === 1) {
      setCreating(true);
      try {
        await api.agents.create(agentName, agentRole);
      } catch { /* ignore if creation fails */ }
      setCreating(false);
    }
    if (step < steps.length - 1) {
      setStep(step + 1);
    } else {
      onComplete();
    }
  };

  const current = steps[step]!;

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8">
          <div className="flex gap-1.5 mb-8">
            {steps.map((_, i) => (
              <div key={i} className={`h-1 flex-1 rounded-full transition-colors ${i <= step ? 'bg-indigo-500' : 'bg-gray-800'}`} />
            ))}
          </div>

          <h2 className="text-2xl font-bold text-white">{current.title}</h2>
          <p className="text-sm text-gray-400 mt-1 mb-6">{current.subtitle}</p>

          {current.content}

          <div className="flex justify-between mt-8">
            {step > 0 ? (
              <button onClick={() => setStep(step - 1)} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">
                Back
              </button>
            ) : (
              <button onClick={onComplete} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-300 transition-colors">
                Skip
              </button>
            )}
            <button
              onClick={handleNext}
              disabled={creating || (step === 1 && !agentName.trim())}
              className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm rounded-xl transition-colors"
            >
              {creating ? 'Creating...' : step === steps.length - 1 ? 'Get Started' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
