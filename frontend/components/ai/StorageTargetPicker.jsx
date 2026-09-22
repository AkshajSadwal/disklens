"use client";

import { useEffect, useMemo, useState } from "react";
import { API } from "../../lib/api";
import { formatBytes } from "../../lib/formatters";
import Icon from "../common/Icon";

export default function StorageTargetPicker({ targetType, onSelect, onClose }) {
  const [roots, setRoots] = useState([]);
  const [currentPath, setCurrentPath] = useState("");
  const [items, setItems] = useState([]);
  const [backStack, setBackStack] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function loadRoots() {
      try {
        const response = await fetch(`${API}/api/roots`);
        const data = await response.json().catch(() => []);
        if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
        if (!cancelled) {
          setRoots(data || []);
          if (data?.[0]?.root) setCurrentPath(data[0].root);
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    loadRoots();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!currentPath) return;
    let cancelled = false;
    async function loadFolder() {
      setLoading(true);
      setError("");
      try {
        const response = await fetch(`${API}/api/folders?path=${encodeURIComponent(currentPath)}`);
        const data = await response.json().catch(() => []);
        if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
        if (!cancelled) setItems(data || []);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    loadFolder();
    return () => { cancelled = true; };
  }, [currentPath]);

  const breadcrumbs = useMemo(() => {
    if (!currentPath) return [];
    const parts = currentPath.split("\\").filter(Boolean);
    let accumulated = "";
    return parts.map((part, index) => {
      accumulated = index === 0 ? `${part}\\` : `${accumulated}\\${part}`;
      return { name: part, path: index === 0 ? `${part}\\` : accumulated };
    });
  }, [currentPath]);

  function navigate(nextPath) {
    if (!nextPath || nextPath === currentPath) return;
    setBackStack((prev) => [...prev, currentPath]);
    setCurrentPath(nextPath);
  }

  function goBack() {
    if (!backStack.length) return;
    const previous = backStack[backStack.length - 1];
    setBackStack((prev) => prev.slice(0, -1));
    setCurrentPath(previous);
  }

  function selectItem(item) {
    if (!item?.id) return;
    onSelect({
      type: item.type === "directory" ? "folder" : "file",
      id: item.id,
      root: item.root,
      name: item.name,
      path: item.path,
      size: item.size,
      modifiedAt: item.modifiedAt,
      fileCount: item.fileCount,
      folderCount: item.folderCount,
    });
  }

  return (
    <div className="dl-picker-backdrop" onClick={onClose}>
      <section className="dl-picker-surface" onClick={(event) => event.stopPropagation()}>
        <div className="dl-picker-head">
          <div>
            <div className="dl-eyebrow">SELECT FROM STORAGE</div>
            <h2>Browse storage</h2>
            <p>Choose a {targetType} using DiskLens storage navigation.</p>
          </div>
          <button className="dl-icon-btn" onClick={onClose}>×</button>
        </div>

        <div className="dl-picker-roots">
          {(roots || []).map((root) => (
            <button
              key={root.root}
              className={root.root === currentPath ? "is-active" : ""}
              onClick={() => { setBackStack([]); setCurrentPath(root.root); }}
            >
              {root.root}
            </button>
          ))}
        </div>

        <div className="dl-picker-toolbar">
          <button className="dl-icon-btn" onClick={goBack} disabled={!backStack.length} title="Back">
            <Icon name="arrowLeft" size={15} />
          </button>
          <div className="dl-picker-breadcrumbs">
            {breadcrumbs.map((crumb, index) => (
              <span key={crumb.path}>
                <button onClick={() => navigate(crumb.path)}>{crumb.name}</button>
                {index < breadcrumbs.length - 1 && <Icon name="chevronRight" size={12} />}
              </span>
            ))}
          </div>
        </div>

        {error && <div className="dl-alert">{error}</div>}

        <div className="dl-picker-list items-scroll">
          {loading ? (
            <div className="dl-loading">Loading storage...</div>
          ) : items.length === 0 ? (
            <div className="dl-empty">No indexed items in this location.</div>
          ) : (
            items.map((item) => (
              <div className="dl-picker-row" key={`${item.path}|${item.id || "x"}`}>
                <button
                  className="dl-picker-main"
                  onClick={() => item.type === "directory" ? navigate(item.path) : selectItem(item)}
                >
                  <div className={`dl-item-icon ${item.type === "directory" ? "folder" : "file"}`}>
                    <Icon name={item.type === "directory" ? "folder" : "file"} size={16} />
                  </div>
                  <div className="dl-picker-name">
                    <span>{item.name}</span>
                    <small>{item.type === "directory" ? `${item.fileCount || 0} files · ${item.folderCount || 0} folders` : formatBytes(item.size || 0)}</small>
                  </div>
                  {item.type === "directory" && <Icon name="chevronRight" size={14} />}
                </button>
                <button className="dl-text-btn" onClick={() => selectItem(item)} disabled={!item.id}>
                  Select
                </button>
              </div>
            ))
          )}
        </div>

        <div className="dl-picker-foot">
          <span>Click a folder name to browse inside it. Use Select to choose a file or folder.</span>
          <button className="dl-secondary-btn" onClick={onClose}>Cancel</button>
        </div>
      </section>
    </div>
  );
}
