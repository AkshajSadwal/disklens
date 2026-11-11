"use client";

import { useEffect, useMemo, useState } from "react";
import { API } from "../../lib/api";
import { formatBytes } from "../../lib/formatters";

export default function CleanupRecommendationsPanel({ onReviewDelete, refreshTick = 0 }) {
  const [candidates, setCandidates] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [duplicateGroups, setDuplicateGroups] = useState([]);
  const [actionHistory, setActionHistory] = useState([]);
  const [duplicateResults, setDuplicateResults] = useState({});
  const [loading, setLoading] = useState(true);
  const [hashing, setHashing] = useState(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true); setError("");
      try {
        const [recommendationResponse, duplicateResponse, historyResponse] = await Promise.all([
          fetch(`${API}/api/cleanup/recommendations?limit=100`),
          fetch(`${API}/api/cleanup/duplicate-groups?limit=20`),
          fetch(`${API}/api/delete/history?limit=20`),
        ]);
        const [recommendationData, duplicateData, historyData] = await Promise.all([
          recommendationResponse.json().catch(() => null), duplicateResponse.json().catch(() => null),
          historyResponse.json().catch(() => null),
        ]);
        if (!recommendationResponse.ok) throw new Error(recommendationData?.error || "Could not load cleanup candidates.");
        if (!duplicateResponse.ok) throw new Error(duplicateData?.error || "Could not load duplicate candidates.");
        if (!historyResponse.ok) throw new Error(historyData?.error || "Could not load cleanup history.");
        if (!cancelled) {
          setCandidates(recommendationData?.items || []);
          setDuplicateGroups(duplicateData?.groups || []);
          setActionHistory(historyData?.actions || []);
          setNote(recommendationData?.estimateNote || "");
          setSelected(new Set());
          setDuplicateResults({});
        }
      } catch (err) { if (!cancelled) setError(err.message); }
      finally { if (!cancelled) setLoading(false); }
    }
    load();
    return () => { cancelled = true; };
  }, [refreshTick]);

  const selectedItems = useMemo(() => candidates.filter((item) => selected.has(item.id)), [candidates, selected]);
  const selectedBytes = selectedItems.reduce((sum, item) => sum + Number(item.estimatedBytes || 0), 0);

  function toggle(id) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function compare(group) {
    setHashing(group.size); setError("");
    try {
      const response = await fetch(`${API}/api/cleanup/duplicates/hash`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: group.ids }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || `Hash comparison failed (${response.status}).`);
      setDuplicateResults((current) => ({ ...current, [group.size]: data }));
    } catch (err) { setError(err.message); }
    finally { setHashing(null); }
  }

  return (
    <div className="dl-cleanup-review">
      <section className="dl-cleanup-card">
        <header><div><h2>Files to review</h2><p>Temporary items, caches, and large old files found in the existing index. Nothing is selected or removed automatically.</p></div>{selected.size > 0 && <button type="button" onClick={() => onReviewDelete?.(selectedItems)}>Review {selected.size} selected · {formatBytes(selectedBytes)}</button>}</header>
        {note && <div className="dl-cleanup-caution">{note}</div>}
        {loading ? <div className="dl-loading" role="status">Finding indexed candidates…</div> : candidates.length === 0 ? <div className="dl-empty">No conservative cleanup candidates were found in the current index.</div> : <div className="dl-cleanup-list">
          {candidates.map((item) => <label key={item.id} className="dl-cleanup-row">
            <input type="checkbox" checked={selected.has(item.id)} onChange={() => toggle(item.id)} />
            <span className="dl-cleanup-row-main"><strong>{item.name}</strong><small>{item.path}</small><small>{item.category}: {item.reason}</small></span>
            <b>{formatBytes(item.size)}</b>
          </label>)}
        </div>}
      </section>

      <section className="dl-cleanup-card">
        <header><div><h2>Possible duplicates</h2><p>Equal-size files are only candidates. Compare hashes to find exact content matches.</p></div></header>
        {duplicateGroups.length === 0 ? <div className="dl-empty">No same-size file groups found.</div> : <div className="dl-cleanup-list">
          {duplicateGroups.map((group) => {
            const result = duplicateResults[group.size];
            return <div key={group.size} className="dl-cleanup-duplicate">
              <div><strong>{group.count} files · {formatBytes(group.size)} each</strong><small>Potential duplicate bytes: {formatBytes(group.size * (group.count - 1))}</small></div>
              <button type="button" onClick={() => compare(group)} disabled={Boolean(hashing)}>{hashing === group.size ? "Comparing…" : `Compare hashes${group.count > group.ids.length ? ` (first ${group.ids.length})` : ""}`}</button>
              {result && <div className="dl-cleanup-hash-result">
                <p>{result.duplicates.length ? `${result.duplicates.length} exact duplicate group${result.duplicates.length === 1 ? "" : "s"} found.` : "No exact matches found among the compared files."} {result.compared} files hashed; no files were changed.</p>
                {result.errors?.length > 0 && <p>{result.errors.length} file(s) could not be hashed because they changed or became unavailable.</p>}
                {result.duplicates.map((duplicate) => <div key={duplicate.sha256} className="dl-cleanup-duplicate-files">
                  {duplicate.items.map((item) => <span key={item.id}>{item.path}</span>)}
                  <button type="button" onClick={() => onReviewDelete?.(duplicate.items)}>Review these {duplicate.items.length} files for deletion</button>
                </div>)}
              </div>}
            </div>;
          })}
        </div>}
        <div className="dl-cleanup-caution">Hashing reads selected file contents locally, with a 128 MiB total limit per comparison. DiskLens never deletes duplicate files; use the review and confirmation dialog.</div>
      </section>
      <section className="dl-cleanup-card">
        <header><div><h2>Recent cleanup actions</h2><p>Local history of confirmed Trash/Recycle Bin and permanent-delete operations.</p></div></header>
        {actionHistory.length === 0 ? <div className="dl-empty">No cleanup actions have been recorded.</div> : <div className="dl-cleanup-list">
          {actionHistory.map((action) => <div key={action.id} className="dl-cleanup-history-row">
            <span><strong>{action.itemName || action.path}</strong><small>{action.path}</small><small>{new Date(action.createdAt).toLocaleString()} · {action.mode === "recycle" ? "Trash/Recycle Bin" : "Permanent delete"}</small></span>
            <b className={action.outcome === "failed" ? "is-failed" : ""}>{action.outcome === "completed" ? "Completed" : action.outcome === "covered" ? "Included with folder" : `Failed: ${action.error || "unknown error"}`}</b>
          </div>)}
        </div>}
      </section>
      {error && <div className="dl-alert" role="alert">{error}</div>}
    </div>
  );
}
