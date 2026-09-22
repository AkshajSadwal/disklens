"use client";

import { useMemo, useState } from "react";
import { API } from "../../lib/api";
import { formatBytes } from "../../lib/formatters";

export default function DeleteDialog({ items, onClose, onComplete }) {
  const [mode, setMode] = useState("recycle");
  const [selectedIds, setSelectedIds] = useState(() => new Set(items.map((item) => item.id)));
  const [confirmedPermanent, setConfirmedPermanent] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");

  const selectedItems = useMemo(
    () => items.filter((item) => selectedIds.has(item.id)),
    [items, selectedIds],
  );

  const selectedSize = selectedItems.reduce(
    (sum, item) => sum + Number(item.size || 0),
    0,
  );

  function toggleItem(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);

      if (next.has(id)) next.delete(id);
      else next.add(id);

      return next;
    });
  }

  async function handleDelete() {
    if (selectedItems.length === 0) {
      setError("Select at least one file.");
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
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ids: selectedItems.map((item) => item.id),
          mode,
        }),
      });

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(data?.error || `HTTP ${response.status}`);
      }

      const successfulIds = (data?.results || [])
        .filter((result) => result.ok)
        .map((result) => result.id);

      if (successfulIds.length === 0) {
        throw new Error(
          data?.results?.find((result) => result.error)?.error ||
            "No files were deleted.",
        );
      }

      onComplete(successfulIds, data);
    } catch (err) {
      setError(err.message);
      setDeleting(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.72)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 2000,
        padding: 20,
        boxSizing: "border-box",
      }}
      onClick={() => !deleting && onClose()}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          width: 650,
          maxWidth: "96vw",
          maxHeight: "90vh",
          overflowY: "auto",
          background: "#15181e",
          border: "1px solid #343b47",
          borderRadius: 18,
          padding: 25,
          boxSizing: "border-box",
          boxShadow: "0 25px 70px rgba(0,0,0,0.45)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 20,
            alignItems: "center",
            marginBottom: 18,
          }}
        >
          <div>
            <h2 style={{ margin: 0 }}>Delete file</h2>
            <p style={{ color: "#8f98a8", margin: "7px 0 0" }}>
              Review exactly what DiskLens will remove.
            </p>
          </div>

          <button
            onClick={onClose}
            disabled={deleting}
            style={{
              background: "#232832",
              color: "#fff",
              border: "1px solid #343b47",
              borderRadius: 8,
              padding: "8px 12px",
              cursor: deleting ? "default" : "pointer",
            }}
          >
            ✕
          </button>
        </div>

        <div
          style={{
            border: "1px solid #292f39",
            borderRadius: 12,
            overflow: "hidden",
            marginBottom: 18,
          }}
        >
          {items.map((item) => {
            const selected = selectedIds.has(item.id);

            return (
              <label
                key={item.id}
                style={{
                  display: "flex",
                  gap: 12,
                  alignItems: "flex-start",
                  padding: 14,
                  borderBottom: "1px solid #292f39",
                  cursor: "pointer",
                  background: selected ? "#11141a" : "transparent",
                }}
              >
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={() => toggleItem(item.id)}
                  disabled={deleting}
                  style={{ marginTop: 3 }}
                />

                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    style={{
                      fontWeight: 600,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {item.name}
                  </div>

                  <div
                    style={{
                      color: "#687385",
                      fontSize: 12,
                      marginTop: 4,
                      wordBreak: "break-all",
                    }}
                  >
                    {item.path}
                  </div>
                </div>

                <div style={{ color: "#aeb6c4", whiteSpace: "nowrap" }}>
                  {formatBytes(item.size)}
                </div>
              </label>
            );
          })}
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 10,
            marginBottom: 16,
          }}
        >
          <button
            onClick={() => {
              setMode("recycle");
              setConfirmedPermanent(false);
              setError("");
            }}
            disabled={deleting}
            style={{
              textAlign: "left",
              background: mode === "recycle" ? "#1b2638" : "#0f1217",
              color: "#fff",
              border: `1px solid ${mode === "recycle" ? "#3b82f6" : "#292f39"}`,
              borderRadius: 11,
              padding: 14,
              cursor: deleting ? "default" : "pointer",
            }}
          >
            <div style={{ fontWeight: 700 }}>Move to Recycle Bin</div>
            <div style={{ color: "#8f98a8", fontSize: 12, marginTop: 5 }}>
              Recoverable from Windows Recycle Bin.
            </div>
          </button>

          <button
            onClick={() => {
              setMode("permanent");
              setError("");
            }}
            disabled={deleting}
            style={{
              textAlign: "left",
              background: mode === "permanent" ? "#341b1f" : "#0f1217",
              color: "#fff",
              border: `1px solid ${mode === "permanent" ? "#ef4444" : "#292f39"}`,
              borderRadius: 11,
              padding: 14,
              cursor: deleting ? "default" : "pointer",
            }}
          >
            <div style={{ fontWeight: 700 }}>Delete permanently</div>
            <div style={{ color: "#8f98a8", fontSize: 12, marginTop: 5 }}>
              Removes the file directly instead of using Recycle Bin.
            </div>
          </button>
        </div>

        {mode === "permanent" && (
          <label
            style={{
              display: "flex",
              gap: 10,
              alignItems: "flex-start",
              padding: 13,
              background: "#25171a",
              border: "1px solid #512127",
              borderRadius: 10,
              marginBottom: 14,
              color: "#ffb4b4",
              fontSize: 13,
            }}
          >
            <input
              type="checkbox"
              checked={confirmedPermanent}
              onChange={(event) => {
                setConfirmedPermanent(event.target.checked);
                setError("");
              }}
              disabled={deleting}
              style={{ marginTop: 2 }}
            />
            <span>
              I understand that DiskLens will permanently delete the selected
              file(s) and Windows Recycle Bin will not be used.
            </span>
          </label>
        )}

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 15,
            marginBottom: 15,
          }}
        >
          <div style={{ color: "#8f98a8", fontSize: 13 }}>
            {selectedItems.length} file(s) · {formatBytes(selectedSize)}
          </div>

          {error && (
            <div style={{ color: "#ff9b9b", fontSize: 13 }}>{error}</div>
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button
            onClick={onClose}
            disabled={deleting}
            style={{
              background: "#232832",
              color: "#fff",
              border: "1px solid #343b47",
              borderRadius: 9,
              padding: "11px 16px",
              cursor: deleting ? "default" : "pointer",
            }}
          >
            Cancel
          </button>

          <button
            onClick={handleDelete}
            disabled={deleting || selectedItems.length === 0}
            style={{
              background: mode === "permanent" ? "#dc2626" : "#2563eb",
              color: "#fff",
              border: "none",
              borderRadius: 9,
              padding: "11px 18px",
              cursor:
                deleting || selectedItems.length === 0 ? "default" : "pointer",
              opacity: deleting || selectedItems.length === 0 ? 0.55 : 1,
            }}
          >
            {deleting
              ? "Deleting..."
              : mode === "permanent"
                ? "Delete Permanently"
                : "Move to Recycle Bin"}
          </button>
        </div>
      </div>
    </div>
  );
}
