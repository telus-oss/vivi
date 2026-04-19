import { useState, useEffect, useCallback } from "react";
import {
  GitBranch, Download, ExternalLink, Loader2, CheckCircle2, XCircle, RefreshCw, FileCode2, X, Edit3,
} from "lucide-react";
import type { PrRequest } from "../lib/types";
import * as api from "../lib/api";

interface ApprovalsProps {
  sessionId: string;
  sessionNames?: Record<string, string>;
  onViewDiff?: (prId: string, prTitle: string) => void;
}

export function Approvals({ sessionId, sessionNames, onViewDiff }: ApprovalsProps) {
  const [prs, setPrs] = useState<PrRequest[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try { setPrs(await api.getAllPrRequests()); } catch (err) { console.warn("Approvals.refresh: failed to fetch PR requests", err); } finally { setLoading(false); }
  }, []);

  useEffect(() => { refresh(); const interval = setInterval(refresh, 15000); return () => clearInterval(interval); }, [refresh]);

  const visible = prs.filter((p) => p.status !== "dismissed");

  if (loading) return <div className="flex items-center justify-center py-12 text-gray-500"><RefreshCw className="w-5 h-5 animate-spin mr-2" />Loading branches...</div>;
  if (visible.length === 0) return <div className="py-8 text-center text-gray-500 text-sm border border-dashed border-[var(--color-border)] rounded-lg"><GitBranch className="w-8 h-8 mx-auto mb-2 opacity-50" />No branches yet. Claude will submit branches when work is ready.</div>;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2"><GitBranch className="w-5 h-5 text-purple-400" /><h2 className="text-lg font-semibold">Branches</h2></div>
      <div className="space-y-2">
        {visible.map((pr) => (
          <BranchCard
            key={pr.id}
            pr={pr}
            sessionLabel={sessionNames?.[pr.sessionId] || undefined}
            isCurrentSession={pr.sessionId === sessionId}
            onUpdate={refresh}
            onViewDiff={onViewDiff}
          />
        ))}
      </div>
    </div>
  );
}

