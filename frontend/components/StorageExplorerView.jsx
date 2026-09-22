import Icon from "./common/Icon";
import Sunburst from "./Sunburst";
import { formatBytes, formatDate } from "../lib/formatters";

function itemType(item) {
  if (item.type === "directory") return "Folder";
  if (item.type === "file") return "File";
  return item.type || "Other";
}

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
        <div>
          <div className="dl-eyebrow">STORAGE EXPLORER</div>
          <h1>Storage</h1>
          <p>Explore your files and folders.</p>
        </div>
        <div className="dl-root-tabs">
          {(roots || []).map((root) => (
            <button
              key={root.root}
              className={root.root === currentPath ? "is-active" : ""}
              onClick={() => onRoot(root.root)}
            >
              {root.root}
            </button>
          ))}
        </div>
      </div>

      <div className="dl-pathbar">
        <button className="dl-icon-btn" onClick={onBack} disabled={!backStack.length}>
          <Icon name="arrowLeft" size={16} />
        </button>
        <button className="dl-icon-btn" onClick={onForward} disabled={!forwardStack.length}>
          <Icon name="arrowRight" size={16} />
        </button>
        <div className="dl-breadcrumbs">
          {breadcrumbs.map((crumb, index) => (
            <span key={crumb.path}>
              <button onClick={() => onNavigate(crumb.path)}>{crumb.name}</button>
              {index < breadcrumbs.length - 1 && <Icon name="chevronRight" size={12} />}
            </span>
          ))}
        </div>
        <div className="dl-current-count">{folderItems.length} items</div>
      </div>

      {error && <div className="dl-alert">{error}</div>}

      <div className="dl-storage-grid">
        <section className="dl-card dl-chart-card">
          <div className="dl-card-head">
            <div>
              <h2>Storage Map</h2>
              <p>Largest areas in this location.</p>
            </div>
            <strong>{formatBytes(totalSize)}</strong>
          </div>
          <div className="dl-chart-wrap">
            {sunburstLoading ? (
              <div className="dl-loading">Building visualization...</div>
            ) : (
              <Sunburst data={sunburstData} onOpen={onSunburstOpen} />
            )}
          </div>
        </section>

        <section className="dl-card dl-files-card">
          <div className="dl-card-head">
            <div>
              <h2>Contents</h2>
              <p>Open folders or select a file to view its details.</p>
            </div>
          </div>

          <div className="dl-file-table-head">
            <span>Name</span>
            <span>Size</span>
            <span>Type</span>
            <span>Modified</span>
            <span />
          </div>

          <div className="dl-file-list items-scroll">
            {loading ? (
              <div className="dl-loading">Loading...</div>
            ) : (
              folderItems.map((item) => (
                <div className="dl-file-row" key={item.path}>
                  <button
                    className="dl-file-main"
                    onClick={() => item.type === "directory" ? onOpenFolder(item) : onOpenDetails(item)}
                  >
                    <div className={`dl-item-icon ${item.type === "directory" ? "folder" : "file"}`}>
                      <Icon name={item.type === "directory" ? "folder" : "file"} size={16} />
                    </div>
                    <div className="dl-file-name">
                      <span>{item.name}</span>
                      <small>
                        {item.type === "directory" ? `${item.fileCount || 0} files · ${item.folderCount || 0} folders` : item.path}
                      </small>
                    </div>
                  </button>

                  <div className="dl-file-table-size">{formatBytes(item.size)}</div>
                  <div className="dl-file-table-type">{itemType(item)}</div>
                  <div className="dl-file-table-date">{formatDate(item.modifiedAt)}</div>
                  <button className="dl-more-btn" title="Details" onClick={() => onOpenDetails(item)}>
                    <Icon name="more" size={15} />
                  </button>
                </div>
              ))
            )}
            {!loading && folderItems.length === 0 && <div className="dl-empty">No data in this location.</div>}
          </div>
        </section>
      </div>
    </div>
  );
}
