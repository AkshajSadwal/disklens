"use client";

import { useEffect, useMemo, useState } from "react";
import { API } from "../../lib/api";
import { formatBytes } from "../../lib/formatters";

function confidenceLabel(value) {
  if (value >= 95) return "Very strong";
  if (value >= 85) return "Strong match";
  if (value >= 70) return "Moderate match";
  return "Low confidence";
}

export default function ProgramCleanupPanel({ onClose, onReviewDelete, embedded = false }) {
  const [programs, setPrograms] = useState([]);
  const [programQuery, setProgramQuery] = useState("");
  const [selectedProgram, setSelectedProgram] = useState(null);
  const [candidates, setCandidates] = useState([]);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    async function loadPrograms() {
      try {
        const response = await fetch(`${API}/api/programs`);
        const data = await response.json().catch(() => null);

        if (!response.ok) {
          throw new Error(data?.error || `HTTP ${response.status}`);
        }

        setPrograms(data.programs || []);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }

    loadPrograms();
  }, []);

  const filteredPrograms = useMemo(() => {
    const q = programQuery.trim().toLowerCase();
    if (!q) return programs;

    return programs.filter((program) =>
      `${program.name} ${program.publisher} ${program.version}`
        .toLowerCase()
        .includes(q),
    );
  }, [programs, programQuery]);

  async function analyzeProgram(program) {
    setSelectedProgram(program);
    setCandidates([]);
    setSelectedIds(new Set());
    setCandidatesLoading(true);
    setError("");

    try {
      const response = await fetch(`${API}/api/programs/candidates`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(program),
      });

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(data?.error || `HTTP ${response.status}`);
      }

      const rows = data.candidates || [];
      setCandidates(rows);
      setSelectedIds(
        new Set(rows.filter((item) => item.defaultSelected).map((item) => item.id)),
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setCandidatesLoading(false);
    }
  }

  function analyzeTypedName() {
    const name = programQuery.trim();
    if (!name) return;
    analyzeProgram({ name });
  }

  function toggleCandidate(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllVisible() {
    setSelectedIds(new Set(candidates.map((item) => item.id)));
  }

  function selectNone() {
    setSelectedIds(new Set());
  }

  const selectedItems = candidates.filter((item) => selectedIds.has(item.id));
  const selectedSize = selectedItems.reduce(
    (sum, item) => sum + Number(item.size || 0),
    0,
  );
  const verifiedCount = candidates.filter((item) => item.category === "verified").length;
  const strongCount = candidates.filter((item) => item.confidence >= 85).length;
  const possibleLeftoverCount = candidates.filter(
    (item) => item.category !== "verified",
  ).length;

  return (
    <div
      className={`dl-panel-root ${embedded ? "is-embedded" : ""}`}
      style={{
        position: embedded ? "relative" : "fixed",
        inset: embedded ? "auto" : 0,
        background: embedded ? "transparent" : "rgba(15,23,42,0.34)",
        zIndex: embedded ? "auto" : 1800,
        padding: embedded ? 0 : 24,
        boxSizing: "border-box",
        height: embedded ? "auto" : "100%",
        minHeight: embedded ? "100%" : 0,
      }}
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="dl-panel-surface"
        style={{
          width: "100%",
          height: embedded ? "auto" : "100%",
          minHeight: embedded ? "calc(100vh - 48px)" : 0,
          maxWidth: 1500,
          margin: "0 auto",
          background: embedded ? "#ffffff" : "#11141a",
          border: "1px solid #303743",
          borderRadius: 20,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 20,
            padding: "20px 24px",
            borderBottom: "1px solid #292f39",
          }}
        >
          <div>
            <h2 style={{ margin: 0 }}>Program Cleanup</h2>
            <p style={{ color: "#8f98a8", margin: "6px 0 0", fontSize: 13 }}>
              Deterministic ownership analysis. Review every candidate before deletion.
            </p>
          </div>

          <button
            onClick={onClose}
            style={{
              background: "#232832",
              color: "#fff",
              border: "1px solid #343b47",
              borderRadius: 8,
              padding: "8px 12px",
              cursor: "pointer",
            }}
          >
            ✕
          </button>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "340px 1fr",
            minHeight: 0,
            flex: 1,
          }}
        >
          <aside
            style={{
              borderRight: "1px solid #292f39",
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
            }}
          >
            <div style={{ padding: 16, borderBottom: "1px solid #292f39" }}>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  value={programQuery}
                  onChange={(event) => setProgramQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") analyzeTypedName();
                  }}
                  placeholder="Search installed programs..."
                  style={{
                    flex: 1,
                    minWidth: 0,
                    background: "#0b0e13",
                    border: "1px solid #343b47",
                    color: "#fff",
                    borderRadius: 9,
                    padding: "10px 11px",
                    outline: "none",
                  }}
                />
                <button
                  onClick={analyzeTypedName}
                  style={{
                    background: "#2563eb",
                    color: "#fff",
                    border: "none",
                    borderRadius: 9,
                    padding: "0 12px",
                    cursor: "pointer",
                  }}
                >
                  Analyze
                </button>
              </div>
              <div style={{ color: "#687385", fontSize: 11, marginTop: 7 }}>
                You can enter a program name even when Windows no longer lists it.
              </div>
            </div>

            <div style={{ overflowY: "auto", minHeight: 0 }}>
              {loading ? (
                <div style={{ padding: 25, color: "#8f98a8" }}>Loading programs...</div>
              ) : filteredPrograms.length === 0 ? (
                <div style={{ padding: 25, color: "#8f98a8" }}>No matching programs.</div>
              ) : (
                filteredPrograms.map((program) => {
                  const active =
                    selectedProgram?.name === program.name &&
                    selectedProgram?.version === program.version &&
                    selectedProgram?.publisher === program.publisher;

                  return (
                    <button
                      key={`${program.name}|${program.version}|${program.publisher}|${program.registryPath}`}
                      onClick={() => analyzeProgram(program)}
                      style={{
                        width: "100%",
                        textAlign: "left",
                        background: active ? "#1b2638" : "transparent",
                        border: "none",
                        borderBottom: "1px solid #20252d",
                        color: "#fff",
                        padding: "14px 16px",
                        cursor: "pointer",
                      }}
                    >
                      <div style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {program.name}
                      </div>
                      <div style={{ color: "#788291", fontSize: 12, marginTop: 4 }}>
                        {program.publisher || "Unknown publisher"}
                        {program.version ? ` · ${program.version}` : ""}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </aside>

          <section style={{ display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
            {selectedProgram ? (
              <>
                <div style={{ padding: "18px 22px", borderBottom: "1px solid #292f39" }}>
                  <div style={{ fontSize: 24, fontWeight: 750 }}>{selectedProgram.name}</div>
                  <div style={{ color: "#788291", fontSize: 12, marginTop: 5, wordBreak: "break-all" }}>
                    {selectedProgram.installLocation || "No registered InstallLocation"}
                  </div>

                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 13 }}>
                    <span style={{ background: "#172338", border: "1px solid #29436f", color: "#a9c9ff", borderRadius: 999, padding: "5px 9px", fontSize: 11 }}>
                      {verifiedCount} verified
                    </span>
                    <span style={{ background: "#16231a", border: "1px solid #2f5338", color: "#a9cfae", borderRadius: 999, padding: "5px 9px", fontSize: 11 }}>
                      {strongCount} strong matches
                    </span>
                    <span style={{ background: "#1f1c18", border: "1px solid #4a3b28", color: "#e4c89b", borderRadius: 999, padding: "5px 9px", fontSize: 11 }}>
                      {possibleLeftoverCount} possible leftovers
                    </span>
                  </div>
                </div>

                <div style={{ padding: 16, borderBottom: "1px solid #292f39", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <button onClick={selectAllVisible} style={{ background: "#232832", color: "#fff", border: "1px solid #343b47", borderRadius: 8, padding: "8px 11px", cursor: "pointer" }}>
                    Select all
                  </button>
                  <button onClick={selectNone} style={{ background: "#232832", color: "#fff", border: "1px solid #343b47", borderRadius: 8, padding: "8px 11px", cursor: "pointer" }}>
                    Select none
                  </button>
                  <div style={{ marginLeft: "auto", color: "#8f98a8", fontSize: 12 }}>
                    {candidates.length} candidate files
                  </div>
                </div>

                <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 16 }}>
                  {candidatesLoading ? (
                    <div style={{ padding: 40, textAlign: "center", color: "#8f98a8" }}>Analyzing indexed files...</div>
                  ) : candidates.length === 0 ? (
                    <div style={{ padding: 40, textAlign: "center", color: "#8f98a8" }}>
                      No matching indexed files were found.
                    </div>
                  ) : (
                    candidates.map((item) => {
                      const selected = selectedIds.has(item.id);
                      const verified = item.category === "verified";
                      const confidenceColor = verified ? "#a9c9ff" : item.confidence >= 85 ? "#a9cfae" : "#e4c89b";

                      return (
                        <label
                          key={item.id}
                          style={{
                            display: "flex",
                            gap: 12,
                            alignItems: "flex-start",
                            padding: 13,
                            marginBottom: 8,
                            border: `1px solid ${selected ? "#31558d" : "#292f39"}`,
                            borderRadius: 11,
                            background: selected ? "#101722" : "#0f1217",
                            cursor: "pointer",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => toggleCandidate(item.id)}
                            style={{ marginTop: 3 }}
                          />

                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: "flex", gap: 9, alignItems: "center", flexWrap: "wrap" }}>
                              <span style={{ fontWeight: 700, wordBreak: "break-word" }}>{item.name}</span>
                              <span style={{
                                borderRadius: 999,
                                padding: "3px 7px",
                                fontSize: 10,
                                border: `1px solid ${verified ? "#29436f" : "#43513f"}`,
                                color: confidenceColor,
                              }}>
                                {item.confidence}% · {confidenceLabel(item.confidence)}
                              </span>
                            </div>
                            <div style={{ color: "#687385", fontSize: 12, marginTop: 5, wordBreak: "break-all" }}>{item.path}</div>
                            <div style={{ color: "#8f98a8", fontSize: 11, marginTop: 8 }}>
                              {item.reasons?.join(" • ")}
                            </div>
                          </div>

                          <div style={{ color: "#aeb6c4", whiteSpace: "nowrap", fontSize: 12 }}>
                            {formatBytes(item.size)}
                          </div>
                        </label>
                      );
                    })
                  )}
                </div>

                <div style={{ padding: 16, borderTop: "1px solid #292f39", display: "flex", alignItems: "center", gap: 14 }}>
                  <div style={{ color: "#8f98a8", fontSize: 12 }}>
                    {selectedItems.length} selected · {formatBytes(selectedSize)}
                  </div>
                  <div style={{ flex: 1 }} />
                  <button
                    onClick={() => onReviewDelete(selectedItems)}
                    disabled={selectedItems.length === 0}
                    style={{
                      background: "#dc2626",
                      color: "#fff",
                      border: "none",
                      borderRadius: 9,
                      padding: "10px 15px",
                      cursor: selectedItems.length ? "pointer" : "default",
                      opacity: selectedItems.length ? 1 : 0.45,
                    }}
                  >
                    Review selected files
                  </button>
                </div>
              </>
            ) : (
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#687385", padding: 40, textAlign: "center" }}>
                Select an installed program, or type a program name above to find possible leftovers.
              </div>
            )}

            {error && (
              <div style={{ margin: "0 16px 16px", background: "#30181b", color: "#ff9b9b", padding: 12, borderRadius: 9, fontSize: 12 }}>
                {error}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
