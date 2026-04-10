import React, { useState } from 'react';
import { useCadStore } from '@/modules/part/store/useCadStore';
import { GitCommit, History, ChevronUp, Check } from 'lucide-react';

export const VersionControl = () => {
  const { commits, commitChanges, checkoutCommit } = useCadStore();
  const [isCommitMenuOpen, setIsCommitMenuOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);

  const handleCommit = (e: React.FormEvent) => {
    e.preventDefault();
    if (commitMessage.trim()) {
      commitChanges(commitMessage);
      setCommitMessage('');
      setIsCommitMenuOpen(false);
    }
  };

  const handleCheckout = (commitId: string) => {
    checkoutCommit(commitId);
    setIsHistoryOpen(false);
  };

  return (
    <div className="border-t border-zinc-300 bg-white p-2 flex flex-col gap-2 relative">
      {/* History Dropdown (Opening Upwards) */}
      {isHistoryOpen && (
        <div className="absolute bottom-full left-2 mb-2 w-64 bg-white rounded-md shadow-lg border border-zinc-300 overflow-hidden z-30">
           <div className="px-3 py-2 border-b border-zinc-300 bg-zinc-50 flex justify-between items-center">
              <h3 className="text-[10px] font-medium text-zinc-600 uppercase tracking-wider">Local Commits ({commits.length})</h3>
           </div>
          <ul className="max-h-48 overflow-y-auto">
            {[...commits].reverse().map((commit, index) => (
              <li key={commit.id}>
                <button
                  onClick={() => handleCheckout(commit.id)}
                  className="w-full text-left px-3 py-2 hover:bg-zinc-100 transition-colors border-b border-zinc-200 last:border-0 group flex items-start justify-between"
                >
                  <div>
                     <p className="text-xs text-zinc-800 font-medium group-hover:text-zinc-900 transition-colors flex items-center">
                        {commit.message}
                        {index === 0 && <span className="ml-1.5 text-[8px] uppercase tracking-wide bg-blue-500/20 text-blue-700 px-1 py-0.5 rounded border border-blue-500/30">HEAD</span>}
                     </p>
                     <p className="text-[10px] text-zinc-500 mt-0.5">
                        {new Date(commit.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} • {commit.id.slice(0, 7)}
                     </p>
                  </div>
                  <Check className={`w-3 h-3 text-blue-500 opacity-0 group-hover:opacity-100 transition-opacity mt-0.5`} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Commit Menu (Opening Upwards) */}
      {isCommitMenuOpen && (
        <div className="absolute bottom-full left-2 mb-2 w-56 bg-white rounded-md shadow-lg border border-zinc-300 p-2.5 z-30">
          <form onSubmit={handleCommit}>
            <label className="block text-[10px] font-medium text-zinc-600 mb-1 uppercase tracking-wider">Commit Message</label>
            <input
              type="text"
              autoFocus
              placeholder="e.g., Changed height"
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              className="w-full bg-white border border-zinc-300 rounded px-2 py-1 text-xs text-zinc-900 mb-2 focus:outline-none focus:border-blue-500 transition-colors"
            />
            <div className="flex justify-end space-x-1.5">
              <button
                type="button"
                onClick={() => setIsCommitMenuOpen(false)}
                className="text-[10px] px-1.5 py-0.5 text-zinc-600 hover:text-zinc-900 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!commitMessage.trim()}
                className="text-[10px] px-2 py-0.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded transition-colors"
              >
                Save
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="flex items-center space-x-2">
        <button
          onClick={() => {
            setIsHistoryOpen(!isHistoryOpen);
            setIsCommitMenuOpen(false);
          }}
          className="flex-1 flex items-center justify-center space-x-1.5 bg-zinc-100 hover:bg-zinc-200 text-zinc-700 px-2 py-1 rounded text-xs transition-colors border border-zinc-300"
        >
          <History className="w-3.5 h-3.5" />
          <span>History</span>
          <ChevronUp className="w-2.5 h-2.5 text-zinc-500" />
        </button>
        <button
          onClick={() => {
            setIsCommitMenuOpen(!isCommitMenuOpen);
            setIsHistoryOpen(false);
          }}
          className="flex-1 flex items-center justify-center space-x-1.5 bg-blue-600 hover:bg-blue-500 text-white px-2 py-1 rounded text-xs transition-colors"
        >
          <GitCommit className="w-3.5 h-3.5" />
          <span>Commit</span>
        </button>
      </div>
    </div>
  );
};
