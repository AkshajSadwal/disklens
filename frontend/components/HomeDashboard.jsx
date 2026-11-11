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
  const [selectedScanRoot, setSelectedScanRoot] = useState(roots?.[0]?.root || "");

  useEffect(() => {
    if (!roots?.length) { setSelectedScanRoot(""); return; }
    if (!roots.some((root) => root.root === selectedScanRoot)) setSelectedScanRoot(roots[0].root);
  }, [roots, selectedScanRoot]);

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
    let cancelled = false;
    async function loadPrograms() {
      setProgramsLoading(true);
      try {
        const response = await fetch(`${API}/api/programs`);
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
        if (!cancelled) setPrograms(Array.isArray(data?.programs) ? data.programs : []);
      } catch {
        if (!cancelled) setPrograms([]);
      } finally {
        if (!cancelled) setProgramsLoading(false);
      }
    }
    loadPrograms();
    return () => { cancelled = true; };
  }, [roots]);

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
            onClick={() => onOpenRoot(roots?.[0]?.root)}
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
                <p>Actual capacity reported by your system.</p>
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
                <label htmlFor="dl-scan-root">Location to scan</label>
                <button type="button" className="dl-home-add-location" onClick={async () => {
                  const root = await onAddScanLocation?.();
                  if (root) setSelectedScanRoot(root);
                }} disabled={scanStarting || scanStatus?.status === "running" || scanStatus?.status === "starting"}>
                  <Icon name="folder-plus" size={14} /> Add folder
                </button>
              </div>
              <select id="dl-scan-root" value={selectedScanRoot} onChange={(event) => setSelectedScanRoot(event.target.value)} disabled={!roots?.length || scanStarting || scanStatus?.status === "running" || scanStatus?.status === "starting"}>
                {(roots || []).length ? (roots || []).map((root) => <option key={root.root} value={root.root}>{root.root}</option>) : <option value="">No locations indexed yet</option>}
              </select>
              <button type="button" onClick={() => onScanNow?.(selectedScanRoot)} disabled={!selectedScanRoot || scanStarting || scanStatus?.status === "running" || scanStatus?.status === "starting"}>
                <span><Icon name="scan" size={17} /></span>
                <strong>{scanStarting || scanStatus?.status === "starting" ? "Starting…" : "Scan Now"}</strong>
                <Icon name="chevronRight" size={15} />
              </button>
              {(scanStatus?.status === "running" || scanStatus?.status === "starting") && scanStatus.root === selectedScanRoot && (
                <div className="dl-home-scan-progress" aria-live="polite">
                  <div className="dl-home-scan-status">{scanStatus.status === "starting" ? "Starting scan…" : `Scanning ${scanStatus.root}`}</div>
                  {Number(scanStatus.totalEstimate) > 0 ? (
                    <>
                      <div className="dl-home-scan-track"><span style={{ width: `${Math.min(100, (Number(scanStatus.scannedCount || 0) / Number(scanStatus.totalEstimate)) * 100)}%` }} /></div>
                      <div className="dl-home-scan-meta">{Number(scanStatus.scannedCount || 0).toLocaleString()} / {Number(scanStatus.totalEstimate).toLocaleString()} items · {Number(scanStatus.uploadedCount || 0).toLocaleString()} uploaded</div>
                    </>
                  ) : <div className="dl-home-scan-meta">Estimating the number of items…</div>}
                  <button type="button" className="dl-home-scan-cancel" onClick={() => onCancelScan?.(selectedScanRoot)}>Cancel scan</button>
                </div>
              )}
              {scanStatus?.root === selectedScanRoot && ["completed", "aborted", "interrupted", "failed"].includes(scanStatus.status) && (
                <div className={`dl-home-scan-result ${scanStatus.status === "completed" ? "is-complete" : "is-warning"}`}>
                  {scanStatus.status === "completed" ? `Scan complete · ${Number(scanStatus.itemCount || scanStatus.scannedCount || 0).toLocaleString()} indexed` : scanStatus.status === "aborted" ? "Scan cancelled. Previous index was kept." : scanStatus.status === "failed" ? "Scan could not be started." : "Scan was interrupted. Previous index was kept."}
                </div>
              )}
              {scanError && <div className="dl-home-scan-error">{scanError}</div>}
            </div>
            <button onClick={() => onOpenRoot(selectedScanRoot)} disabled={!selectedScanRoot}>
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
        </aside>

      </div>
    </div>
  );
}
