import { useState } from "react";
import Icon from "./common/Icon";
import { formatBytes } from "../lib/formatters";

function DriveCard({ drive, indexed, onOpen }) {
  const hasActual = Number.isFinite(Number(drive?.totalBytes)) && Number(drive.totalBytes) > 0;
  const total = hasActual ? Number(drive.totalBytes) : 0;
  const used = hasActual ? Number(drive.usedBytes || 0) : 0;
  const free = hasActual ? Number(drive.freeBytes || 0) : 0;
  const percent = total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0;

  return (
    <button className="dl-home-drive" onClick={() => onOpen(indexed?.root || drive?.root)}>
      <div className="dl-home-drive-top">
        <div className="dl-home-drive-icon"><Icon name="drive" size={19} /></div>
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
            <span>{formatBytes(used)} / {formatBytes(total)}</span>
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
  const percent = total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0;
  return (
    <div
      className="dl-home-storage-ring"
      style={{
        background: `conic-gradient(#2f73ed 0 ${percent}%, #35c989 ${percent}% 100%)`,
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
}) {
  const [largestFilter, setLargestFilter] = useState("all");
  const normalizeRoot = (root) =>String(root || "").replace(/[\\/]+$/, "").toUpperCase();
  const driveMap = new Map((drives || []).map((item) => [normalizeRoot(item.root),item,]),);
  const validDrives = (drives || []).filter((drive) => Number(drive.totalBytes) > 0);

  const total = validDrives.reduce((sum, drive) => sum + Number(drive.totalBytes || 0), 0);
  const used = validDrives.reduce((sum, drive) => sum + Number(drive.usedBytes || 0), 0);
  const free = validDrives.reduce((sum, drive) => sum + Number(drive.freeBytes || 0), 0);
  const hasDriveMetadata = validDrives.length > 0;

  const fileItems = (largestItems || []).filter((item) => item.type === "file");
  const folderItems = (largestItems || []).filter((item) => item.type === "directory");
  const biggest = largestItems?.[0];
  const filteredLargest =
    largestFilter === "files"
      ? fileItems
      : largestFilter === "folders"
        ? folderItems
        : largestFilter === "programs"
          ? []
          : (largestItems || []);

  return (
    <div className="dl-home">
      <div className="dl-home-head">
        <div>
          <div className="dl-eyebrow">OVERVIEW</div>
          <h1>Home</h1>
          <p>A simple view of your storage.</p>
        </div>

        <div className="dl-home-scan-wrap">
          <button className="dl-home-scan" onClick={() => onOpenRoot(roots?.[0]?.root)}>
            <Icon name="scan" size={18} />
            Scan Now
          </button>
          <div className="dl-home-last-scan">
            <span className="dl-home-live-dot" />
            <div>
              <strong>Storage index</strong>
              <span>{roots?.length || 0} drive{roots?.length === 1 ? "" : "s"} indexed</span>
            </div>
          </div>
        </div>
      </div>

      <div className="dl-home-top-grid">
        <div className="dl-home-main-column">
          <section className="dl-home-stat-grid">
            <div className="dl-home-stat-card blue">
              <div className="dl-home-stat-icon"><Icon name="storage" size={21} /></div>
              <div>
                <span>Total Storage</span>
                <strong>{hasDriveMetadata ? formatBytes(total) : "—"}</strong>
                <small>{hasDriveMetadata ? "All indexed drives" : "Drive capacity not available"}</small>
              </div>
            </div>

            <div className="dl-home-stat-card red">
              <div className="dl-home-stat-icon"><div className="dl-home-mini-ring used" style={{ background: `conic-gradient(#e64c63 0 ${total ? (used / total) * 100 : 0}%, #f7dce2 0 100%)` }} /></div>
              <div>
                <span>Used</span>
                <strong>{hasDriveMetadata ? formatBytes(used) : "—"}</strong>
                <small>{hasDriveMetadata && total ? `${((used / total) * 100).toFixed(0)}% of total` : "Waiting for drive data"}</small>
              </div>
            </div>

            <div className="dl-home-stat-card green">
              <div className="dl-home-stat-icon"><div className="dl-home-mini-ring free" style={{ background: `conic-gradient(#19ad6b 0 ${total ? (free / total) * 100 : 0}%, #dff2e8 0 100%)` }} /></div>
              <div>
                <span>Free</span>
                <strong>{hasDriveMetadata ? formatBytes(free) : "—"}</strong>
                <small>{hasDriveMetadata && total ? `${((free / total) * 100).toFixed(0)}% available` : "Waiting for drive data"}</small>
              </div>
            </div>
          </section>

          <section className="dl-home-panel">
            <div className="dl-home-panel-head">
              <div>
                <h2>Drives</h2>
                <p>Actual capacity from Windows.</p>
              </div>
              <button className="dl-home-link" onClick={() => onOpenRoot(roots?.[0]?.root)}>
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
              <button className="dl-home-link" onClick={() => onOpenRoot(roots?.[0]?.root)}>
                View All <Icon name="chevronRight" size={15} />
              </button>
            </div>

            <div className="dl-home-tabs" role="tablist">
              {[["all", "All"], ["files", "Files"], ["folders", "Folders"], ["programs", "Programs"]].map(([value, label]) => (
                <button
                  key={value}
                  className={largestFilter === value ? "is-active" : ""}
                  type="button"
                  onClick={() => {
                    setLargestFilter(value);
                    if (value === "programs") onOpenPrograms();
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="dl-home-table">
              <div className="dl-home-table-head">
                <span>#</span><span>Name</span><span>Path</span><span>Size</span><span>Type</span><span />
              </div>
              {filteredLargest.slice(0, 5).map((item, index) => (
                <button className="dl-home-table-row" key={item.id || item.path} onClick={() => onOpenItem(item)}>
                  <span className="dl-home-rank">{index + 1}</span>
                  <span className="dl-home-item-name">
                    <span className={`dl-home-type-icon ${item.type === "directory" ? "folder" : "file"}`}>
                      <Icon name={item.type === "directory" ? "folder" : "file"} size={16} />
                    </span>
                    <strong>{item.name}</strong>
                  </span>
                  <span className="dl-home-item-path">{item.path}</span>
                  <span className="dl-home-item-size">{formatBytes(item.size)}</span>
                  <span className={`dl-home-type-badge ${item.type === "directory" ? "folder" : "file"}`}>
                    {item.type === "directory" ? "Folder" : "File"}
                  </span>
                  <Icon name="more" size={15} />
                </button>
              ))}
              {!filteredLargest.length && (largestFilter === "programs" ? (
                <div className="dl-home-empty">Open Programs & Cleanup to review installed programs.</div>
              ) : (
                <div className="dl-home-empty">No indexed items in this category.</div>
              ))}
            </div>
          </section>

        </div>

        <aside className="dl-home-side-column">
          <section className="dl-home-quote">
            <span>“</span>
            <p>A cleaner drive leads to a clearer mind.</p>
            <div className="dl-home-quote-art" aria-hidden="true">
              <i /><b /><em /><strong />
            </div>
          </section>

          <section className="dl-home-panel dl-home-quick">
            <div className="dl-home-panel-head"><div><h2>Quick Actions</h2></div></div>
            <button onClick={() => onOpenRoot(roots?.[0]?.root)}><span><Icon name="scan" size={17} /></span><strong>Scan Now</strong><Icon name="chevronRight" size={15} /></button>
            <button onClick={onOpenAI}><span><Icon name="sparkles" size={17} /></span><strong>AI Storage Advisor</strong><Icon name="chevronRight" size={15} /></button>
            <button onClick={onOpenPrograms}><span><Icon name="programs" size={17} /></span><strong>Programs & Cleanup</strong><Icon name="chevronRight" size={15} /></button>
            <button onClick={() => biggest && onOpenItem(biggest)}><span><Icon name="shield" size={17} /></span><strong>File Safety</strong><Icon name="chevronRight" size={15} /></button>
          </section>

          <section className="dl-home-panel dl-home-breakdown">
            <div className="dl-home-panel-head"><div><h2>Storage Breakdown</h2></div></div>
            <div className="dl-home-breakdown-body">
              <StorageRing used={used} total={total} />
              <div className="dl-home-breakdown-legend">
                <div><span className="legend-dot used" /><div><strong>Used</strong><span>{hasDriveMetadata ? formatBytes(used) : "—"} {hasDriveMetadata && total ? `(${((used / total) * 100).toFixed(0)}%)` : ""}</span></div></div>
                <div><span className="legend-dot free" /><div><strong>Free</strong><span>{hasDriveMetadata ? formatBytes(free) : "—"} {hasDriveMetadata && total ? `(${((free / total) * 100).toFixed(0)}%)` : ""}</span></div></div>
              </div>
            </div>
          </section>
        </aside>

        <div className="dl-home-bottom-grid">
            <section className="dl-home-panel">
              <div className="dl-home-panel-head">
                <div><h2>Recent Activity</h2></div>
              </div>
              <div className="dl-home-activity-list">
                <div className="dl-home-activity-row">
                  <span className="activity-icon blue"><Icon name="storage" size={20} /></span>
                  <div><strong>Storage index ready</strong><span>{roots?.length || 0} drive{roots?.length === 1 ? "" : "s"} available in DiskLens</span></div>
                </div>
                <div className="dl-home-activity-row">
                  <span className="activity-icon red"><Icon name="file" size={20} /></span>
                  <div><strong>Largest item found</strong><span>{biggest ? `${biggest.name} · ${formatBytes(biggest.size)}` : "No large items yet"}</span></div>
                </div>
                <div className="dl-home-activity-row">
                  <span className="activity-icon purple"><Icon name="sparkles" size={20} /></span>
                  <div><strong>AI Storage Advisor</strong><span>Ready to review your biggest storage items</span></div>
                </div>
              </div>
            </section>

            <section className="dl-home-panel">
              <div className="dl-home-panel-head">
                <div><h2>Tips for You</h2></div>
                <button className="dl-home-link" onClick={onOpenAI}>See AI advice <Icon name="chevronRight" size={15} /></button>
              </div>
              <div className="dl-home-tips">
                <button onClick={onOpenPrograms}>
                  <span className="tip-icon green"><Icon name="programs" size={20} /></span>
                  <div><strong>Review unused programs</strong><span>Use Programs & Cleanup to inspect leftovers.</span></div>
                  <Icon name="chevronRight" size={15} />
                </button>
                <button onClick={onOpenAI}>
                  <span className="tip-icon red"><Icon name="sparkles" size={20} /></span>
                  <div><strong>Ask AI about storage</strong><span>Start with your largest files or folders.</span></div>
                  <Icon name="chevronRight" size={15} />
                </button>
                <button onClick={() => biggest && onOpenItem(biggest)}>
                  <span className="tip-icon blue"><Icon name="file" size={20} /></span>
                  <div><strong>Review your largest item</strong><span>{biggest ? `${biggest.name} · ${formatBytes(biggest.size)}` : "No item available"}</span></div>
                  <Icon name="chevronRight" size={15} />
                </button>
              </div>
            </section>
          </div>
        </div>
      </div>
  );
}
