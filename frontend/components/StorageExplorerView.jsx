import { useEffect, useState } from "react";
import Icon from "./common/Icon";
import Sunburst from "./Sunburst";
import { formatBytes, formatDate } from "../lib/formatters";
import { API } from "../lib/api";

const SAVED_FILTERS_KEY = "disklens.explorer.saved-filters";
const MAX_SAVED_FILTERS = 20;
const MAX_EXPORT_ROWS = 10_000;

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
  const [search, setSearch] = useState({ q: "", qField: "name", extension: "", type: "all", minSize: "", maxSize: "", modifiedAfter: "", modifiedBefore: "", sort: "name", order: "asc" });
  const [searchResults, setSearchResults] = useState(null);
  const [searchPage, setSearchPage] = useState(1);
  const [searchPagination, setSearchPagination] = useState(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [savedFilters, setSavedFilters] = useState([]);
  const [filterName, setFilterName] = useState("");
  const [exportBusy, setExportBusy] = useState(false);
  const [exportMessage, setExportMessage] = useState("");
  const isSearchMode = Boolean(search.q || search.extension || search.type !== "all" || search.minSize || search.maxSize || search.modifiedAfter || search.modifiedBefore);

  useEffect(() => {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(SAVED_FILTERS_KEY) || "[]");
      if (Array.isArray(parsed)) setSavedFilters(parsed.filter((item) => item && typeof item.name === "string" && item.search && typeof item.search === "object").slice(0, MAX_SAVED_FILTERS));
    } catch { setSavedFilters([]); }
  }, []);

  function makeSearchParams(page, limit) {
    const params = new URLSearchParams({ path: currentPath, page: String(page), limit: String(limit), sort: search.sort, order: search.order, qField: search.qField });
    for (const field of ["q", "extension", "type", "modifiedAfter", "modifiedBefore"]) if (search[field] && search[field] !== "all") params.set(field, search[field]);
    if (search.minSize) params.set("minSize", String(Math.floor(Number(search.minSize) * 1024 * 1024)));
    if (search.maxSize) params.set("maxSize", String(Math.floor(Number(search.maxSize) * 1024 * 1024)));
    return params;
  }

  useEffect(() => { setSearchPage(1); }, [currentPath]);

  useEffect(() => {
    if (!isSearchMode) {
      setSearchResults(null);
      setSearchPagination(null);
      setSearchError("");
      return undefined;
    }
    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearchLoading(true);
      setSearchError("");
      try {
        const params = makeSearchParams(searchPage, 50);
        const response = await fetch(`${API}/api/explorer/search?${params}`, { signal: controller.signal });
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.error || `Search failed (${response.status}).`);
        if (!cancelled) {
          setSearchResults((data?.items || []).map((item) => ({ ...item, size: item.type === "directory" ? item.indexedSize : item.size })));
          setSearchPagination(data?.pagination || null);
        }
      } catch (err) {
        if (!cancelled && err.name !== "AbortError") { setSearchError(err.message); setSearchResults([]); }
      } finally {
        if (!cancelled) setSearchLoading(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); controller.abort(); };
  }, [currentPath, isSearchMode, search, searchPage]);

  const visibleItems = isSearchMode ? (searchResults || []) : folderItems;
  const visibleLoading = isSearchMode ? searchLoading : loading;

  function updateSearch(field, value) {
    setSearch((current) => ({ ...current, [field]: value }));
    setSearchPage(1);
  }

  function clearSearch() {
    setSearch({ q: "", qField: "name", extension: "", type: "all", minSize: "", maxSize: "", modifiedAfter: "", modifiedBefore: "", sort: "name", order: "asc" });
    setSearchPage(1);
  }

  function saveCurrentFilter() {
    const name = filterName.trim().slice(0, 60);
    if (!name) { setExportMessage("Enter a name for this filter."); return; }
    const next = [{ id: `${Date.now()}`, name, search: { ...search } }, ...savedFilters.filter((item) => item.name.toLowerCase() !== name.toLowerCase())].slice(0, MAX_SAVED_FILTERS);
    setSavedFilters(next);
    try { window.localStorage.setItem(SAVED_FILTERS_KEY, JSON.stringify(next)); }
    catch { setExportMessage("Browser storage is unavailable; this filter could not be saved."); return; }
    setFilterName("");
    setExportMessage(`Saved filter “${name}” in this browser.`);
  }

  function removeSavedFilter(id) {
    const next = savedFilters.filter((item) => item.id !== id);
    setSavedFilters(next);
    try { window.localStorage.setItem(SAVED_FILTERS_KEY, JSON.stringify(next)); }
    catch { setExportMessage("Browser storage is unavailable; this filter could not be removed."); }
  }

  async function exportCsv() {
    setExportBusy(true); setExportMessage(""); setSearchError("");
    try {
      const firstResponse = await fetch(`${API}/api/explorer/search?${makeSearchParams(1, 100)}`);
      const first = await firstResponse.json().catch(() => null);
      if (!firstResponse.ok) throw new Error(first?.error || `Export failed (${firstResponse.status}).`);
      const total = Number(first?.pagination?.total) || 0;
      const pages = Math.min(Number(first?.pagination?.totalPages) || 1, Math.ceil(MAX_EXPORT_ROWS / 100));
      const rows = [...(first.items || [])];
      for (let page = 2; page <= pages; page += 1) {
        const response = await fetch(`${API}/api/explorer/search?${makeSearchParams(page, 100)}`);
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.error || `Export failed (${response.status}).`);
        rows.push(...(data.items || []));
      }
      const columns = ["name", "type", "size", "modifiedAt", "path", "root", "accessStatus"];
      const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
      const csv = [columns.map(quote).join(","), ...rows.map((row) => columns.map((key) => quote(key === "size" && row.type === "directory" ? row.indexedSize : row[key])).join(","))].join("\r\n");
      const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `disklens-storage-report-${new Date().toISOString().slice(0, 10)}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
      setExportMessage(`Exported ${rows.length.toLocaleString()} of ${total.toLocaleString()} matching rows${total > rows.length ? ` (maximum ${MAX_EXPORT_ROWS.toLocaleString()})` : ""}.`);
    } catch (err) { setSearchError(err.message); }
    finally { setExportBusy(false); }
  }

  return (
    <div className="dl-page">
      <div className="dl-page-head storage-head">
        <div>
          <div className="dl-eyebrow">STORAGE EXPLORER</div>
          <h1>Storage</h1>
          <p>Explore your files and folders.</p>
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
          <div className="dl-card-head dl-storage-map-head">
            <div>
              <h2>Storage Map</h2>
              <p>Largest areas in this location.</p>
            </div>
            <div className="dl-storage-drive-switcher" aria-label="Select drive">
              {(roots || []).map((root) => (
                <button
                  key={root.root}
                  type="button"
                  className={root.root === currentPath ? "is-active" : ""}
                  onClick={() => onRoot(root.root)}
                >
                  {root.root}
                </button>
              ))}
              <strong>{formatBytes(totalSize)}</strong>
            </div>
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

          <div className="dl-explorer-filters" role="search" aria-label="Filter indexed storage">
            <label><span>Search in</span><select value={search.qField} onChange={(event) => updateSearch("qField", event.target.value)}><option value="name">Name</option><option value="path">Path</option><option value="both">Name and path</option></select></label>
            <label><span>{search.qField === "path" ? "Path prefix" : search.qField === "both" ? "Name or path prefix" : "Name starts with"}</span><input type="search" value={search.q} onChange={(event) => updateSearch("q", event.target.value)} placeholder={search.qField === "path" ? currentPath : "Search files and folders"} /></label>
            <label><span>Extension</span><input value={search.extension} onChange={(event) => updateSearch("extension", event.target.value)} placeholder=".pdf" /></label>
            <label><span>Kind</span><select value={search.type} onChange={(event) => updateSearch("type", event.target.value)}><option value="all">All</option><option value="file">Files</option><option value="folder">Folders</option></select></label>
            <label><span>Min size (MB)</span><input type="number" min="0" value={search.minSize} onChange={(event) => updateSearch("minSize", event.target.value)} /></label>
            <label><span>Max size (MB)</span><input type="number" min="0" value={search.maxSize} onChange={(event) => updateSearch("maxSize", event.target.value)} /></label>
            <label><span>Modified after</span><input type="date" value={search.modifiedAfter} onChange={(event) => updateSearch("modifiedAfter", event.target.value)} /></label>
            <label><span>Modified before</span><input type="date" value={search.modifiedBefore} onChange={(event) => updateSearch("modifiedBefore", event.target.value)} /></label>
            <label><span>Sort by</span><select value={search.sort} onChange={(event) => updateSearch("sort", event.target.value)}><option value="name">Name</option><option value="size">Size</option><option value="modified">Modified</option><option value="type">Type</option></select></label>
            <label><span>Order</span><select value={search.order} onChange={(event) => updateSearch("order", event.target.value)}><option value="asc">Ascending</option><option value="desc">Descending</option></select></label>
            {isSearchMode && <button type="button" onClick={clearSearch}>Clear filters</button>}
          </div>
          <div className="dl-explorer-saved-filters">
            <label><span>Saved filters</span><select defaultValue="" onChange={(event) => {
              const preset = savedFilters.find((item) => item.id === event.target.value);
              if (preset) { setSearch(preset.search); setSearchPage(1); setExportMessage(`Applied “${preset.name}”.`); }
              event.target.value = "";
            }}><option value="">Choose a saved filter</option>{savedFilters.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            {savedFilters.map((item) => <button type="button" key={`remove-${item.id}`} title={`Remove ${item.name}`} aria-label={`Remove saved filter ${item.name}`} onClick={() => removeSavedFilter(item.id)}>× {item.name}</button>)}
            <input aria-label="Saved filter name" value={filterName} onChange={(event) => setFilterName(event.target.value)} maxLength={60} placeholder="Name current filters" />
            <button type="button" onClick={saveCurrentFilter}>Save current filter</button>
            <button type="button" onClick={exportCsv} disabled={!isSearchMode || exportBusy}>{exportBusy ? "Exporting…" : "Export CSV (up to 10,000)"}</button>
          </div>
          {exportMessage && <div className="dl-explorer-result-count" role="status">{exportMessage}</div>}
          {searchError && <div className="dl-alert" role="alert">{searchError}</div>}
          {isSearchMode && <div className="dl-explorer-result-count">{searchLoading ? "Searching indexed items…" : `${searchPagination?.total || 0} results in this location and its subfolders`}</div>}

          <div className="dl-file-table-head">
            <span>Name</span>
            <span>Size</span>
            <span>Type</span>
            <span>Modified</span>
            <span />
          </div>

          <div className="dl-file-list items-scroll">
            {visibleLoading ? (
              <div className="dl-loading" role="status">{isSearchMode ? "Searching…" : "Loading…"}</div>
            ) : (
              visibleItems.map((item) => (
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
            {!visibleLoading && visibleItems.length === 0 && <div className="dl-empty">{isSearchMode ? "No indexed items match these filters." : "No data in this location."}</div>}
          </div>
          {isSearchMode && Number(searchPagination?.totalPages) > 1 && <div className="dl-explorer-pagination">
            <button type="button" onClick={() => setSearchPage((page) => Math.max(1, page - 1))} disabled={searchPage <= 1 || searchLoading}>Previous</button>
            <span>Page {searchPage} of {searchPagination.totalPages}</span>
            <button type="button" onClick={() => setSearchPage((page) => Math.min(searchPagination.totalPages, page + 1))} disabled={searchPage >= searchPagination.totalPages || searchLoading}>Next</button>
          </div>}
        </section>
      </div>
    </div>
  );
}
