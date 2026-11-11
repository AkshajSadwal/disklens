"use client";

import { useEffect, useMemo, useState } from "react";
import { API } from "../lib/api";
import Icon from "./common/Icon";
import Detail from "./Detail";
import DeleteDialog from "./files/DeleteDialog";
import ProgramCleanupPanel from "./programs/ProgramCleanupPanel";
import CleanupRecommendationsPanel from "./programs/CleanupRecommendationsPanel";
import AiStoragePanel from "./ai/AiStoragePanel";
import AISettingsPanel from "./settings/AISettingsPanel";
import UpdateCheckPanel from "./settings/UpdateCheckPanel";
import Sidebar from "./common/Sidebar";
import HomeDashboard from "./HomeDashboard";
import StorageExplorerView from "./StorageExplorerView";
import { formatBytes, formatDate } from "../lib/formatters";
import { groupSmallItems } from "../lib/sunburst";

export default function DiskLensApp() {
  const [view, setView] = useState("home");
  const [roots, setRoots] = useState([]);
  const [drives, setDrives] = useState([]);
  const [largestItems, setLargestItems] = useState([]);
  const [currentPath, setCurrentPath] = useState("");
  const [folderItems, setFolderItems] = useState([]);
  const [backStack, setBackStack] = useState([]);
  const [forwardStack, setForwardStack] = useState([]);
  const [selectedItem, setSelectedItem] = useState(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [deleteItems, setDeleteItems] = useState(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sunburstData, setSunburstData] = useState(null);
  const [sunburstLoading, setSunburstLoading] = useState(false);
  const [scanStatus, setScanStatus] = useState(null);
  const [scanError, setScanError] = useState("");
  const [scanStarting, setScanStarting] = useState(false);
  const [lastRefreshedScanId, setLastRefreshedScanId] = useState(null);
  const [cleanupMode, setCleanupMode] = useState("programs");

  const totalSize = useMemo(
    () => folderItems.reduce((sum, item) => sum + Number(item.size || 0), 0),
    [folderItems],
  );

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    async function loadOverview() {
      // Drive-capacity discovery can be slower on Windows. Keep it independent
      // from the indexed overview so the dashboard can render immediately.
      fetch(`${API}/api/drives`, { signal })
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json();
        })
        .then((data) => { if (!signal.aborted) setDrives(Array.isArray(data) ? data : []); })
        .catch(() => { if (!signal.aborted) setDrives([]); });

      try {
        const [rootsResponse, largestResponse] = await Promise.all([
          fetch(`${API}/api/roots`, { signal }),
          fetch(`${API}/api/items?page=1&limit=7&sort=size&order=desc`, { signal }).catch(() => null),
        ]);
        if (signal.aborted) return;
        if (!rootsResponse.ok) throw new Error(`HTTP ${rootsResponse.status}`);
        const rootData = await rootsResponse.json();
        const safeRoots = Array.isArray(rootData) ? rootData : [];
        setRoots(safeRoots);
        if (safeRoots.length > 0 && !currentPath) setCurrentPath(safeRoots[0].root);

        if (largestResponse?.ok) {
          const data = await largestResponse.json();
          if (!signal.aborted) setLargestItems(Array.isArray(data?.items) ? data.items : []);
        }
      } catch (err) {
        if (!signal.aborted) setError(err.message);
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    }

    loadOverview();
    return () => controller.abort();
  }, [refreshTick]);

  useEffect(() => {
    const scanRoots = Array.isArray(scanStatus?.roots) ? scanStatus.roots : [];
    if (!scanRoots.length || ["completed", "aborted", "interrupted", "failed"].includes(scanStatus?.status)) return undefined;
    let cancelled = false;

    async function pollScan() {
      try {
        const responses = await Promise.all(scanRoots.map(async (root) => {
          const response = await fetch(`${API}/api/scans/status?root=${encodeURIComponent(root)}`);
          const data = await response.json().catch(() => null);
          if (!response.ok) throw new Error(data?.error || `Scan status request failed (${response.status}).`);
          return { root, scan: data?.scan || null };
        }));
        if (cancelled) return;

        const rootStatuses = responses.map(({ root, scan }) => {
          const row = scan || { root, status: scanStatus?.status === "cancelling" ? "aborted" : "starting", scannedCount: 0, uploadedCount: 0, skippedCount: 0, totalEstimate: 0 };
          const totalEstimate = Number(row.totalEstimate || 0);
          const scannedCount = Number(row.scannedCount || 0);
          return {
            ...row,
            root,
            progressPercent: totalEstimate > 0 ? Math.min(100, Math.max(0, scannedCount / totalEstimate * 100)) : row.status === "completed" ? 100 : 0,
          };
        });
        const completedRoots = rootStatuses.filter((row) => row.status === "completed").length;
        const activeRow = rootStatuses.find((row) => ["running", "cancelling"].includes(row.status))
          || rootStatuses.find((row) => row.status === "starting")
          || null;
        const currentProgress = activeRow?.progressPercent || 0;
        const progressPercent = scanRoots.length
          ? Math.min(100, ((completedRoots + currentProgress / 100) / scanRoots.length) * 100)
          : 0;
        const totalScanned = rootStatuses.reduce((sum, row) => sum + Number(row.scannedCount || 0), 0);
        const totalUploaded = rootStatuses.reduce((sum, row) => sum + Number(row.uploadedCount || 0), 0);
        const totalSkipped = rootStatuses.reduce((sum, row) => sum + Number(row.skippedCount || 0), 0);
        const allCompleted = completedRoots === scanRoots.length;
        const anyCancelling = rootStatuses.some((row) => row.status === "cancelling");
        const anyAborted = rootStatuses.some((row) => ["aborted", "interrupted"].includes(row.status));
        const anyFailed = rootStatuses.some((row) => row.status === "failed");
        const nextStatus = anyCancelling ? "cancelling"
          : allCompleted ? "completed"
          : anyAborted ? "aborted"
          : anyFailed ? "failed"
          : "running";

        const next = {
          roots: scanRoots,
          rootStatuses,
          startedAt: activeRow?.startedAt || scanStatus?.startedAt || null,
          currentRoot: activeRow?.root || scanRoots.find((root) => !rootStatuses.some((row) => row.root === root && row.status === "completed")) || scanRoots[0],
          status: nextStatus,
          scannedCount: totalScanned,
          uploadedCount: totalUploaded,
          skippedCount: totalSkipped,
          totalEstimate: Number(activeRow?.totalEstimate || 0),
          currentScannedCount: Number(activeRow?.scannedCount || 0),
          currentTotalEstimate: Number(activeRow?.totalEstimate || 0),
          currentProgressPercent: currentProgress,
          progressPercent: allCompleted ? 100 : progressPercent,
          completedRoots,
          isEstimating: Boolean(activeRow && (activeRow.status === "starting" || (activeRow.status === "running" && !Number(activeRow.totalEstimate)))),
          scanId: rootStatuses.map((row) => row.scanId || row.status).join("|")
        };
        setScanStatus(next);

        if (allCompleted) {
          const completionKey = scanRoots.join("|");
          if (completionKey !== lastRefreshedScanId) {
            setLastRefreshedScanId(completionKey);
            setRefreshTick((value) => value + 1);
          }
        }
      } catch (err) {
        if (!cancelled) setScanError(err.message);
      }
    }

    pollScan();
    const timer = setInterval(pollScan, 1000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [scanStatus?.roots?.join("|"), scanStatus?.status, lastRefreshedScanId]);

  async function pickScanLocation() {
    setScanError("");
    try {
      const response = await fetch(`${API}/api/scans/pick`, { method: "POST" });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || `Could not open folder picker (${response.status}).`);
      if (data?.cancelled || !data?.root) return null;
      const selectedRoot = data.root;
      setRoots((previous) => previous.some((item) => item.root === selectedRoot)
        ? previous
        : [...previous, { root: selectedRoot, size: 0, itemCount: 0, fileCount: 0, folderCount: 0 }]);
      return selectedRoot;
    } catch (err) {
      setScanError(err.message);
      return null;
    }
  }

  async function startScan(rootsToScan) {
    const requestedRoots = [...new Set((Array.isArray(rootsToScan) ? rootsToScan : [rootsToScan]).filter(Boolean))];
    if (!requestedRoots.length || scanStarting || ["running", "starting", "cancelling"].includes(scanStatus?.status)) return;
    setScanStarting(true);
    setScanError("");
    setLastRefreshedScanId(null);
    setScanStatus({
      roots: requestedRoots,
      startedAt: new Date().toISOString(),
      rootStatuses: requestedRoots.map((root) => ({ root, status: "starting", scannedCount: 0, uploadedCount: 0, skippedCount: 0, totalEstimate: 0, progressPercent: 0 })),
      currentRoot: requestedRoots[0],
      status: "starting",
      scannedCount: 0,
      uploadedCount: 0,
      skippedCount: 0,
      totalEstimate: 0,
      progressPercent: 0,
      completedRoots: 0,
    });
    try {
      const response = await fetch(`${API}/api/scans/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roots: requestedRoots, addNewRoot: true }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || `Could not start scan (${response.status}).`);
      const actualRoots = Array.isArray(data?.roots) ? data.roots : requestedRoots;
      setScanStatus((previous) => previous ? { ...previous, roots: actualRoots, currentRoot: actualRoots[0], status: "starting" } : previous);
    } catch (err) {
      setScanError(err.message);
      setScanStatus((previous) => previous ? { ...previous, status: "failed" } : previous);
    } finally {
      setScanStarting(false);
    }
  }

  async function cancelScan(rootsToCancel) {
    const targetRoots = Array.isArray(rootsToCancel) ? rootsToCancel : [rootsToCancel].filter(Boolean);
    if (!targetRoots.length) return;
    setScanStatus((previous) => previous ? { ...previous, status: "cancelling" } : previous);
    setScanError("");
    try {
      const response = await fetch(`${API}/api/scans/cancel`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ roots: targetRoots }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || `Could not cancel scan (${response.status}).`);
    } catch (err) {
      setScanError(err.message);
      setScanStatus((previous) => previous ? { ...previous, status: "running" } : previous);
    }
  }

  useEffect(() => {
    // The folder listing and recursive storage map are intentionally lazy.
    // Building the map while Home is visible used to issue dozens of subtree
    // queries against a potentially very large index during application startup.
    if (view !== "storage" || !currentPath) return undefined;
    let cancelled = false;
    const controller = new AbortController();
    const maxConcurrentFolderRequests = 4;
    let activeFolderRequests = 0;
    const folderRequestQueue = [];

    async function getChildren(pathValue) {
      if (activeFolderRequests >= maxConcurrentFolderRequests) {
        await new Promise((resolve) => folderRequestQueue.push(resolve));
      }
      if (cancelled) return [];
      activeFolderRequests += 1;
      try {
        const response = await fetch(`${API}/api/folders?path=${encodeURIComponent(pathValue)}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        return Array.isArray(data) ? data : [];
      } finally {
        activeFolderRequests -= 1;
        folderRequestQueue.shift()?.();
      }
    }

    async function buildNode(item, depth, totalRootSize) {
      if (item.type !== "directory" || depth >= 3 || !item.path) return { ...item, children: [] };
      const children = await getChildren(item.path);
      const { visible, otherSize } = groupSmallItems(children, totalRootSize, 0.01, 5);
      const childNodes = await Promise.all(visible.map((child) => buildNode(child, depth + 1, totalRootSize)));
      if (otherSize > 0 && totalRootSize > 0 && otherSize / totalRootSize >= 0.01) {
        childNodes.push({ name: "Other", type: "other", size: otherSize, path: null, children: [] });
      }
      return { ...item, children: childNodes };
    }

    async function loadStorageView() {
      setSunburstLoading(true);
      setError("");
      try {
        const children = await getChildren(currentPath);
        if (!cancelled) setFolderItems(children);

        const total = children.reduce((sum, child) => sum + Number(child.size || 0), 0);
        const { visible, otherSize } = groupSmallItems(children, total, 0.01, 5);
        const childNodes = await Promise.all(visible.map((child) => buildNode(child, 1, total)));
        if (otherSize > 0 && total > 0 && otherSize / total >= 0.01) {
          childNodes.push({ name: "Other", type: "other", size: otherSize, path: null, children: [] });
        }
        if (!cancelled) {
          setSunburstData({ name: currentPath, path: currentPath, type: "directory", size: total, children: childNodes });
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setSunburstLoading(false);
      }
    }

    loadStorageView();
    return () => {
      cancelled = true;
      controller.abort();
      // Wake queued requests so they can observe cancellation and exit.
      while (folderRequestQueue.length) folderRequestQueue.shift()?.();
    };
  }, [view, currentPath, refreshTick]);

  async function openContainingFolder() {
    if (!selectedItem) return;
    try {
      const response = await fetch(`${API}/api/items/${selectedItem.id}/open-folder`, { method: "POST" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (err) { setError(err.message); }
  }

  async function openInExplorer(item = selectedItem) {
    if (!item) return;
    try {
      const response = await fetch(`${API}/api/items/${item.id}/open`, { method: "POST" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (err) { setError(err.message); }
  }

  async function openDetails(item) {
    if (!item?.id) { setError("This item does not have an ID yet."); return; }
    setDetailsLoading(true);
    setSelectedItem(null);
    try {
      const response = await fetch(`${API}/api/items/${item.id}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setSelectedItem(await response.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setDetailsLoading(false);
    }
  }

  function navigateTo(nextPath, addHistory = true) {
    if (!nextPath || nextPath === currentPath) return;
    if (addHistory && currentPath) {
      setBackStack((prev) => [...prev, currentPath]);
      setForwardStack([]);
    }
    setCurrentPath(nextPath);
  }

  function openFolder(item) {
    if (item?.type !== "directory") return;
    navigateTo(item.path);
    setView("storage");
  }

  function handleSunburstOpen(item) {
    if (item?.type === "directory") openFolder(item);
    else if (item?.type === "file") openDetails(item);
  }

  function openDeleteDialog(item) {
    if (!item || !["file", "directory"].includes(item.type)) return;
    setDeleteItems([item]);
  }

  async function handleDeleteComplete(successfulIds) {
    const deleted = new Set(successfulIds);
    setDeleteItems(null);
    if (selectedItem && deleted.has(selectedItem.id)) setSelectedItem(null);
    setFolderItems((prev) => prev.filter((item) => !deleted.has(item.id)));
    setRefreshTick((value) => value + 1);
  }

  function browseFolder(item) {
    if (item.type !== "directory") return;
    navigateTo(item.path);
    setSelectedItem(null);
    setView("storage");
  }

  function goBack() {
    if (!backStack.length) return;
    const previous = backStack[backStack.length - 1];
    setBackStack((prev) => prev.slice(0, -1));
    setForwardStack((prev) => [...prev, currentPath]);
    setCurrentPath(previous);
  }

  function goForward() {
    if (!forwardStack.length) return;
    const next = forwardStack[forwardStack.length - 1];
    setForwardStack((prev) => prev.slice(0, -1));
    setBackStack((prev) => [...prev, currentPath]);
    setCurrentPath(next);
  }

  function goRoot(root) {
    if (!root) return;
    setBackStack([]);
    setForwardStack([]);
    setCurrentPath(root);
    setView("storage");
  }

  function getBreadcrumbs() {
    if (!currentPath) return [];
    const windowsPath = /^[A-Za-z]:[\\/]/.test(currentPath);
    const separator = windowsPath ? "\\" : "/";
    const parts = currentPath.split(/[\\/]+/).filter(Boolean);
    const breadcrumbs = [];
    let accumulated = windowsPath ? `${parts.shift()}\\` : currentPath.startsWith("/") ? "/" : "";
    if (windowsPath) breadcrumbs.push({ name: accumulated.slice(0, 2), path: accumulated });
    else if (currentPath.startsWith("/")) breadcrumbs.push({ name: "/", path: "/" });
    for (const part of parts) {
      accumulated = accumulated === "/" || accumulated.endsWith("\\") || accumulated === ""
        ? `${accumulated}${part}`
        : `${accumulated}${separator}${part}`;
      breadcrumbs.push({ name: part, path: accumulated });
    }
    return breadcrumbs;
  }

  const breadcrumbs = getBreadcrumbs();

  return (
    <div className="dl-app-shell">
      <Sidebar active={view} onNavigate={(next) => {
        setError("");
        if (next === "storage" && !currentPath && roots.length) setCurrentPath(roots[0].root);
        setView(next);
      }} />

      <main className="dl-main">
        {error && view !== "storage" && <div className="dl-alert">{error}</div>}

        {view === "home" && (
          <HomeDashboard
            drives={drives}
            roots={roots}
            largestItems={largestItems}
            onOpenRoot={(root) => goRoot(root)}
            onOpenItem={openDetails}
            onOpenPrograms={() => setView("programs")}
            onOpenAI={() => setView("ai")}
            scanStatus={scanStatus}
            scanStarting={scanStarting}
            scanError={scanError}
            onScanNow={startScan}
            onAddScanLocation={pickScanLocation}
            onCancelScan={cancelScan}
            onViewAllStorage={() => {
              if (roots.length) {
                setCurrentPath(roots[0].root);
                setBackStack([]);
                setForwardStack([]);
              }
              setView("storage");
            }}
          />
        )}

        {view === "storage" && (
          <StorageExplorerView
            roots={roots}
            currentPath={currentPath}
            folderItems={folderItems}
            breadcrumbs={breadcrumbs}
            backStack={backStack}
            forwardStack={forwardStack}
            totalSize={totalSize}
            loading={loading}
            error={error}
            sunburstData={sunburstData}
            sunburstLoading={sunburstLoading}
            onBack={goBack}
            onForward={goForward}
            onNavigate={navigateTo}
            onRoot={goRoot}
            onSunburstOpen={handleSunburstOpen}
            onOpenDetails={openDetails}
            onOpenFolder={openFolder}
          />
        )}

        {view === "programs" && (
          <div className="dl-feature-page">
            <div className="dl-cleanup-tabs" role="tablist" aria-label="Cleanup tools">
              <button type="button" role="tab" aria-selected={cleanupMode === "programs"} className={cleanupMode === "programs" ? "active" : ""} onClick={() => setCleanupMode("programs")}>Installed programs</button>
              <button type="button" role="tab" aria-selected={cleanupMode === "files"} className={cleanupMode === "files" ? "active" : ""} onClick={() => setCleanupMode("files")}>File cleanup &amp; duplicates</button>
            </div>
            {cleanupMode === "programs" ? <ProgramCleanupPanel
              embedded onClose={() => setView("home")}
              onReviewDelete={(items) => setDeleteItems(items)}
            /> : <CleanupRecommendationsPanel
              refreshTick={refreshTick}
              onReviewDelete={(items) => setDeleteItems(items)}
            />}
          </div>
        )}

        {view === "ai" && (
          <div className="dl-feature-page">
            <AiStoragePanel embedded onClose={() => setView("home")} />
          </div>
        )}

        {view === "settings" && (
          <div className="dl-feature-page dl-settings-page">
            <div className="dl-page-head"><div><div className="dl-eyebrow">PREFERENCES</div><h1>Settings</h1><p>Manage optional AI access and local cost controls.</p></div></div>
            <AISettingsPanel />
            <UpdateCheckPanel />
          </div>
        )}
      </main>

      {deleteItems && (
        <DeleteDialog
          items={deleteItems}
          onClose={() => setDeleteItems(null)}
          onComplete={handleDeleteComplete}
        />
      )}

      {(selectedItem || detailsLoading) && (
        <div className="dl-drawer-backdrop" onClick={() => setSelectedItem(null)}>
          <aside className="dl-detail-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="dl-drawer-head">
              <div>
                <div className="dl-eyebrow">DETAILS</div>
                <h2>{selectedItem?.type === "directory" ? "Folder details" : "File details"}</h2>
              </div>
              <button className="dl-icon-btn" onClick={() => setSelectedItem(null)}><span aria-hidden>×</span></button>
            </div>

            {detailsLoading ? (
              <div className="dl-loading">Loading details...</div>
            ) : selectedItem ? (
              <>
                <div className="dl-detail-title">
                  <div className={`dl-item-icon large ${selectedItem.type === "directory" ? "folder" : "file"}`}>
                    <Icon name={selectedItem.type === "directory" ? "folder" : "file"} size={20} />
                  </div>
                  <div><h3>{selectedItem.name}</h3><p>{selectedItem.path}</p></div>
                </div>

                <div className="dl-detail-actions">
                  <button className="dl-primary-btn" onClick={() => openInExplorer()}>{selectedItem.type === "directory" ? "Open folder" : "Open file"}</button>
                  {selectedItem.type === "directory" ? (
                    <>
                      <button className="dl-secondary-btn" onClick={() => browseFolder(selectedItem)}>Browse</button>
                      <button className="dl-danger-btn" onClick={() => openDeleteDialog(selectedItem)}>Delete</button>
                    </>
                  ) : (
                    <>
                      <button className="dl-secondary-btn" onClick={openContainingFolder}>Containing folder</button>
                      <button className="dl-danger-btn" onClick={() => openDeleteDialog(selectedItem)}>Delete</button>
                    </>
                  )}
                </div>

                <div className="dl-detail-grid">
                  <Detail label="Type" value={selectedItem.type === "directory" ? "Folder" : "File"} />
                  <Detail label="Size" value={formatBytes(selectedItem.size)} />
                  {selectedItem.type === "directory" && <>
                    <Detail label="Files" value={String(selectedItem.fileCount || 0)} />
                    <Detail label="Folders" value={String(selectedItem.folderCount || 0)} />
                  </>}
                  <Detail label="Created" value={formatDate(selectedItem.createdAt)} />
                  <Detail label="Modified" value={formatDate(selectedItem.modifiedAt)} />
                  <Detail label="Root" value={selectedItem.root} />
                  <Detail label="Full path" value={selectedItem.path} />
                </div>
              </>
            ) : null}
          </aside>
        </div>
      )}
    </div>
  );
}
