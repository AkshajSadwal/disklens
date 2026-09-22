import Icon from "./common/Icon";
import Sunburst from "./Sunburst";
import { formatBytes } from "../lib/formatters";

export default function StorageExplorerView({
  roots,
  currentPath,
  folderItems,
  breadcrumbs,
  backStack,
  forwardStack,
  totalSize,
  loading,
  error,
  sunburstData,
  sunburstLoading,
  onBack,
  onForward,
  onNavigate,
  onRoot,
  onSunburstOpen,
  onOpenDetails,
  onOpenFolder,
}) {
  return (
    <div className="dl-page">
      <div className="dl-page-head storage-head">
        <div><div className="dl-eyebrow">BROWSE</div><h1>Storage</h1><p>Explore your files and folders.</p></div>
        <div className="dl-root-tabs">
          {(roots || []).map((root) => (
            <button key={root.root} className={root.root === currentPath ? "is-active" : ""} onClick={() => onRoot(root.root)}>{root.root}</button>
          ))}
        </div>
      </div>

      <div className="dl-pathbar">
        <button className="dl-icon-btn" onClick={onBack} disabled={!backStack.length}><Icon name="arrowLeft" size={17} /></button>
        <button className="dl-icon-btn" onClick={onForward} disabled={!forwardStack.length}><Icon name="arrowRight" size={17} /></button>
        <div className="dl-breadcrumbs">
          {breadcrumbs.map((crumb, index) => <span key={crumb.path}><button onClick={() => onNavigate(crumb.path)}>{crumb.name}</button>{index < breadcrumbs.length - 1 && <Icon name="chevronRight" size={13} />}</span>)}
        </div>
        <div className="dl-current-count">{folderItems.length} items</div>
      </div>

      {error && <div className="dl-alert">{error}</div>}

      <div className="dl-storage-grid">
        <section className="dl-card dl-chart-card">
          <div className="dl-card-head"><div><h2>Storage map</h2><p>Largest areas in this location.</p></div><strong>{formatBytes(totalSize)}</strong></div>
          <div className="dl-chart-wrap">
            {sunburstLoading ? <div className="dl-loading">Building visualization...</div> : <Sunburst data={sunburstData} onOpen={onSunburstOpen} />}
          </div>
        </section>

        <section className="dl-card dl-files-card">
          <div className="dl-card-head"><div><h2>Contents</h2><p>Click a folder to browse, or a file to view details.</p></div></div>
          <div className="dl-file-list items-scroll">
            {loading ? <div className="dl-loading">Loading...</div> : folderItems.map((item) => (
              <div className="dl-file-row" key={item.path}>
                <button className="dl-file-main" onClick={() => item.type === "directory" ? onOpenFolder(item) : onOpenDetails(item)}>
                  <div className={`dl-item-icon ${item.type === "directory" ? "folder" : "file"}`}><Icon name={item.type === "directory" ? "folder" : "file"} size={17} /></div>
                  <div className="dl-file-name"><span>{item.name}</span><small>{item.type === "directory" ? `${item.fileCount || 0} files` : "File"}</small></div>
                  <div className="dl-file-size">{formatBytes(item.size)}</div>
                </button>
                <button className="dl-more-btn" title="Details" onClick={() => onOpenDetails(item)}><Icon name="more" size={17} /></button>
              </div>
            ))}
            {!loading && folderItems.length === 0 && <div className="dl-empty">No data in this location.</div>}
          </div>
        </section>
      </div>
    </div>
  );
}