function BranchCard({ pr, sessionLabel, isCurrentSession, onUpdate, onViewDiff }: {
  pr: PrRequest;
  sessionLabel?: string;
  isCurrentSession: boolean;
  onUpdate: () => void;
  onViewDiff?: (prId: string, prTitle: string) => void;
}) {
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPrForm, setShowPrForm] = useState(false);
  const [prDescription, setPrDescription] = useState(pr.description || "");

  const handlePullLocal = async () => {
    setActionLoading(true); setError(null);
    try { await api.approvePr(pr.id, "pull_local"); onUpdate(); } catch (err: any) { setError(err.message); } finally { setActionLoading(false); }
  };

  const handleCreatePr = async () => {
    setActionLoading(true); setError(null);
    try { await api.approvePr(pr.id, "github_pr", prDescription); onUpdate(); } catch (err: any) { setError(err.message); } finally { setActionLoading(false); }
  };

  const handleDismiss = async () => {
    try { await api.dismissPr(pr.id); onUpdate(); } catch (err) { console.warn(`Failed to dismiss PR ${pr.id}:`, err); }
  };

  const isPending = pr.status === "pending";
  const isProcessing = pr.status === "merging" || pr.status === "creating_pr";
  const isCompleted = pr.status === "completed";
  const isFailed = pr.status === "failed";
  const isDismissible = !isProcessing;

  return (
    <div className="p-3 bg-[var(--color-surface-raised)] rounded-lg border border-[var(--color-border)] space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-bold truncate">{pr.title}</h3>
          <div className="flex items-center gap-1.5 mt-0.5 text-xs text-gray-500">
            <span className="font-mono truncate">{pr.branch}</span>
            <span className="text-gray-700">&middot;</span>
            <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded-full ${isCurrentSession ? "bg-green-500/15 text-green-400" : "bg-gray-500/15 text-gray-400"}`}>
              {sessionLabel || pr.sessionId.slice(0, 8)}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <StatusBadge status={pr.status} />
          {isDismissible && (
            <button onClick={handleDismiss} className="p-0.5 text-gray-600 hover:text-gray-300 transition-colors rounded" title="Dismiss">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {!showPrForm && pr.description && <pre className="text-xs text-gray-400 leading-relaxed whitespace-pre-wrap font-sans max-h-24 overflow-auto">{pr.description}</pre>}

      {isProcessing && (
        <div className="flex items-center gap-2 px-2.5 py-1.5 bg-blue-500/10 border border-blue-500/30 rounded text-xs text-blue-400">
          <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />{pr.status === "merging" ? "Fetching branch to local..." : "Creating GitHub PR..."}
        </div>
      )}
      {isCompleted && (
        <div className="flex items-center gap-2 px-2.5 py-1.5 bg-green-500/10 border border-green-500/30 rounded text-xs text-green-400">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
          {pr.result?.action === "pull_local"
            ? <span>Branch <code className="font-mono">{pr.branch}</code> is now available locally</span>
            : <span>GitHub PR created{" "}{pr.result?.prUrl && <a href={pr.result.prUrl} target="_blank" rel="noopener noreferrer" className="underline inline-flex items-center gap-0.5">View <ExternalLink className="w-3 h-3" /></a>}</span>}
        </div>
      )}
      {(isFailed || error) && (
        <div className="flex items-center gap-2 px-2.5 py-1.5 bg-red-500/10 border border-red-500/30 rounded text-xs text-red-400">
          <XCircle className="w-3.5 h-3.5 shrink-0" />{error || pr.result?.error || "Action failed"}
        </div>
      )}

      {isPending && !actionLoading && !showPrForm && (
        <div className="space-y-2 pt-1">
          {onViewDiff && (
            <button onClick={() => onViewDiff(pr.id, pr.title)} className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 bg-[var(--color-surface)] hover:bg-[var(--color-border)] text-gray-300 border border-[var(--color-border)] rounded text-xs font-medium transition-colors">
              <FileCode2 className="w-3.5 h-3.5" />View Diff
            </button>
          )}
          <div className="flex gap-2">
            <button onClick={handlePullLocal} className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-500 text-white rounded text-xs font-medium transition-colors"><Download className="w-3.5 h-3.5" />Pull Locally</button>
            <button onClick={() => { setPrDescription(pr.description || ""); setShowPrForm(true); }} className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded text-xs font-medium transition-colors"><GitBranch className="w-3.5 h-3.5" />Create PR</button>
          </div>
        </div>
      )}

      {isPending && !actionLoading && showPrForm && (
        <div className="space-y-2 pt-1">
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mb-1 block">PR Description</label>
            <textarea
              value={prDescription}
              onChange={(e) => setPrDescription(e.target.value)}
              className="w-full px-2.5 py-2 text-xs font-mono bg-[var(--color-surface)] border border-[var(--color-border)] rounded resize-y min-h-[80px] max-h-[200px] text-gray-300 focus:border-[var(--color-accent)] focus:outline-none"
              placeholder="Describe the changes in this PR..."
            />
          </div>
          <div className="flex gap-2">
            <button onClick={() => setShowPrForm(false)} className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 bg-[var(--color-surface)] hover:bg-[var(--color-border)] text-gray-400 border border-[var(--color-border)] rounded text-xs font-medium transition-colors">Cancel</button>
            <button onClick={handleCreatePr} className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded text-xs font-medium transition-colors"><GitBranch className="w-3.5 h-3.5" />Create GitHub PR</button>
          </div>
        </div>
      )}

      {actionLoading && <div className="flex items-center justify-center py-1.5 text-xs text-gray-500"><Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />Processing...</div>}
    </div>
  );
}

function StatusBadge({ status }: { status: PrRequest["status"] }) {
  const styles: Record<string, string> = {
    pending: "bg-purple-500/15 text-purple-400",
    merging: "bg-blue-500/15 text-blue-400",
    creating_pr: "bg-blue-500/15 text-blue-400",
    completed: "bg-green-500/15 text-green-400",
    failed: "bg-red-500/15 text-red-400",
  };
  return <span className={`px-1.5 py-0.5 text-[10px] font-bold rounded-full ${styles[status] || "bg-gray-500/15 text-gray-400"}`}>{status}</span>;
}
