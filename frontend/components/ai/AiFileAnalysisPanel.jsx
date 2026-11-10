"use client";

import { useEffect, useState } from "react";
import { API } from "../../lib/api";

const LEVELS = {
  unknown: "#8f98a8",
  low: "#79b989",
  medium: "#d6b36a",
  high: "#e58c67",
  critical: "#ef6666",
};

export default function AiFileAnalysisPanel({ item, onClose }) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function run() {
      try {
        const response = await fetch(`${API}/api/ai/file/${item.id}`, { method: "POST" });
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
        if (!cancelled) setData(payload);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    run();
    return () => { cancelled = true; };
  }, [item.id]);

  const level = data?.analysis?.dangerLevel || "unknown";

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.76)", zIndex: 2500, display: "flex", justifyContent: "flex-end" }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 560, maxWidth: "94vw", height: "100%", background: "#11141a", borderLeft: "1px solid #303743", padding: 26, boxSizing: "border-box", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 15, marginBottom: 24 }}>
          <div>
            <h2 style={{ margin: 0 }}>File Safety Analysis</h2>
            {data?.analysis?.source === "local-rules" && <div style={{ color: "#b9a6ff", fontSize: 12, marginTop: 5 }}>Local rule-based analysis · not an AI verdict</div>}
            <div style={{ color: "#788291", fontSize: 12, marginTop: 5, wordBreak: "break-word" }}>{item.name}</div>
          </div>
          <button onClick={onClose} style={{ background: "#232832", color: "#fff", border: "1px solid #343b47", borderRadius: 8, padding: "8px 12px", cursor: "pointer" }}>✕</button>
        </div>

        {loading ? (
          <div style={{ color: "#8f98a8", padding: 50, textAlign: "center" }}>Collecting local evidence and asking Azure OpenAI...</div>
        ) : error ? (
          <div style={{ background: "#30181b", color: "#ffb4b4", padding: 14, borderRadius: 10 }}>{error}</div>
        ) : data ? (
          <>
            <div style={{ border: `1px solid ${LEVELS[level] || LEVELS.unknown}`, borderRadius: 14, padding: 18, marginBottom: 16, background: "#0f1217" }}>
              <div style={{ display: "flex", alignItems: "end", justifyContent: "space-between", gap: 15 }}>
                <div>
                  <div style={{ color: "#788291", fontSize: 11, letterSpacing: 0.7 }}>DANGER LEVEL</div>
                  <div style={{ color: LEVELS[level] || LEVELS.unknown, fontSize: 30, fontWeight: 800, marginTop: 4, textTransform: "capitalize" }}>{level}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 24, fontWeight: 750 }}>{data.analysis.dangerScore}/100</div>
                  <div style={{ color: "#788291", fontSize: 11 }}>{data.analysis.confidence}% analysis confidence</div>
                </div>
              </div>
              <div style={{ color: "#d5d9df", marginTop: 14, lineHeight: 1.55, fontSize: 13 }}>{data.analysis.summary}</div>
            </div>

            <section style={{ marginBottom: 18 }}>
              <h3 style={{ margin: "0 0 9px" }}>Indicators</h3>
              {data.analysis.indicators.length ? data.analysis.indicators.map((value) => <div key={value} style={{ padding: "7px 0", color: "#c7cdd6", fontSize: 13 }}>• {value}</div>) : <div style={{ color: "#788291", fontSize: 13 }}>No strong negative indicators were identified from the available evidence.</div>}
            </section>

            <section style={{ marginBottom: 18 }}>
              <h3 style={{ margin: "0 0 9px" }}>Reassuring signals</h3>
              {data.analysis.reassuringSignals.length ? data.analysis.reassuringSignals.map((value) => <div key={value} style={{ padding: "7px 0", color: "#b9d4bd", fontSize: 13 }}>✓ {value}</div>) : <div style={{ color: "#788291", fontSize: 13 }}>No strong reassuring signal was available.</div>}
            </section>

            <div style={{ background: "#151b26", border: "1px solid #2c3d58", borderRadius: 12, padding: 15, marginBottom: 18 }}>
              <div style={{ color: "#a9c9ff", fontSize: 11 }}>RECOMMENDED ACTION</div>
              <div style={{ fontWeight: 700, marginTop: 5, textTransform: "capitalize" }}>{data.analysis.recommendedAction.replaceAll("_", " ")}</div>
              <div style={{ color: "#aeb6c4", marginTop: 9, fontSize: 13, lineHeight: 1.5 }}>{data.analysis.deletionAdvice}</div>
            </div>

            <details style={{ border: "1px solid #292f39", borderRadius: 10, padding: 12 }}>
              <summary style={{ cursor: "pointer", color: "#c9ced7", fontSize: 13 }}>Evidence collected</summary>
              <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", color: "#7f8997", fontSize: 10, marginTop: 12 }}>{JSON.stringify({ ...data.evidence, contentSample: undefined, embeddedStringsSample: undefined }, null, 2)}</pre>
            </details>

            <div style={{ color: "#687385", fontSize: 11, marginTop: 14 }}>
              This is an evidence-based AI assessment, not a malware verdict. For suspicious files, scan or quarantine rather than relying on deletion as a security response.
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
