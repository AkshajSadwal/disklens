"use client";

import { useEffect, useMemo, useState } from "react";
import { API } from "../../lib/api";
import { formatBytes } from "../../lib/formatters";
import Icon from "../common/Icon";

export default function DeleteDialog({ items, onClose, onComplete }) {
  const [mode, setMode] = useState("recycle");
  const [selectedIds, setSelectedIds] = useState(() => new Set(items.map((item) => item.id)));
  const [confirmedPermanent, setConfirmedPermanent] = useState(false);
  const [confirmedActivity, setConfirmedActivity] = useState(false);
  const [activity, setActivity] = useState({ status: "checking", message: "Checking selected files for active use…" });
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");

  const selectedItems = useMemo(() => items.filter((item) => selectedIds.has(item.id)), [items, selectedIds]);
  const selectedSize = selectedItems.reduce((sum, item) => sum + Number(item.size || 0), 0);

  useEffect(() => {
    if (!selectedIds.size) { setActivity(null); setConfirmedActivity(false); return undefined; }
    let active = true;
    const controller = new AbortController();
    setActivity({ status: "checking", message: "Checking selected files for active use…" });
    setConfirmedActivity(false);
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`${API}/api/delete/activity-check`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids: [...selectedIds] }), signal: controller.signal,
        });
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.error || `Activity check failed (${response.status}).`);
        if (active) setActivity(data);
      } catch (err) {
        if (active && err.name !== "AbortError") setActivity({ status: "unavailable", message: err.message });
      }
    }, 180);
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [selectedIds]);

  function toggleItem(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function handleDelete() {
    if (!selectedItems.length) {
      setError("Select at least one item.");
      return;
    }
    if (mode === "permanent" && !confirmedPermanent) {
      setError("Confirm permanent deletion first.");
      return;
    }
    if (activity?.status === "checking") {
      setError("Wait for the file activity check to finish before continuing.");
      return;
    }
    if (activity?.status === "in-use" && !confirmedActivity) {
      setError("Review the open-handle warning and confirm before continuing.");
      return;
    }

    setDeleting(true);
    setError("");
    try {
      const response = await fetch(`${API}/api/delete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: selectedItems.map((item) => item.id), mode }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);

      const successfulIds = (data?.results || []).filter((result) => result.ok).map((result) => result.id);
      if (!successfulIds.length) throw new Error(data?.results?.find((result) => result.error)?.error || "No files were deleted.");
      onComplete(successfulIds, data);
    } catch (err) {
      setError(err.message);
      setDeleting(false);
    }
  }

  return (
    <div className="dl-delete-backdrop" onClick={() => !deleting && onClose()}>
      <div className="dl-delete-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="dl-delete-head">
          <div>
            <h2>Review deletion</h2>
            <p>Choose what DiskLens should remove before anything happens.</p>
          </div>
          <button className="dl-icon-btn" onClick={onClose} disabled={deleting} title="Close"><Icon name="close" size={16} /></button>
        </div>

        <div className="dl-delete-list">
          {items.map((item) => {
            const selected = selectedIds.has(item.id);
            return (
              <label className={`dl-delete-item ${selected ? "is-selected" : ""}`} key={item.id}>
                <input type="checkbox" checked={selected} onChange={() => toggleItem(item.id)} disabled={deleting} />
                <div className="dl-delete-main">
                  <div className="dl-delete-name">{item.name}</div>
                  <div className="dl-delete-path">{item.path}</div>
                </div>
                <div className="dl-delete-size">{formatBytes(item.size)}</div>
              </label>
            );
          })}
        </div>

        {activity && <div className={`dl-delete-activity status-${activity.status}`} role="status">
          <strong>{activity.status === "checking" ? "Checking file activity" : activity.status === "in-use" ? "Some files are in use" : activity.status === "clear" ? "No open files detected" : "File activity could not be fully checked"}</strong>
          <span>{activity.message}{activity.processIds?.length ? ` Process IDs: ${activity.processIds.join(", ")}.` : ""}</span>
        </div>}
        {activity?.status === "in-use" && <label className="dl-delete-confirm">
          <input type="checkbox" checked={confirmedActivity} onChange={(event) => { setConfirmedActivity(event.target.checked); setError(""); }} disabled={deleting} />
          <span>I reviewed the open-handle warning and want DiskLens to try this action. The operating system may still refuse it.</span>
        </label>}

        <div className="dl-delete-modes">
          <button className={`dl-delete-mode ${mode === "recycle" ? "active" : ""}`} onClick={() => { setMode("recycle"); setConfirmedPermanent(false); setError(""); }} disabled={deleting}>
            <strong>Move to Recycle Bin</strong>
            <span>Moves to the system Trash or Recycle Bin when supported by this platform.</span>
          </button>
          <button className={`dl-delete-mode permanent ${mode === "permanent" ? "active" : ""}`} onClick={() => { setMode("permanent"); setError(""); }} disabled={deleting}>
            <strong>Delete permanently</strong>
            <span>Removes the selected item(s) directly. This cannot be undone.</span>
          </button>
        </div>

        {mode === "permanent" && (
          <label className="dl-delete-confirm">
            <input type="checkbox" checked={confirmedPermanent} onChange={(event) => { setConfirmedPermanent(event.target.checked); setError(""); }} disabled={deleting} />
            <span>I understand that the selected item(s) will be permanently deleted and system Trash or Recycle Bin will not be used.</span>
          </label>
        )}

        {error && <div className="dl-alert">{error}</div>}

        <div className="dl-delete-footer">
          <div className="summary">{selectedItems.length} item{selectedItems.length === 1 ? "" : "s"} · {formatBytes(selectedSize)}</div>
          <div className="actions">
            <button className="dl-secondary-btn" onClick={onClose} disabled={deleting}>Cancel</button>
            <button className={mode === "permanent" ? "dl-danger-btn" : "dl-primary-btn"} onClick={handleDelete} disabled={deleting || !selectedItems.length || activity?.status === "checking"}>
              {deleting ? "Deleting..." : activity?.status === "checking" ? "Checking files…" : mode === "permanent" ? "Delete permanently" : "Move to Trash / Recycle Bin"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
