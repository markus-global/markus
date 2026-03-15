import { useState } from 'react';

interface Props {
  onComplete: () => void;
}

export function Onboarding({ onComplete }: Props) {
  const [step, setStep] = useState(0);

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
      title: 'Quick Tour',
      subtitle: 'Here\'s what you can do',
      content: (
        <div className="space-y-2 text-gray-300 text-sm">
          {[
            ['Overview', 'Monitor your AI team\'s status, task progress, and system health'],
            ['Chat', 'Talk to agents directly or use Smart Route to auto-pick the best one'],
            ['Projects', 'Create and track tasks on kanban boards with full governance'],
            ['Builder', 'Create and customize agents, team workflows, and prompts'],
            ['Deliverables', 'Manage your team\'s shared deliverables'],
            ['Agents & Skills', 'Browse and install agent templates and skill packages'],
          ].map(([title, desc]) => (
            <div key={title} className="flex gap-3 bg-gray-800/50 rounded-lg p-3">
              <div className="text-indigo-400 mt-0.5 shrink-0">&#x2192;</div>
              <div>
                <div className="font-medium text-white text-xs">{title}</div>
                <div className="text-gray-400 text-xs">{desc}</div>
              </div>
            </div>
          ))}
          <p className="text-xs text-gray-500 mt-3">Your team already includes a Secretary agent and several builder agents ready to help.</p>
        </div>
      ),
    },
  ];

  const handleNext = () => {
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
              className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-sm rounded-xl transition-colors"
            >
              {step === steps.length - 1 ? 'Get Started' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
