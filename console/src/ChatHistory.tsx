import { MessageSquare, Plus, Search } from 'lucide-react';
import { useMemo, useState } from 'react';

export interface ChatHistoryJob {
  id: string;
  status: string;
  updatedAt: string;
  input: { goal: string; projectId?: string };
}

function relative(value: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function ChatHistory({
  jobs,
  onOpen,
  onNew
}: {
  jobs: ChatHistoryJob[];
  onOpen: (job: ChatHistoryJob) => void;
  onNew: () => void;
}) {
  const [query, setQuery] = useState('');
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return [...jobs]
      .filter((job) => !needle || job.input.goal.toLowerCase().includes(needle) || job.input.projectId?.toLowerCase().includes(needle))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [jobs, query]);

  return <section className="chat-history-page page-shell" aria-label="Chats">
    <header className="chat-history-header page-header">
      <h1 className="page-title">Chats</h1>
      <div className="chat-history-actions">
        <label className="chat-history-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search chats" aria-label="Search chats" /></label>
        <button className="btn-primary" onClick={onNew}><Plus size={15} />New chat</button>
      </div>
    </header>

    {visible.length ? <div className="chat-history-list">{visible.map((job) => <button key={job.id} className="chat-history-row" onClick={() => onOpen(job)}>
      <span className="chat-history-icon"><MessageSquare size={15} /></span>
      <span className="chat-history-copy"><strong>{job.input.goal}</strong><small>{job.input.projectId ? `${job.input.projectId} · ` : ''}{relative(job.updatedAt)}</small></span>
      <span className={`status-pill ${job.status === 'success' ? 'good' : job.status === 'error' || job.status === 'cancelled' ? 'bad' : job.status.startsWith('waiting') ? 'warn' : 'live'}`}>{job.status.replace('-', ' ')}</span>
    </button>)}</div> : <div className="chat-history-empty"><MessageSquare size={24} /><h2>No chats yet</h2><p>Start a new chat to work with a repository or Project.</p><button className="btn-primary" onClick={onNew}>New chat</button></div>}
  </section>;
}
