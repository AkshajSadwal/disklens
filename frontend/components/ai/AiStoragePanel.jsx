"use client";

import { useEffect, useMemo, useState } from "react";
import { API } from "../../lib/api";
import { formatBytes, formatDate } from "../../lib/formatters";
import Icon from "../common/Icon";

function confidenceText(value) {
  if (value >= 90) return "High confidence";
  if (value >= 70) return "Moderate confidence";
  return "Low confidence";
}

function priorityClass(priority) {
  if (priority === "high") return "high";
  if (priority === "medium") return "medium";
  return "low";
}

export default function AiStoragePanel({ onClose, embedded = false }) {
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState("");
  const [mode, setMode] = useState("top");
  const [limit, setLimit] = useState(10);
  const [include, setInclude] = useState({ programs: true, files: true, folders: true });
  const [topLoading, setTopLoading] = useState(false);
  const [topData, setTopData] = useState(null);
  const [programs, setPrograms] = useState([]);
  const [targetType, setTargetType] = useState("program");
  const [targetQuery, setTargetQuery] = useState("");
  const [targetResults, setTargetResults] = useState([]);
  const [targetSearchLoading, setTargetSearchLoading] = useState(false);
  const [selectedTarget, setSelectedTarget] = useState(null);
  const [targetLoading, setTargetLoading] = useState(false);
  const [targetData, setTargetData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    async function load() {
      try {
        const [statusResponse, programsResponse] = await Promise.all([
          fetch(`${API}/api/ai/status`),
          fetch(`${API}/api/programs`),
        ]);
        const statusData = await statusResponse.json().catch(() => null);
        setStatus(statusData);
        if (statusData?.mode === "offline") setStatusError("Using local rule-based analysis. No AI provider key is configured.");
        if (programsResponse.ok) {
          const data = await programsResponse.json().catch(() => null);
          setPrograms(data?.programs || []);
        }
      } catch (err) {
        setStatusError(err.message);
      }
    }
    load();
  }, []);

  useEffect(() => {
    setError("");
    setTargetResults([]);
    if (targetType === "program") {
      const q = targetQuery.trim().toLowerCase();
      if (!q) {
        setTargetResults([]);
        return;
      }
      setTargetResults(
        programs
          .filter((program) => `${program.name} ${program.publisher} ${program.version}`.toLowerCase().includes(q))
          .slice(0, 12)
          .map((program) => ({
            type: "program",
            name: program.name,
            version: program.version,
            publisher: program.publisher,
            installLocation: program.installLocation || "",
            displayIcon: program.displayIcon || "",
          })),
      );
      setTargetSearchLoading(false);
      return;
    }

    if (!targetQuery.trim()) {
      setTargetResults([]);
      setTargetSearchLoading(false);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      setTargetSearchLoading(true);
      setTargetResults([]);
      try {
        const response = await fetch(`${API}/api/ai/storage/search?type=${encodeURIComponent(targetType)}&q=${encodeURIComponent(targetQuery.trim())}`);
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
        if (!cancelled) setTargetResults(data.items || []);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setTargetSearchLoading(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [targetType, targetQuery, programs]);

  function resetResults() {
    setTopData(null);
    setTargetData(null);
    setSelectedTarget(null);
    setError("");
  }

  function toggleInclude(name) {
    setInclude((prev) => ({ ...prev, [name]: !prev[name] }));
  }

  async function runTopAnalysis() {
    if (!Object.values(include).some(Boolean)) {
      setError("Select at least one of programs, files, or folders.");
      return;
    }
    setTopLoading(true);
    setError("");
    setTopData(null);
    setTargetData(null);
    try {
      const response = await fetch(`${API}/api/ai/storage/top`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: Math.min(50, Math.max(1, Number(limit) || 10)), include }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
      setTopData(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setTopLoading(false);
    }
  }

  async function runTargetAnalysis() {
    if (!selectedTarget) {
      setError("Select a program, file, or folder first.");
      return;
    }
    setTargetLoading(true);
    setError("");
    setTargetData(null);
    setTopData(null);
    try {
      const response = await fetch(`${API}/api/ai/storage/target`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: selectedTarget.type,
          id: selectedTarget.id,
          name: selectedTarget.name,
          version: selectedTarget.version,
          publisher: selectedTarget.publisher,
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
      setTargetData(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setTargetLoading(false);
    }
  }

  const topEntities = useMemo(() => {
    if (!topData?.snapshot?.entities) return new Map();
    const map = new Map();
    for (const rows of Object.values(topData.snapshot.entities)) {
      for (const row of rows || []) map.set(row.key, row);
    }
    return map;
  }, [topData]);

  const targetLabel = selectedTarget
    ? selectedTarget.type === "program"
      ? `${selectedTarget.name}${selectedTarget.version ? ` · ${selectedTarget.version}` : ""}`
      : selectedTarget.name
    : "";

  return (
    <div className={`dl-panel-root ${embedded ? "is-embedded" : ""}`}>
      <div className="dl-panel-surface">
        <header className="dl-ai-head">
          <div>
            <div className="dl-eyebrow">AI POWERED</div>
            <h2>AI Storage Advisor</h2>
            <p>Choose exactly what DiskLens analyzes. Your full storage index is never sent.</p>
          </div>
          <div className="dl-ai-head-right">
            <div className="dl-ai-status"><span className={`dl-live-dot ${status?.configured ? "" : "is-off"}`} />{status?.mode === "offline" ? "Local Rules" : status?.configured ? "AI Ready" : "Checking"}</div>
            <button className="dl-icon-btn" onClick={onClose} title="Close"><Icon name="close" size={16} /></button>
          </div>
        </header>

        <div className="dl-ai-modes">
          <button className={`dl-ai-mode ${mode === "top" ? "active" : ""}`} onClick={() => { setMode("top"); resetResults(); }}>
            <div className="dl-ai-mode-index">1</div>
            <div><strong>Biggest storage</strong><span>Let AI review your largest programs, files and folders.</span></div>
            <Icon name="chevronRight" size={13} />
          </button>
          <button className={`dl-ai-mode ${mode === "target" ? "active" : ""}`} onClick={() => { setMode("target"); resetResults(); }}>
            <div className="dl-ai-mode-index">2</div>
            <div><strong>Analyze one item</strong><span>Select one program, file or folder and get advice only for it.</span></div>
            <Icon name="chevronRight" size={13} />
          </button>
        </div>

        <div className="dl-ai-body">
          {statusError && <div className="dl-alert">{statusError}</div>}

          {mode === "top" ? (
            <div className="dl-ai-config">
              <div className="dl-ai-controls">
                <div className="dl-ai-field">
                  <span className="dl-ai-label">Number to analyze</span>
                  <input className="dl-ai-number" type="number" min="1" max="50" value={limit} onChange={(e) => setLimit(Math.min(50, Math.max(1, Number(e.target.value) || 1)))} />
                </div>
                <div className="dl-ai-field dl-grow">
                  <span className="dl-ai-label">What should AI review?</span>
                  <div className="dl-ai-choices">
                    {[["programs", "Programs"], ["files", "Files"], ["folders", "Folders"]].map(([key, label]) => (
                      <button key={key} className={`dl-ai-choice ${include[key] ? "active" : ""}`} onClick={() => toggleInclude(key)}>
                        {include[key] ? "✓ " : ""}{label}
                      </button>
                    ))}
                  </div>
                </div>
                <button className="dl-primary-btn" onClick={runTopAnalysis} disabled={topLoading}>
                  {topLoading ? "Analyzing..." : "Get AI Advice"}
                </button>
              </div>
              <div className="dl-ai-note">Only the selected top items are sent to Azure OpenAI. Files use indexed file size; folders use calculated descendant file size.</div>
            </div>
          ) : (
            <div className="dl-ai-config">
              <div className="dl-ai-target-types">
                {[["program", "Program"], ["file", "File"], ["folder", "Folder"]].map(([type, label]) => (
                  <button key={type} className={`dl-ai-target-type ${targetType === type ? "active" : ""}`} onClick={() => { setTargetType(type); setTargetQuery(""); setTargetResults([]); setSelectedTarget(null); setTargetData(null); }}>
                    {label}
                  </button>
                ))}
              </div>
              <input className="dl-ai-search" value={targetQuery} onChange={(e) => setTargetQuery(e.target.value)} placeholder={`Search ${targetType}s by name or path...`} />
              {targetSearchLoading && <div className="dl-ai-note">Searching indexed storage...</div>}
              {!targetSearchLoading && targetQuery.trim() && targetResults.length === 0 && !error && <div className="dl-ai-search-state">No matching {targetType}s found.</div>}
              {targetResults.length > 0 && (
                <div className="dl-ai-results">
                  {targetResults.map((item, index) => {
                    const active = selectedTarget && selectedTarget.type === item.type && selectedTarget.id === item.id && selectedTarget.name === item.name;
                    return (
                      <button key={`${item.type}|${item.id ?? item.name}|${index}`} className={`dl-ai-result ${active ? "active" : ""}`} onClick={() => setSelectedTarget(item)}>
                        <strong>{item.name}</strong>
                        <span>{item.type === "program" ? `${item.publisher || "Unknown publisher"}${item.version ? ` · ${item.version}` : ""}` : `${formatBytes(item.size || 0)} · ${item.path}`}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              {selectedTarget && (
                <div className="dl-ai-selected">
                  <div className="dl-ai-selected-title">Selected</div>
                  <div className="dl-ai-selected-name">{targetLabel}</div>
                  <div className="dl-ai-selected-path">{selectedTarget.path || selectedTarget.installLocation || selectedTarget.publisher || ""}</div>
                  <button className="dl-primary-btn" style={{ marginTop: 9 }} onClick={runTargetAnalysis} disabled={targetLoading}>
                    {targetLoading ? "Analyzing..." : "Analyze Selected"}
                  </button>
                </div>
              )}
            </div>
          )}

          {error && <div className="dl-alert" style={{ marginTop: 9 }}>{error}</div>}

          {(topData?.analysis || targetData?.analysis) && (
            <div className="dl-ai-results-area">
              {topData?.analysis && (
                <>
                  <div className="dl-ai-summary">
                    <div className="dl-ai-summary-kicker">{topData.analysis.source === "local-rules" ? "Local Rule-Based Summary" : "AI Summary"}</div>
                    <h3>{topData.analysis.summary}</h3>
                  </div>
                  {(topData.analysis.suggestions || []).map((suggestion, index) => {
                    const referenced = (suggestion.targetKeys || []).map((key) => topEntities.get(key)).filter(Boolean).slice(0, 8);
                    return (
                      <div className="dl-ai-card" key={`${suggestion.title}|${index}`}>
                        <div className="dl-ai-card-head">
                          <div className="dl-ai-card-title">{suggestion.title}</div>
                          <span className={`dl-ai-badge ${priorityClass(suggestion.priority)}`}>{suggestion.priority} · {suggestion.confidence}%</span>
                        </div>
                        {suggestion.estimatedBytes > 0 && <p><strong>{formatBytes(suggestion.estimatedBytes)}</strong> potentially reviewable</p>}
                        <p>{suggestion.reason}</p>
                        <div className="action"><strong>Action:</strong> {suggestion.action}</div>
                        {suggestion.caution && <p>⚠ {suggestion.caution}</p>}
                        {referenced.map((item) => (
                          <div className="dl-ai-reference" key={item.key || `${item.type}|${item.id}|${item.path}`}>
                            <strong>{item.name}</strong>
                            <span>{formatBytes(item.size || 0)} · {item.path || item.installLocation || item.publisher || ""}</span>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </>
              )}

              {targetData?.analysis && (
                <>
                  <div className="dl-ai-summary">
                    <div className="dl-ai-summary-kicker">Selected target</div>
                    <h3>{targetData.target.name}</h3>
                    <p>{targetData.target.path || targetData.target.installLocation || ""}</p>
                    <p>Indexed/storage size: {formatBytes(targetData.target.size || 0)} · {targetData.target.sizeBasis || ""}</p>
                    {targetData.target.modifiedAt && <p>Modified: {formatDate(targetData.target.modifiedAt)}</p>}
                  </div>
                  <div className="dl-ai-card">
                    <div className="dl-ai-summary-kicker">{targetData.analysis.source === "local-rules" ? "Local rule-based assessment" : "AI Assessment"} · {targetData.analysis.confidence}% confidence</div>
                    <h3>{targetData.analysis.storageAssessment}</h3>
                    <p>{targetData.analysis.summary}</p>
                  </div>
                  {(targetData.analysis.opportunities || []).map((opportunity, index) => (
                    <div className="dl-ai-card" key={`${opportunity.title}|${index}`}>
                      <div className="dl-ai-card-head">
                        <div className="dl-ai-card-title">{opportunity.title}</div>
                        <span className={`dl-ai-badge ${priorityClass(opportunity.priority)}`}>{opportunity.priority} · {opportunity.confidence}%</span>
                      </div>
                      {opportunity.estimatedBytes > 0 && <p><strong>{formatBytes(opportunity.estimatedBytes)}</strong> potentially reviewable</p>}
                      <p>{opportunity.reason}</p>
                      <div className="action"><strong>Action:</strong> {opportunity.action}</div>
                      {opportunity.caution && <p>⚠ {opportunity.caution}</p>}
                    </div>
                  ))}
                  {targetData.analysis.keepReasons?.length > 0 && (
                    <div className="dl-ai-card">
                      <div className="dl-ai-summary-kicker">Why it may be worth keeping</div>
                      {targetData.analysis.keepReasons.map((reason) => <p key={reason}>✓ {reason}</p>)}
                    </div>
                  )}
                  <div className="dl-ai-card"><div className="dl-ai-summary-kicker">Final advice</div><p>{targetData.analysis.finalAdvice}</p></div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
