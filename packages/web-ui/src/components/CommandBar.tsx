import { useState } from 'react';
import { api } from '../api.ts';
import { MarkdownMessage } from './MarkdownMessage.tsx';

interface Props {
  onNavigate: (page: string) => void;
}

export function CommandBar({ onNavigate }: Props) {
  const [input, setInput] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [result, setResult] = useState('');
  const [loading, setLoading] = useState(false);

  const execute = async () => {
    if (!input.trim() || loading) return;
    const text = input.trim();
    setInput('');
    setLoading(true);
    setResult('');
    setExpanded(true);

    try {
      const res = await api.message.send(text, { senderId: 'default' });
      setResult(res.reply);
    } catch (e) {
      setResult(`Error: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="border-t border-gray-800 bg-gray-900 shrink-0">
      {expanded && result && (
        <div className="px-5 py-3 border-b border-gray-800 max-h-40 overflow-y-auto">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] text-gray-500 uppercase tracking-wider">Response</span>
            <button onClick={() => { setExpanded(false); setResult(''); }} className="text-xs text-gray-600 hover:text-gray-400">&times;</button>
          </div>
          <MarkdownMessage content={result} className="text-xs text-gray-300" />
        </div>
      )}
      <div className="flex items-center gap-2 px-4 py-2.5">
        <span className="text-gray-600 text-sm">&gt;</span>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); execute(); } }}
          onFocus={() => setExpanded(false)}
          placeholder="Type a command or ask anything... (routed to Manager)"
          className="flex-1 bg-transparent text-sm text-gray-300 placeholder-gray-600 outline-none"
        />
        {loading && <span className="text-xs text-gray-500 animate-pulse">Thinking...</span>}
      </div>
    </div>
  );
}
