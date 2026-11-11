"use client";

import { useEffect, useMemo, useState } from "react";
import { API } from "../../lib/api";
import { formatBytes } from "../../lib/formatters";
import Icon from "../common/Icon";

function confidenceLabel(value) {
  if (value >= 95) return "Very strong";
  if (value >= 85) return "Strong match";
  if (value >= 70) return "Moderate match";
  return "Low confidence";
}

function confidenceClass(value) {
  if (value >= 85) return "high";
  if (value >= 70) return "mid";
  return "low";
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
  const [candidateFilter, setCandidateFilter] = useState("all");

  useEffect(() => {
    async function loadPrograms() {
      try {
        const response = await fetch(`${API}/api/programs`);
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
        setPrograms(data.programs || []);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }

    loadPrograms();
  }, []);

  useEffect(() => {
    // Show a useful first item by default instead of leaving the detail pane empty.
    // This analyzes only one program; the full installed-program list stays lightweight.
    if (!loading && !selectedProgram && programs.length > 0) {
      analyzeProgram(programs[0]);
    }
  }, [loading, programs, selectedProgram]);

  const filteredPrograms = useMemo(() => {
    const q = programQuery.trim().toLowerCase();
    if (!q) return programs;
    return programs.filter((program) =>
      `${program.name} ${program.publisher} ${program.version}`.toLowerCase().includes(q),
    );
  }, [programs, programQuery]);

  async function analyzeProgram(program) {
    setSelectedProgram(program);
    setCandidates([]);
    setSelectedIds(new Set());
    setCandidatesLoading(true);
    setError("");
    setCandidateFilter("all");

    try {
      const response = await fetch(`${API}/api/programs/candidates`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(program),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);

      const rows = data.candidates || [];
      setCandidates(rows);
      setSelectedIds(new Set(rows.filter((item) => item.defaultSelected).map((item) => item.id)));
    } catch (err) {
      setError(err.message);
    } finally {
      setCandidatesLoading(false);
    }
  }

  function analyzeTypedName() {
    const name = programQuery.trim();
    if (name) analyzeProgram({ name });
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
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const item of visibleCandidates) next.add(item.id);
      return next;
    });
  }

  function selectNone() {
    setSelectedIds(new Set());
  }

  const selectedItems = candidates.filter((item) => selectedIds.has(item.id));
  const selectedSize = selectedItems.reduce((sum, item) => sum + Number(item.size || 0), 0);
  const verifiedCount = candidates.filter((item) => item.category === "verified").length;
  const strongCount = candidates.filter((item) => item.confidence >= 85).length;
  const possibleLeftoverCount = candidates.filter((item) => item.category !== "verified").length;

  const visibleCandidates = useMemo(() => {
    let rows = candidates;

    if (candidateFilter === "verified") {
      rows = rows.filter((item) => item.category === "verified");
    } else if (candidateFilter === "strong") {
      rows = rows.filter((item) => item.confidence >= 85);
    } else if (candidateFilter === "possible") {
      rows = rows.filter((item) => item.category !== "verified");
    }

    return rows;
  }, [candidates, candidateFilter]);

  return (
    <div className={`dl-panel-root ${embedded ? "is-embedded" : ""}`}>
      <div className="dl-panel-surface">
        <header className="dl-ai-head">
          <div>
            <div className="dl-eyebrow">CLEANUP</div>
            <h2>Programs &amp; Cleanup</h2>
            <p>Find program files and leftovers using deterministic ownership evidence. Review every candidate before deletion.</p>
          </div>
          <button className="dl-icon-btn" onClick={onClose} title="Close"><Icon name="close" size={16} /></button>
        </header>

        <div className="dl-program-shell">
          <aside className="dl-program-sidebar">
            <div className="dl-program-search">
              <div className="dl-search-inline">
                <input
                  className="dl-search-input"
                  value={programQuery}
                  onChange={(event) => setProgramQuery(event.target.value)}
                  onKeyDown={(event) => event.key === "Enter" && analyzeTypedName()}
                  placeholder="Search installed programs..."
                />
                <button className="dl-secondary-btn" onClick={analyzeTypedName}>Analyze</button>
              </div>
              <div className="dl-program-hint">You can enter a program name even when Windows no longer lists it.</div>
            </div>

            <div className="dl-program-list items-scroll">
              {loading ? (
                <div className="dl-loading">Loading programs...</div>
              ) : filteredPrograms.length === 0 ? (
                <div className="dl-loading">No matching programs.</div>
              ) : (
                filteredPrograms.map((program) => {
                  const active = selectedProgram?.name === program.name &&
                    selectedProgram?.version === program.version &&
                    selectedProgram?.publisher === program.publisher;

                  return (
                    <button
                      key={`${program.name}|${program.version}|${program.publisher}|${program.registryPath}`}
                      className={`dl-program-row ${active ? "is-active" : ""}`}
                      onClick={() => analyzeProgram(program)}
                    >
                      <div className="dl-program-icon"><Icon name="programs" size={15} /></div>
                      <div className="dl-program-main">
                        <strong>{program.name}</strong>
                        <span>{program.publisher || "Unknown publisher"}{program.version ? ` · ${program.version}` : ""}</span>
                        <small>{formatBytes(program.size || 0)} · {program.sizeBasis === "indexed-install-location-size" ? "indexed install files" : program.sizeBasis === "package-manager-or-registry-estimate" ? "OS/package size estimate" : "size unavailable"}</small>
                      </div>
                      <Icon name="chevronRight" size={13} />
                    </button>
                  );
                })
              )}
            </div>
          </aside>

          <section className="dl-program-content">
            {selectedProgram ? (
              <>
                <div className="dl-program-head">
                  <div className="dl-item-kicker">PROGRAM</div>
                  <h2>{selectedProgram.name}</h2>
                  <p>{selectedProgram.installLocation || "No registered InstallLocation"}</p>
                  <div className="dl-program-summary">
                    <button type="button" className={`dl-pill verified ${candidateFilter === "verified" ? "is-active" : ""}`} onClick={() => setCandidateFilter("verified")}>
                      {verifiedCount} verified
                    </button>
                    <button type="button" className={`dl-pill strong ${candidateFilter === "strong" ? "is-active" : ""}`} onClick={() => setCandidateFilter("strong")}>
                      {strongCount} strong matches
                    </button>
                    <button type="button" className={`dl-pill possible ${candidateFilter === "possible" ? "is-active" : ""}`} onClick={() => setCandidateFilter("possible")}>
                      {possibleLeftoverCount} possible leftovers
                    </button>
                    <button type="button" className={`dl-pill all ${candidateFilter === "all" ? "is-active" : ""}`} onClick={() => setCandidateFilter("all")}>
                      All
                    </button>
                  </div>
                </div>

                <div className="dl-cleanup-toolbar">
                  <button className="dl-secondary-btn" onClick={selectAllVisible}>Select all</button>
                  <button className="dl-secondary-btn" onClick={selectNone}>Select none</button>
                  <div className="dl-selection-summary">{visibleCandidates.length} shown · {selectedItems.length} selected</div>
                </div>

                <div className="dl-candidate-list items-scroll">
                  {candidatesLoading ? (
                    <div className="dl-loading">Analyzing indexed files...</div>
                  ) : candidates.length === 0 ? (
                    <div className="dl-empty-state">
                      <div className="dl-item-icon large file" style={{ margin: "0 auto" }}><Icon name="search" size={19} /></div>
                      <h3>No matching indexed files were found.</h3>
                      <p>Try another program name or run a fresh scan to refresh the index.</p>
                    </div>
                  ) : visibleCandidates.length === 0 ? (
                    <div className="dl-empty-state">
                      <div className="dl-item-icon large program" style={{ margin: "0 auto" }}><Icon name="search" size={19} /></div>
                      <h3>No candidates in this category.</h3>
                      <p>Switch the filter above to see the other ownership matches.</p>
                    </div>
                  ) : (
                    visibleCandidates.map((item) => {
                      const selected = selectedIds.has(item.id);
                      const verified = item.category === "verified";
                      return (
                        <label className={`dl-candidate-card ${selected ? "is-selected" : ""}`} key={item.id}>
                          <input type="checkbox" checked={selected} onChange={() => toggleCandidate(item.id)} />
                          <div className="dl-candidate-icon"><Icon name={item.type === "directory" ? "folder" : "file"} size={15} /></div>
                          <div className="dl-candidate-main">
                            <div className="dl-candidate-top">
                              <strong>{item.name}</strong>
                              <span className={`dl-confidence ${verified ? "high" : confidenceClass(item.confidence)}`}>
                                {item.confidence}% · {confidenceLabel(item.confidence)}
                              </span>
                            </div>
                            <div className="dl-candidate-path">{item.path}</div>
                            <div className="dl-candidate-reasons">{item.reasons?.join(" · ") || "Matched by ownership evidence."}</div>
                          </div>
                          <div className="dl-candidate-meta">
                            <span className={`dl-candidate-type ${item.type === "directory" ? "folder" : "file"}`}>
                              {item.type === "directory" ? "Folder" : "File"}
                            </span>
                            <div className="dl-candidate-size">{formatBytes(item.size)}</div>
                          </div>
                        </label>
                      );
                    })
                  )}
                </div>

                <footer className="dl-cleanup-footer">
                  <div>
                    <strong>{selectedItems.length} selected</strong>
                    <span>{formatBytes(selectedSize)} · Verified candidates are selected by default.</span>
                  </div>
                  <div />
                  <button
                    className="dl-danger-btn"
                    onClick={() => onReviewDelete(selectedItems)}
                    disabled={!selectedItems.length}
                  >
                    Review selected items
                  </button>
                </footer>
              </>
            ) : (
              <div className="dl-empty-state">
                <div className="dl-item-icon large program" style={{ margin: "0 auto" }}><Icon name="programs" size={20} /></div>
                <h3>Select a program</h3>
                <p>Choose an installed program or enter a name above. DiskLens checks files and folders using deterministic ownership evidence.</p>
              </div>
            )}

            {error && <div className="dl-alert">{error}</div>}
          </section>
        </div>
      </div>
    </div>
  );
}
