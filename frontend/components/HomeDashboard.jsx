import Icon from "./common/Icon";
import { formatBytes } from "../lib/formatters";

function DriveSummary({ drive, indexed }) {
  const hasActual = Number.isFinite(Number(drive?.totalBytes)) && Number(drive?.totalBytes) > 0;
  const total = hasActual ? Number(drive.totalBytes) : Number(indexed?.size || 0);
  const used = hasActual ? Number(drive.usedBytes || 0) : Number(indexed?.size || 0);
  const free = hasActual ? Number(drive.freeBytes || 0) : Math.max(total - used, 0);
  const percent = total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0;

  return (
    <button className="dl-drive-card" onClick={drive?.root ? () => drive.onOpen(drive.root) : undefined}>
      <div className="dl-drive-card-top">
        <div className="dl-drive-icon"><Icon name="drive" size={19} /></div>
        <div className="dl-drive-title-wrap">
          <div className="dl-drive-title">{drive?.root || indexed?.root}</div>
          <div className="dl-drive-subtitle">{drive?.volumeName || "Local Disk"}</div>
        </div>
        <div className="dl-drive-percent">{percent.toFixed(0)}%</div>
      </div>
      <div className="dl-progress"><div style={{ width: `${percent}%` }} /></div>
      <div className="dl-drive-meta">
        <span>{formatBytes(used)} used</span>
        <span>{formatBytes(total)} total</span>
      </div>
      <div className="dl-drive-free">{formatBytes(free)} free</div>
    </button>
  );
}

export default function HomeDashboard({ drives, roots, largestItems, onOpenRoot, onOpenItem, onOpenPrograms, onOpenAI }) {
  const driveMap = new Map((drives || []).map((item) => [item.root, item]));
  const totalStorage = (drives || []).reduce((sum, drive) => sum + Number(drive.totalBytes || 0), 0);
  const totalUsed = (drives || []).reduce((sum, drive) => sum + Number(drive.usedBytes || 0), 0);
  const totalFree = (drives || []).reduce((sum, drive) => sum + Number(drive.freeBytes || 0), 0);
  const fallbackSize = (roots || []).reduce((sum, root) => sum + Number(root.size || 0), 0);
  const total = totalStorage || fallbackSize;
  const used = totalStorage ? totalUsed : fallbackSize;
  const free = totalStorage ? totalFree : Math.max(total - used, 0);

  return (
    <div className="dl-page">
      <div className="dl-page-head">
        <div>
          <div className="dl-eyebrow">OVERVIEW</div>
          <h1>Home</h1>
          <p>A simple view of your storage.</p>
        </div>
        <button className="dl-primary-btn" onClick={() => onOpenRoot(roots?.[0]?.root)}>
          <Icon name="scan" size={16} />
          Scan status
        </button>
      </div>

      <div className="dl-stat-grid">
        <div className="dl-stat-card">
          <div className="dl-stat-icon"><Icon name="storage" size={18} /></div>
          <div><div className="dl-stat-label">Total storage</div><div className="dl-stat-value">{formatBytes(total)}</div></div>
        </div>
        <div className="dl-stat-card">
          <div className="dl-ring"><span style={{ background: `conic-gradient(#2563eb ${total ? (used / total) * 360 : 0}deg, #e8eef6 0)` }} /></div>
          <div><div className="dl-stat-label">Used</div><div className="dl-stat-value">{formatBytes(used)}</div></div>
        </div>
        <div className="dl-stat-card">
          <div className="dl-ring"><span style={{ background: `conic-gradient(#9aa8bb ${total ? (free / total) * 360 : 0}deg, #e8eef6 0)` }} /></div>
          <div><div className="dl-stat-label">Free</div><div className="dl-stat-value">{formatBytes(free)}</div></div>
        </div>
      </div>

      <section className="dl-section">
        <div className="dl-section-head"><div><h2>Drives</h2><p>Actual capacity from Windows.</p></div><button className="dl-text-btn" onClick={() => onOpenRoot(roots?.[0]?.root)}>View storage <Icon name="chevronRight" size={15} /></button></div>
        <div className="dl-drive-grid">
          {(roots || []).map((root) => (
            <DriveSummary
              key={root.root}
              drive={{ ...(driveMap.get(root.root) || {}), root: root.root, onOpen: onOpenRoot }}
              indexed={root}
            />
          ))}
        </div>
      </section>

      <section className="dl-section">
        <div className="dl-section-head"><div><h2>Largest items</h2><p>Files and folders that deserve a closer look.</p></div><button className="dl-text-btn" onClick={() => onOpenRoot(roots?.[0]?.root)}>View all <Icon name="chevronRight" size={15} /></button></div>
        <div className="dl-list-card">
          {(largestItems || []).slice(0, 7).map((item) => (
            <button className="dl-large-row" key={item.id || item.path} onClick={() => onOpenItem(item)}>
              <div className={`dl-item-icon ${item.type === "directory" ? "folder" : "file"}`}><Icon name={item.type === "directory" ? "folder" : "file"} size={17} /></div>
              <div className="dl-large-name"><span>{item.name}</span><small>{item.root || ""}</small></div>
              <div className="dl-large-size">{formatBytes(item.size)}</div>
              <Icon name="chevronRight" size={15} />
            </button>
          ))}
          {!largestItems?.length && <div className="dl-empty">No indexed items yet.</div>}
        </div>
      </section>

      <section className="dl-quick-grid">
        <button className="dl-feature-card" onClick={onOpenAI}>
          <div className="dl-feature-icon ai"><Icon name="sparkles" size={18} /></div>
          <div><strong>AI Storage Advisor</strong><span>Find practical ways to free space.</span></div>
          <Icon name="chevronRight" size={16} />
        </button>
        <button className="dl-feature-card" onClick={onOpenPrograms}>
          <div className="dl-feature-icon"><Icon name="programs" size={18} /></div>
          <div><strong>Programs & Cleanup</strong><span>Review program files and leftovers.</span></div>
          <Icon name="chevronRight" size={16} />
        </button>
      </section>
    </div>
  );
}
