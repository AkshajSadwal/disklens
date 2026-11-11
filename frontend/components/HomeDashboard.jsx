import { useEffect, useState } from "react";
import { API } from "../lib/api";
import Icon from "./common/Icon";
import { formatBytes } from "../lib/formatters";

function DriveCard({ drive, indexed, onOpen }) {
  const hasActual =
    Number.isFinite(Number(drive?.totalBytes)) && Number(drive.totalBytes) > 0;
  const total = hasActual ? Number(drive.totalBytes) : 0;
  const used = hasActual ? Number(drive.usedBytes || 0) : 0;
  const free = hasActual ? Number(drive.freeBytes || 0) : 0;
  const percent =
    total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0;

  return (
    <button
      className="dl-home-drive"
      onClick={() => onOpen(indexed?.root || drive?.root)}
    >
      <div className="dl-home-drive-top">
        <div className="dl-home-drive-icon">
          <Icon name="drive" size={19} />
        </div>
        <div className="dl-home-drive-name">
          <strong>{indexed?.root || drive?.root}</strong>
          <span>{drive?.volumeName || "Local Disk"}</span>
        </div>
        <span className="dl-home-drive-fs">{drive?.fileSystem || "—"}</span>
      </div>

      <div className="dl-home-progress">
        <div style={{ width: `${percent}%` }} />
      </div>

      {hasActual ? (
        <>
          <div className="dl-home-drive-stats">
            <span>
              {formatBytes(used)} / {formatBytes(total)}
            </span>
            <strong>{percent.toFixed(0)}%</strong>
          </div>
          <div className="dl-home-drive-free">{formatBytes(free)} free</div>
        </>
      ) : (
        <div className="dl-home-drive-unavailable">Capacity unavailable</div>
      )}
    </button>
  );
}

function StorageRing({ used, total }) {
  const percent =
    total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0;
  return (
    <div
      className="dl-home-storage-ring"
      style={{
        background: `conic-gradient(#2f73ed 0 ${percent}%, #d9e0e8 ${percent}% 100%)`,
      }}
    >
      <div>
        <strong>{formatBytes(total)}</strong>
        <span>Total</span>
      </div>
    </div>
  );
}

