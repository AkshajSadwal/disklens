"use client";

import { useMemo, useState } from "react";
import { API } from "../../lib/api";
import { formatBytes } from "../../lib/formatters";
import Icon from "../common/Icon";

export default function DeleteDialog({ items, onClose, onComplete }) {
  const [mode, setMode] = useState("recycle");
  const [selectedIds, setSelectedIds] = useState(() => new Set(items.map((item) => item.id)));
  const [confirmedPermanent, setConfirmedPermanent] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");

  const selectedItems = useMemo(() => items.filter((item) => selectedIds.has(item.id)), [items, selectedIds]);
  const selectedSize = selectedItems.reduce((sum, item) => sum + Number(item.size || 0), 0);

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

        <div className="dl-delete-modes">
          <button className={`dl-delete-mode ${mode === "recycle" ? "active" : ""}`} onClick={() => { setMode("recycle"); setConfirmedPermanent(false); setError(""); }} disabled={deleting}>
            <strong>Move to Recycle Bin</strong>
            <span>Recoverable from the Windows Recycle Bin.</span>
          </button>
          <button className={`dl-delete-mode permanent ${mode === "permanent" ? "active" : ""}`} onClick={() => { setMode("permanent"); setError(""); }} disabled={deleting}>
            <strong>Delete permanently</strong>
            <span>Removes the selected item(s) directly. This cannot be undone.</span>
          </button>
        </div>

        {mode === "permanent" && (
          <label className="dl-delete-confirm">
            <input type="checkbox" checked={confirmedPermanent} onChange={(event) => { setConfirmedPermanent(event.target.checked); setError(""); }} disabled={deleting} />
            <span>I understand that the selected item(s) will be permanently deleted and Windows Recycle Bin will not be used.</span>
          </label>
        )}

        {error && <div className="dl-alert">{error}</div>}

        <div className="dl-delete-footer">
          <div className="summary">{selectedItems.length} item{selectedItems.length === 1 ? "" : "s"} · {formatBytes(selectedSize)}</div>
          <div className="actions">
            <button className="dl-secondary-btn" onClick={onClose} disabled={deleting}>Cancel</button>
            <button className={mode === "permanent" ? "dl-danger-btn" : "dl-primary-btn"} onClick={handleDelete} disabled={deleting || !selectedItems.length}>
              {deleting ? "Deleting..." : mode === "permanent" ? "Delete permanently" : "Move to Recycle Bin"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
