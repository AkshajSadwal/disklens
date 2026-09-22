"use client";

import { useEffect, useMemo, useState } from "react";
import { API } from "../../lib/api";
import { formatBytes, formatDate } from "../../lib/formatters";

function confidenceText(value) {
  if (value >= 90) return "High confidence";
  if (value >= 70) return "Moderate confidence";
  return "Low confidence";
}

function priorityStyle(priority) {
  if (priority === "high") {
    return { border: "#6b3434", color: "#ffb0b0", background: "#2a1719" };
  }
  if (priority === "medium") {
    return { border: "#5d4b2e", color: "#e4c89b", background: "#211d16" };
  }
  return { border: "#344e3b", color: "#a9cfae", background: "#142018" };
}

export default function AiStoragePanel({ onClose, embedded = false }) {
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState("");

  const [mode, setMode] = useState("top");
  const [limit, setLimit] = useState(10);
  const [include, setInclude] = useState({
    programs: true,
    files: true,
    folders: true,
  });

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
    async function loadStatusAndPrograms() {
      try {
        const [statusResponse, programsResponse] = await Promise.all([
          fetch(`${API}/api/ai/status`),
          fetch(`${API}/api/programs`),
        ]);

        const statusData = await statusResponse.json().catch(() => null);
        setStatus(statusData);
        if (!statusData?.configured) {
          setStatusError("Azure OpenAI is not configured on the server yet.");
        }

        if (programsResponse.ok) {
          const programsData = await programsResponse.json().catch(() => null);
          setPrograms(programsData?.programs || []);
        }
      } catch (err) {
        setStatusError(err.message);
      }
    }

    loadStatusAndPrograms();
  }, []);

  useEffect(() => {
    if (targetType === "program") {
      const q = targetQuery.trim().toLowerCase();
      if (!q) {
        setTargetResults([]);
        return;
      }

      setTargetResults(
        programs
          .filter((program) =>
            `${program.name} ${program.publisher} ${program.version}`
              .toLowerCase()
              .includes(q),
          )
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
      return;
    }

    if (!targetQuery.trim()) {
      setTargetResults([]);
      return;
    }

    let cancelled = false;

    async function search() {
      setTargetSearchLoading(true);
      try {
        const response = await fetch(
          `${API}/api/ai/storage/search?type=${encodeURIComponent(targetType)}&q=${encodeURIComponent(targetQuery.trim())}`,
        );
        const data = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(data?.error || `HTTP ${response.status}`);
        }
        if (!cancelled) setTargetResults(data.items || []);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setTargetSearchLoading(false);
      }
    }

    const timer = setTimeout(search, 250);
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
    if (!status?.configured) {
      setError(statusError || "Azure OpenAI is not configured.");
      return;
    }

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
        body: JSON.stringify({
          limit: Math.min(50, Math.max(1, Number(limit) || 10)),
          include,
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error || `HTTP ${response.status}`);
      }
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

    if (!status?.configured) {
      setError(statusError || "Azure OpenAI is not configured.");
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
      if (!response.ok) {
        throw new Error(data?.error || `HTTP ${response.status}`);
      }
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
    <div
      className={`dl-panel-root ${embedded ? "is-embedded" : ""}`}
      style={{
        position: embedded ? "relative" : "fixed",
        inset: embedded ? "auto" : 0,
        background: embedded ? "transparent" : "rgba(15,23,42,0.34)",
        zIndex: embedded ? "auto" : 2400,
        padding: embedded ? 0 : 24,
        boxSizing: "border-box",
        height: embedded ? "auto" : "100%",
        minHeight: embedded ? "100%" : 0,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="dl-panel-surface"
        style={{
          width: "100%",
          maxWidth: 1100,
          height: embedded ? "auto" : "100%",
          minHeight: embedded ? "calc(100vh - 48px)" : 0,
          maxHeight: embedded ? "none" : "94vh",
          margin: "0 auto",
          background: embedded ? "#ffffff" : "#11141a",
          border: "1px solid #303743",
          borderRadius: 20,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "20px 24px", borderBottom: "1px solid #292f39", display: "flex", justifyContent: "space-between", gap: 20, alignItems: "center" }}>
          <div>
            <h2 style={{ margin: 0 }}>AI Storage Advisor</h2>
            <p style={{ color: "#8f98a8", margin: "6px 0 0", fontSize: 13 }}>
              Choose exactly what DiskLens sends to Azure OpenAI. AI does not receive your full storage index.
            </p>
          </div>
          <button onClick={onClose} style={{ background: "#232832", color: "#fff", border: "1px solid #343b47", borderRadius: 8, padding: "8px 12px", cursor: "pointer" }}>✕</button>
        </div>

        <div style={{ display: "flex", gap: 8, padding: 16, borderBottom: "1px solid #292f39" }}>
          <button
            onClick={() => { setMode("top"); resetResults(); }}
            style={{ flex: 1, background: mode === "top" ? "#1b2638" : "#171a20", color: "#fff", border: `1px solid ${mode === "top" ? "#31558d" : "#343b47"}`, borderRadius: 10, padding: 13, textAlign: "left", cursor: "pointer" }}
          >
            <div style={{ fontWeight: 750 }}>1 · Biggest storage</div>
            <div style={{ color: "#788291", fontSize: 11, marginTop: 4 }}>Choose how many largest programs, files and/or folders AI should review.</div>
          </button>
          <button
            onClick={() => { setMode("target"); resetResults(); }}
            style={{ flex: 1, background: mode === "target" ? "#1b2638" : "#171a20", color: "#fff", border: `1px solid ${mode === "target" ? "#31558d" : "#343b47"}`, borderRadius: 10, padding: 13, textAlign: "left", cursor: "pointer" }}
          >
            <div style={{ fontWeight: 750 }}>2 · Analyze one item</div>
            <div style={{ color: "#788291", fontSize: 11, marginTop: 4 }}>Select one program, file, or folder and get advice only for that target.</div>
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 22 }}>
          {statusError && (
            <div style={{ background: "#30181b", color: "#ffb4b4", padding: 12, borderRadius: 10, marginBottom: 16 }}>
              {statusError}
            </div>
          )}

          {mode === "top" ? (
            <section>
              <div style={{ border: "1px solid #292f39", borderRadius: 13, padding: 16, background: "#0f1217" }}>
                <div style={{ display: "flex", gap: 16, alignItems: "end", flexWrap: "wrap" }}>
                  <div>
                    <div style={{ color: "#788291", fontSize: 11 }}>NUMBER TO ANALYZE</div>
                    <input
                      type="number"
                      min="1"
                      max="50"
                      value={limit}
                      onChange={(e) => setLimit(Math.min(50, Math.max(1, Number(e.target.value) || 1)))}
                      style={{ width: 110, marginTop: 7, background: "#0b0e13", border: "1px solid #343b47", color: "#fff", borderRadius: 8, padding: "10px 11px", outline: "none" }}
                    />
                  </div>

                  <div style={{ flex: 1, minWidth: 300 }}>
                    <div style={{ color: "#788291", fontSize: 11 }}>WHAT SHOULD AI REVIEW?</div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 7 }}>
                      {[
                        ["programs", "Programs"],
                        ["files", "Files"],
                        ["folders", "Folders"],
                      ].map(([key, label]) => (
                        <button
                          key={key}
                          onClick={() => toggleInclude(key)}
                          style={{ background: include[key] ? "#172338" : "#181b20", color: include[key] ? "#cfe0ff" : "#8f98a8", border: `1px solid ${include[key] ? "#29436f" : "#343b47"}`, borderRadius: 999, padding: "7px 11px", cursor: "pointer" }}
                        >
                          {include[key] ? "✓ " : ""}{label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <button
                    onClick={runTopAnalysis}
                    disabled={topLoading || !status?.configured}
                    style={{ background: "#2563eb", color: "#fff", border: "none", borderRadius: 9, padding: "11px 16px", cursor: topLoading || !status?.configured ? "default" : "pointer", opacity: topLoading || !status?.configured ? 0.55 : 1 }}
                  >
                    {topLoading ? "Analyzing..." : "Get AI Advice"}
                  </button>
                </div>

                <div style={{ color: "#687385", fontSize: 11, marginTop: 12, lineHeight: 1.5 }}>
                  Files use indexed file size. Programs use indexed InstallLocation size when available, otherwise Windows' recorded estimated install size. Folders are calculated from indexed descendant file sizes for the top-level folders of each indexed drive.
                </div>
              </div>
            </section>
          ) : (
            <section>
              <div style={{ border: "1px solid #292f39", borderRadius: 13, padding: 16, background: "#0f1217" }}>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {[
                    ["program", "Program"],
                    ["file", "File"],
                    ["folder", "Folder"],
                  ].map(([type, label]) => (
                    <button
                      key={type}
                      onClick={() => {
                        setTargetType(type);
                        setTargetQuery("");
                        setTargetResults([]);
                        setSelectedTarget(null);
                        setTargetData(null);
                      }}
                      style={{ background: targetType === type ? "#172338" : "#181b20", color: targetType === type ? "#cfe0ff" : "#8f98a8", border: `1px solid ${targetType === type ? "#29436f" : "#343b47"}`, borderRadius: 999, padding: "7px 11px", cursor: "pointer" }}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <input
                    value={targetQuery}
                    onChange={(e) => setTargetQuery(e.target.value)}
                    placeholder={`Search ${targetType}s by name or path...`}
                    style={{ flex: 1, minWidth: 0, background: "#0b0e13", border: "1px solid #343b47", color: "#fff", borderRadius: 9, padding: "10px 11px", outline: "none" }}
                  />
                </div>

                {targetSearchLoading && (
                  <div style={{ color: "#687385", fontSize: 12, marginTop: 10 }}>Searching indexed storage...</div>
                )}

                {targetResults.length > 0 && (
                  <div style={{ display: "grid", gap: 7, marginTop: 12 }}>
                    {targetResults.map((item, index) => {
                      const active = selectedTarget &&
                        selectedTarget.type === item.type &&
                        selectedTarget.id === item.id &&
                        selectedTarget.name === item.name;

                      return (
                        <button
                          key={`${item.type}|${item.id ?? item.name}|${index}`}
                          onClick={() => setSelectedTarget(item)}
                          style={{ width: "100%", textAlign: "left", background: active ? "#172338" : "#15181e", color: "#fff", border: `1px solid ${active ? "#31558d" : "#292f39"}`, borderRadius: 10, padding: 11, cursor: "pointer" }}
                        >
                          <div style={{ fontWeight: 700 }}>{item.name}</div>
                          <div style={{ color: "#788291", fontSize: 11, marginTop: 4, wordBreak: "break-all" }}>
                            {item.type === "program"
                              ? `${item.publisher || "Unknown publisher"}${item.version ? ` · ${item.version}` : ""}`
                              : `${formatBytes(item.size || 0)} · ${item.path}`}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}

                {selectedTarget && (
                  <div style={{ marginTop: 13, borderTop: "1px solid #292f39", paddingTop: 13 }}>
                    <div style={{ color: "#788291", fontSize: 11 }}>SELECTED</div>
                    <div style={{ fontWeight: 750, marginTop: 5 }}>{targetLabel}</div>
                    <div style={{ color: "#788291", fontSize: 11, marginTop: 4, wordBreak: "break-all" }}>
                      {selectedTarget.path || selectedTarget.installLocation || selectedTarget.publisher || ""}
                    </div>

                    <button
                      onClick={runTargetAnalysis}
                      disabled={targetLoading || !status?.configured}
                      style={{ marginTop: 12, background: "#2563eb", color: "#fff", border: "none", borderRadius: 9, padding: "10px 15px", cursor: targetLoading || !status?.configured ? "default" : "pointer", opacity: targetLoading || !status?.configured ? 0.55 : 1 }}
                    >
                      {targetLoading ? "Analyzing..." : "Analyze Selected"}
                    </button>
                  </div>
                )}
              </div>
            </section>
          )}

          {error && (
            <div style={{ background: "#30181b", color: "#ffb4b4", padding: 12, borderRadius: 10, marginTop: 16 }}>
              {error}
            </div>
          )}

          {topData?.analysis && (
            <section style={{ marginTop: 18 }}>
              <div style={{ background: "#151b26", border: "1px solid #2c3d58", borderRadius: 12, padding: 16, marginBottom: 14 }}>
                <div style={{ color: "#a9c9ff", fontSize: 11, letterSpacing: 0.6 }}>AI SUMMARY</div>
                <div style={{ marginTop: 7, lineHeight: 1.55 }}>{topData.analysis.summary}</div>
              </div>

              <div style={{ display: "grid", gap: 12 }}>
                {(topData.analysis.suggestions || []).map((suggestion, index) => {
                  const badge = priorityStyle(suggestion.priority);
                  const referenced = (suggestion.targetKeys || [])
                    .map((key) => topEntities.get(key))
                    .filter(Boolean)
                    .slice(0, 10);

                  return (
                    <div key={`${suggestion.title}|${index}`} style={{ border: "1px solid #292f39", borderRadius: 12, padding: 16, background: "#0f1217" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                        <div style={{ fontWeight: 750 }}>{suggestion.title}</div>
                        <span style={{ border: `1px solid ${badge.border}`, color: badge.color, background: badge.background, borderRadius: 999, padding: "4px 8px", fontSize: 10, whiteSpace: "nowrap" }}>
                          {suggestion.priority} · {suggestion.confidence}%
                        </span>
                      </div>
                      {suggestion.estimatedBytes > 0 && (
                        <div style={{ color: "#8f98a8", fontSize: 11, marginTop: 6 }}>
                          Potential reviewable space: {formatBytes(suggestion.estimatedBytes)}
                        </div>
                      )}
                      <div style={{ color: "#b7beca", fontSize: 13, lineHeight: 1.5, marginTop: 9 }}>{suggestion.reason}</div>
                      <div style={{ color: "#d5d9df", fontSize: 13, marginTop: 9 }}><strong>Action:</strong> {suggestion.action}</div>
                      {suggestion.caution && <div style={{ color: "#c7ad79", fontSize: 12, marginTop: 8 }}>⚠ {suggestion.caution}</div>}

                      {referenced.length > 0 && (
                        <div style={{ marginTop: 11, display: "grid", gap: 5 }}>
                          {referenced.map((item) => (
                            <div key={item.key || `${item.type}|${item.id}|${item.path}`} style={{ padding: 8, background: "#15181e", borderRadius: 8, border: "1px solid #232832" }}>
                              <div style={{ fontSize: 12, fontWeight: 650 }}>{item.name}</div>
                              <div style={{ color: "#788291", fontSize: 10, marginTop: 3, wordBreak: "break-all" }}>
                                {formatBytes(item.size || 0)} · {item.path || item.installLocation || item.publisher || ""}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div style={{ color: "#687385", fontSize: 11, marginTop: 16 }}>
                AI received only the selected top entities shown by this analysis request. Recommendations are advisory; DiskLens does not delete anything from this panel.
              </div>
            </section>
          )}

          {targetData?.analysis && (
            <section style={{ marginTop: 18 }}>
              <div style={{ background: "#151b26", border: "1px solid #2c3d58", borderRadius: 12, padding: 16 }}>
                <div style={{ color: "#a9c9ff", fontSize: 11 }}>SELECTED TARGET</div>
                <div style={{ fontWeight: 750, fontSize: 20, marginTop: 6 }}>{targetData.target.name}</div>
                <div style={{ color: "#788291", fontSize: 11, marginTop: 4, wordBreak: "break-all" }}>
                  {targetData.target.path || targetData.target.installLocation || ""}
                </div>
                <div style={{ color: "#8f98a8", fontSize: 12, marginTop: 10 }}>
                  Indexed/storage size: {formatBytes(targetData.target.size || 0)} · {targetData.target.sizeBasis || ""}
                </div>
                {targetData.target.modifiedAt && (
                  <div style={{ color: "#687385", fontSize: 11, marginTop: 4 }}>
                    Modified: {formatDate(targetData.target.modifiedAt)}
                  </div>
                )}
              </div>

              <div style={{ border: "1px solid #292f39", borderRadius: 12, padding: 16, marginTop: 12, background: "#0f1217" }}>
                <div style={{ color: "#a9c9ff", fontSize: 11 }}>AI ASSESSMENT · {targetData.analysis.confidence}% CONFIDENCE</div>
                <div style={{ fontWeight: 700, marginTop: 6 }}>{targetData.analysis.storageAssessment}</div>
                <div style={{ color: "#b7beca", fontSize: 13, lineHeight: 1.5, marginTop: 9 }}>{targetData.analysis.summary}</div>
              </div>

              {(targetData.analysis.opportunities || []).map((opportunity, index) => {
                const badge = priorityStyle(opportunity.priority);
                return (
                  <div key={`${opportunity.title}|${index}`} style={{ border: "1px solid #292f39", borderRadius: 12, padding: 15, marginTop: 10, background: "#0f1217" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                      <div style={{ fontWeight: 700 }}>{opportunity.title}</div>
                      <span style={{ border: `1px solid ${badge.border}`, color: badge.color, background: badge.background, borderRadius: 999, padding: "4px 8px", fontSize: 10 }}>
                        {opportunity.priority} · {opportunity.confidence}%
                      </span>
                    </div>
                    {opportunity.estimatedBytes > 0 && <div style={{ color: "#8f98a8", fontSize: 11, marginTop: 5 }}>{formatBytes(opportunity.estimatedBytes)} potentially reviewable</div>}
                    <div style={{ color: "#b7beca", fontSize: 13, lineHeight: 1.5, marginTop: 8 }}>{opportunity.reason}</div>
                    <div style={{ color: "#d5d9df", fontSize: 13, marginTop: 8 }}><strong>Action:</strong> {opportunity.action}</div>
                    {opportunity.caution && <div style={{ color: "#c7ad79", fontSize: 12, marginTop: 8 }}>⚠ {opportunity.caution}</div>}
                  </div>
                );
              })}

              {targetData.analysis.keepReasons?.length > 0 && (
                <div style={{ border: "1px solid #293b2d", borderRadius: 12, padding: 15, marginTop: 12, background: "#0f1712" }}>
                  <div style={{ color: "#a9cfae", fontSize: 11 }}>WHY IT MAY BE WORTH KEEPING</div>
                  {targetData.analysis.keepReasons.map((reason) => (
                    <div key={reason} style={{ color: "#b8c8bc", fontSize: 13, marginTop: 8 }}>✓ {reason}</div>
                  ))}
                </div>
              )}

              <div style={{ border: "1px solid #292f39", borderRadius: 12, padding: 15, marginTop: 12, background: "#15181e" }}>
                <div style={{ color: "#a9c9ff", fontSize: 11 }}>FINAL ADVICE</div>
                <div style={{ color: "#d5d9df", fontSize: 13, lineHeight: 1.55, marginTop: 7 }}>{targetData.analysis.finalAdvice}</div>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