export default function HomeDashboard({
  drives,
  roots,
  largestItems,
  onOpenRoot,
  onOpenItem,
  onOpenPrograms,
  onOpenAI,
  onViewAllStorage,
  scanStatus,
  scanStarting,
  scanError,
  onScanNow,
  onAddScanLocation,
  onCancelScan,
}) {
  const [largestFilter, setLargestFilter] = useState("all");
  const [largestFolders, setLargestFolders] = useState([]);
  const [foldersLoading, setFoldersLoading] = useState(false);
  const [programs, setPrograms] = useState([]);
  const [programsLoading, setProgramsLoading] = useState(false);
  const [scanHistory, setScanHistory] = useState([]);
  const [scanHistoryError, setScanHistoryError] = useState("");
  const [selectedScanRoots, setSelectedScanRoots] = useState(() =>
    roots?.[0]?.root ? [roots[0].root] : [],
  );

  useEffect(() => {
    const available = new Set((roots || []).map((root) => root.root));
    setSelectedScanRoots((current) => {
      const retained = current.filter((root) => available.has(root));
      if (retained.length) return retained;
      return roots?.[0]?.root ? [roots[0].root] : [];
    });
  }, [roots]);

  const scanIsActive = ["starting", "running", "cancelling"].includes(scanStatus?.status);
  const scanProgressPercent = Math.max(0, Math.min(100, Number(scanStatus?.progressPercent) || 0));
  const elapsedSeconds = scanIsActive && scanStatus?.startedAt
    ? Math.max(0, Math.floor((Date.now() - Date.parse(scanStatus.startedAt)) / 1000))
    : 0;
  const remainingItems = Number(scanStatus?.currentTotalEstimate || 0) - Number(scanStatus?.currentScannedCount || 0);
  const etaSeconds = remainingItems > 0 && Number(scanStatus?.currentScannedCount || 0) > 0
    ? Math.ceil(elapsedSeconds * remainingItems / Number(scanStatus.currentScannedCount))
    : null;
  const formatDuration = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return mins ? `${mins}m ${secs}s` : `${secs}s`;
  };

  function toggleScanRoot(root) {
    setSelectedScanRoots((current) => current.includes(root)
      ? current.filter((value) => value !== root)
      : [...current, root]);
  }

  const driveMap = new Map(
    (drives || []).map((item) => [
      String(item.root || "")
        .replace(/[\\/]+$/, "")
        .toUpperCase(),
      item,
    ]),
  );

  useEffect(() => {
    let cancelled = false;

    async function loadLargestFolders() {
      if (!roots?.length) {
        setLargestFolders([]);
        return;
      }

      setFoldersLoading(true);

      try {
        const responses = await Promise.all(
          roots.map(async (root) => {
            const response = await fetch(
              `${API}/api/folders?path=${encodeURIComponent(root.root)}`,
            );

            if (!response.ok) {
              throw new Error(`HTTP ${response.status}`);
            }

            return response.json();
          }),
        );

        if (!cancelled) {
          const folders = responses
            .flat()
            .filter(
              (item) =>
                item?.type === "directory" &&
                item?.id &&
                Number(item?.size) > 0,
            )
            .sort((a, b) => Number(b.size || 0) - Number(a.size || 0));

          setLargestFolders(folders);
        }
      } catch {
        if (!cancelled) {
          setLargestFolders([]);
        }
      } finally {
        if (!cancelled) {
          setFoldersLoading(false);
        }
      }
    }

    loadLargestFolders();

    return () => {
      cancelled = true;
    };
  }, [roots]);
  useEffect(() => {
    // Installed-program discovery is relatively expensive on Windows. Keep
    // the Home overview responsive and fetch this list only when its tab is
    // actually opened.
    if (largestFilter !== "programs") return undefined;

    const controller = new AbortController();
    async function loadPrograms() {
      setProgramsLoading(true);
      try {
        const response = await fetch(`${API}/api/programs`, { signal: controller.signal });
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
        setPrograms(Array.isArray(data?.programs) ? data.programs : []);
      } catch (error) {
        if (error.name !== "AbortError") setPrograms([]);
      } finally {
        if (!controller.signal.aborted) setProgramsLoading(false);
      }
    }
    loadPrograms();
    return () => controller.abort();
  }, [roots, largestFilter]);

  const normalizeRoot = (root) =>
    String(root || "")
      .replace(/[\\/]+$/, "")
      .toUpperCase();
  const validDrives = (drives || []).filter(
    (drive) => Number(drive.totalBytes) > 0,
  );

  const total = validDrives.reduce(
    (sum, drive) => sum + Number(drive.totalBytes || 0),
    0,
  );
  const used = validDrives.reduce(
    (sum, drive) => sum + Number(drive.usedBytes || 0),
    0,
  );
  const free = validDrives.reduce(
    (sum, drive) => sum + Number(drive.freeBytes || 0),
    0,
  );
  const hasDriveMetadata = validDrives.length > 0;

  useEffect(() => {
    const controller = new AbortController();
    async function loadScanHistory() {
      try {
        const response = await fetch(`${API}/api/scans/history?limit=8`, { signal: controller.signal });
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
        setScanHistory(data?.runs || []);
        setScanHistoryError("");
      } catch (error) {
        if (error.name !== "AbortError") setScanHistoryError(error.message);
      }
    }
    loadScanHistory();
    return () => controller.abort();
  }, [scanStatus?.status, scanStatus?.completedAt]);

  // Prefer indexed install-location bytes; otherwise use the OS/package estimate.
  // Unknown sizes sort last, rather than inheriting discovery order.
  const getProgramSize = (program) => Number(program.size) > 0
    ? Number(program.size)
    : (Number(program.estimatedSizeKB) || 0) * 1024;
  const programsBySize = [...programs].sort((a, b) => {
    const sizeDiff = getProgramSize(b) - getProgramSize(a);
    return sizeDiff || String(a.name || "").localeCompare(String(b.name || ""));
  });

  const fileItems = (largestItems || []).filter((item) => item.type === "file");
  const folderItems =
    largestFolders.length > 0
      ? largestFolders
      : (largestItems || []).filter((item) => item.type === "directory");
  const filteredLargest =
    largestFilter === "files"
      ? fileItems
      : largestFilter === "folders"
        ? folderItems
        : largestFilter === "programs"
          ? []
          : largestItems || [];

  return (
    <div className="dl-home">
      <div className="dl-home-head">
        <div>
          <div className="dl-eyebrow">OVERVIEW</div>
          <h1>Home</h1>
          <p>A simple view of your storage.</p>
        </div>

        <div className="dl-home-scan-wrap">
          <button
            className="dl-home-scan"
            onClick={() => onScanNow?.(selectedScanRoots)}
            disabled={!selectedScanRoots.length || scanStarting || scanIsActive}
          >
            <Icon name="scan" size={18} />
            Scan Now
          </button>
          <div className="dl-home-last-scan">
            <span className="dl-home-live-dot" />
            <div>
              <strong>Storage index</strong>
              <span>
                {roots?.length || 0} drive{roots?.length === 1 ? "" : "s"}{" "}
                indexed
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="dl-home-top-grid">
        <div className="dl-home-main-column">
          <section className="dl-home-stat-grid">
            <div className="dl-home-stat-card blue">
              <div className="dl-home-stat-icon">
                <Icon name="storage" size={21} />
              </div>
              <div>
                <span>Total Storage</span>
                <strong>{hasDriveMetadata ? formatBytes(total) : "—"}</strong>
                <small>
                  {hasDriveMetadata
                    ? "All indexed drives"
                    : "Drive capacity not available"}
                </small>
              </div>
            </div>

            <div className="dl-home-stat-card red">
              <div className="dl-home-stat-icon">
                <div
                  className="dl-home-mini-ring used"
                  style={{
                    background: `conic-gradient(#e64c63 0 ${total ? (used / total) * 100 : 0}%, #f7dce2 0 100%)`,
                  }}
                />
              </div>
              <div>
                <span>Used</span>
                <strong>{hasDriveMetadata ? formatBytes(used) : "—"}</strong>
                <small>
                  {hasDriveMetadata && total
                    ? `${((used / total) * 100).toFixed(0)}% of total`
                    : "Waiting for drive data"}
                </small>
              </div>
            </div>

            <div className="dl-home-stat-card neutral">
              <div className="dl-home-stat-icon">
                <div
                  className="dl-home-mini-ring free"
                  style={{
                    background: `conic-gradient(#98a3b2 0 ${total ? (free / total) * 100 : 0}%, #e8edf2 0 100%)`,
                  }}
                />
              </div>
              <div>
                <span>Free</span>
                <strong>{hasDriveMetadata ? formatBytes(free) : "—"}</strong>
                <small>
                  {hasDriveMetadata && total
                    ? `${((free / total) * 100).toFixed(0)}% available`
                    : "Waiting for drive data"}
                </small>
              </div>
            </div>
          </section>

          <section className="dl-home-panel">
            <div className="dl-home-panel-head">
              <div>
                <h2>Drives</h2>
                <p>Drive used/free is reported by your system. Indexed bytes are the sum of file metadata DiskLens could read; exclusions, permissions, and filesystem overhead make these totals differ.</p>
              </div>
              <button
                className="dl-home-link"
                onClick={() => onOpenRoot(roots?.[0]?.root)}
              >
                View All Drives <Icon name="chevronRight" size={15} />
              </button>
            </div>

            <div className="dl-home-drive-grid">
              {(roots || []).map((root) => (
                <DriveCard
                  key={root.root}
                  drive={driveMap.get(normalizeRoot(root.root))}
                  indexed={root}
                  onOpen={onOpenRoot}
                />
              ))}
            </div>
          </section>

          <section className="dl-home-panel dl-home-largest">
            <div className="dl-home-panel-head">
              <div>
                <h2>Largest Items</h2>
                <p>The biggest files and folders in your index.</p>
              </div>
              <button
                className="dl-home-link"
                onClick={onViewAllStorage}
              >
                View All <Icon name="chevronRight" size={15} />
              </button>
            </div>

            <div className="dl-home-tabs" role="tablist">
              {[
                ["all", "All"],
                ["files", "Files"],
                ["folders", "Folders"],
                ["programs", "Programs"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  className={largestFilter === value ? "is-active" : ""}
                  type="button"
                  onClick={() => {
                    setLargestFilter(value);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            {largestFilter === "programs" ? (
              <div className="dl-home-program-list">
                <div className="dl-home-program-row is-heading">
                  <span>#</span><span>Program</span><span>Publisher</span><span>Size</span><span>Version</span>
                </div>
                {programsLoading ? (
                  <div className="dl-home-empty">Loading installed programs…</div>
                ) : programs.length ? (
                  programsBySize.slice(0, 5).map((program, index) => (
                    <div className="dl-home-program-row" key={`${program.name}|${program.version || ""}|${index}`}>
                      <span className="dl-home-rank">{index + 1}</span>
                      <span className="dl-home-program-name">{program.name || "Unnamed program"}</span>
                      <span className="dl-home-program-publisher">{program.publisher || "Unknown publisher"}</span>
                      <span className="dl-home-program-size" title={program.sizeBasis === "indexed-install-location-size" ? "Calculated from indexed files under the install location" : "Estimated size reported by the operating system"}>{getProgramSize(program) > 0 ? formatBytes(getProgramSize(program)) : "—"}</span>
                      <span className="dl-home-program-version">{program.version || "—"}</span>
                    </div>
                  ))
                ) : (
                  <div className="dl-home-empty">No installed programs found.</div>
                )}
              </div>
            ) : (
            <div className="dl-home-table">
              <div className="dl-home-table-head">
                <span>#</span>
                <span>Name</span>
                <span>Path</span>
                <span>Size</span>
                <span>Type</span>
                <span />
              </div>
              {filteredLargest.slice(0, 5).map((item, index) => (
                <button
                  className="dl-home-table-row"
                  key={item.id || item.path}
                  onClick={() => onOpenItem(item)}
                >
                  <span className="dl-home-rank">{index + 1}</span>
                  <span className="dl-home-item-name">
                    <span
                      className={`dl-home-type-icon ${item.type === "directory" ? "folder" : "file"}`}
                    >
                      <Icon
                        name={item.type === "directory" ? "folder" : "file"}
                        size={16}
                      />
                    </span>
                    <strong>{item.name}</strong>
                  </span>
                  <span className="dl-home-item-path">{item.path}</span>
                  <span className="dl-home-item-size">
                    {formatBytes(item.size)}
                  </span>
                  <span
                    className={`dl-home-type-badge ${item.type === "directory" ? "folder" : "file"}`}
                  >
                    {item.type === "directory" ? "Folder" : "File"}
                  </span>
                  <Icon name="more" size={15} />
                </button>
              ))}
              {!filteredLargest.length &&
                (largestFilter === "folders" && foldersLoading ? (
                  <div className="dl-home-empty">Loading indexed folders…</div>
                ) : (
                  <div className="dl-home-empty">
                    No indexed items in this category.
                  </div>
                ))}
            </div>
            )}
          </section>
        </div>

        <aside className="dl-home-side-column">
          <section className="dl-home-panel dl-home-quick">
            <div className="dl-home-panel-head">
              <div>
                <h2>Quick Actions</h2>
              </div>
            </div>
            <div className="dl-home-scan-picker">
              <div className="dl-home-scan-label-row">
                <label>Locations to scan</label>
                <button type="button" className="dl-home-add-location" onClick={async () => {
                  const root = await onAddScanLocation?.();
                  if (root) setSelectedScanRoots((current) => current.includes(root) ? current : [...current, root]);
                }} disabled={scanStarting || scanIsActive}>
                  <Icon name="folder-plus" size={15} /> Add folder
                </button>
              </div>
              <div className="dl-home-scan-selection-tools">
                <span>{selectedScanRoots.length} of {(roots || []).length} selected</span>
                <div>
                  <button type="button" onClick={() => setSelectedScanRoots((roots || []).map((item) => item.root))} disabled={scanIsActive || scanStarting || !roots?.length}>Select all</button>
                  <button type="button" onClick={() => setSelectedScanRoots([])} disabled={scanIsActive || scanStarting || !selectedScanRoots.length}>Clear</button>
                </div>
              </div>
              <div className="dl-home-scan-root-list" role="group" aria-label="Choose one or more scan locations">
                {(roots || []).length ? (roots || []).map((root) => (
                  <label className={`dl-home-scan-root-option ${selectedScanRoots.includes(root.root) ? "is-selected" : ""}`} key={root.root}>
                    <input type="checkbox" checked={selectedScanRoots.includes(root.root)} onChange={() => toggleScanRoot(root.root)} disabled={scanIsActive || scanStarting} />
                    <span>{root.root}</span>
                    <small>{Number(root.itemCount || 0).toLocaleString()} indexed</small>
                  </label>
                )) : <div className="dl-home-scan-no-roots">No locations indexed yet. Use Add folder to choose a location.</div>}
              </div>
              <button type="button" onClick={() => onScanNow?.(selectedScanRoots)} disabled={!selectedScanRoots.length || scanStarting || scanIsActive}>
                <span><Icon name="scan" size={17} /></span>
                <strong>{scanStarting || scanStatus?.status === "starting" ? "Starting…" : scanIsActive ? "Scan running…" : `Scan ${selectedScanRoots.length || "selected"} location${selectedScanRoots.length === 1 ? "" : "s"}`}</strong>
                <Icon name="chevronRight" size={15} />
              </button>
              {scanIsActive && (
                <div className="dl-home-scan-progress" aria-live="polite">
                  <div className="dl-home-scan-progress-heading">
                    <div className="dl-home-scan-status">{scanStatus.status === "cancelling" ? "Stopping scan…" : scanStatus.status === "starting" || scanStatus.isEstimating ? "Preparing scan…" : `Scanning ${scanStatus.currentRoot || "selected locations"}`}</div>
                    <strong>{Math.round(scanProgressPercent)}%</strong>
                  </div>
                  <div className={`dl-home-scan-track ${scanStatus.status === "starting" || scanStatus.isEstimating ? "is-indeterminate" : ""}`} role="progressbar" aria-label="Scan progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(scanProgressPercent)}>
                    <span style={{ width: `${scanProgressPercent}%` }} />
                  </div>
                  <div className="dl-home-scan-meta">
                    {Number(scanStatus.currentScannedCount || 0).toLocaleString()} / {Number(scanStatus.currentTotalEstimate || 0).toLocaleString()} items in this location · {Number(scanStatus.uploadedCount || 0).toLocaleString()} uploaded · {Number(scanStatus.completedRoots || 0)} of {Number(scanStatus.roots?.length || selectedScanRoots.length || 1)} locations complete · elapsed {formatDuration(elapsedSeconds)}{etaSeconds !== null ? ` · about ${formatDuration(etaSeconds)} left` : ""}
                  </div>
                  {scanStatus.rootStatuses?.length > 1 && <div className="dl-home-scan-root-progress">
                    {scanStatus.rootStatuses.map((entry) => <div key={entry.root}><span>{entry.root}</span><strong>{entry.status === "completed" ? "Done" : entry.status === "running" ? `${Math.round(entry.progressPercent || 0)}%` : entry.status === "cancelling" ? "Stopping" : entry.status === "aborted" ? "Cancelled" : "Queued"}</strong></div>)}
                  </div>}
                  <button type="button" className="dl-home-scan-cancel" onClick={() => onCancelScan?.(scanStatus.roots || selectedScanRoots)} disabled={scanStatus.status === "cancelling"}>{scanStatus.status === "cancelling" ? "Stopping…" : "Cancel scan"}</button>
                </div>
              )}
              {scanStatus && ["completed", "aborted", "interrupted", "failed"].includes(scanStatus.status) && (
                <div className={`dl-home-scan-result ${scanStatus.status === "completed" ? "is-complete" : "is-warning"}`}>
                  {scanStatus.status === "completed" ? `Scan complete · ${Number(scanStatus.scannedCount || 0).toLocaleString()} items indexed across ${scanStatus.roots?.length || 1} location${scanStatus.roots?.length === 1 ? "" : "s"}.` : scanStatus.status === "aborted" ? "Scan cancelled. The previous completed index was kept." : scanStatus.status === "failed" ? "Scan could not be started." : "Scan was interrupted. The previous completed index was kept."}
                </div>
              )}
              {scanError && <div className="dl-home-scan-error">{scanError}</div>}
            </div>
            <button onClick={() => onOpenRoot(selectedScanRoots[0] || roots?.[0]?.root)} disabled={!selectedScanRoots.length && !roots?.length}>
              <span><Icon name="folder" size={17} /></span>
              <strong>Browse Storage</strong>
              <Icon name="chevronRight" size={15} />
            </button>
            <button onClick={onOpenAI}>
              <span>
                <Icon name="sparkles" size={17} />
              </span>
              <strong>AI Storage Advisor</strong>
              <Icon name="chevronRight" size={15} />
            </button>
            <button onClick={onOpenPrograms}>
              <span>
                <Icon name="programs" size={17} />
              </span>
              <strong>Programs & Cleanup</strong>
              <Icon name="chevronRight" size={15} />
            </button>
          </section>

          <section className="dl-home-panel dl-home-breakdown">
            <div className="dl-home-panel-head">
              <div>
                <h2>Storage Breakdown</h2>
              </div>
            </div>
            <div className="dl-home-breakdown-body">
              <StorageRing used={used} total={total} />
              <div className="dl-home-breakdown-legend">
                <div>
                  <span className="legend-dot used" />
                  <div>
                    <strong>Used</strong>
                    <span>
                      {hasDriveMetadata ? formatBytes(used) : "—"}{" "}
                      {hasDriveMetadata && total
                        ? `(${((used / total) * 100).toFixed(0)}%)`
                        : ""}
                    </span>
                  </div>
                </div>
                <div>
                  <span className="legend-dot free" />
                  <div>
                    <strong>Free</strong>
                    <span>
                      {hasDriveMetadata ? formatBytes(free) : "—"}{" "}
                      {hasDriveMetadata && total
                        ? `(${((free / total) * 100).toFixed(0)}%)`
                        : ""}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="dl-home-panel dl-home-scan-history">
            <div className="dl-home-panel-head"><div><h2>Recent scans</h2><p>Saved scan outcomes for the indexed locations.</p></div></div>
            {scanHistoryError ? <div className="dl-home-empty">Scan history is unavailable.</div> : scanHistory.length ? scanHistory.map((run) => (
              <div className="dl-home-scan-history-row" key={run.scanId}>
                <div><strong>{run.root}</strong><small>{run.completedAt ? new Date(run.completedAt).toLocaleString() : new Date(run.startedAt).toLocaleString()}</small></div>
                <span className={`status-${run.status}`}>{run.status}</span>
                <small>{Number(run.itemCount || 0).toLocaleString()} items · {formatBytes(run.indexedBytes || 0)} indexed · +{Number(run.addedCount || 0).toLocaleString()} ~{Number(run.changedCount || 0).toLocaleString()} −{Number(run.removedCount || 0).toLocaleString()} · {Number(run.skippedCount || 0).toLocaleString()} skipped{run.fingerprintMatchesPrevious === true ? " · snapshot matches prior scan" : run.fingerprintMatchesPrevious === false ? " · snapshot differs from prior scan" : ""}</small>
              </div>
            )) : <div className="dl-home-empty">No scans have been recorded yet.</div>}
          </section>
        </aside>

      </div>
    </div>
  );
}
