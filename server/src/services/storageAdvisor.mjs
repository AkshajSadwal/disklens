import path from "node:path";
import { discoverInstalledPrograms } from "./programDiscovery.mjs";

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 10;

function cleanPath(value) {
  const raw = String(value ?? "").trim().replace(/^"|"$/g, "");
  if (!raw) return "";
  const resolved = path.resolve(raw);
  return resolved === path.parse(resolved).root ? resolved : resolved.replace(/[\\/]+$/, "");
}

function pathPrefix(value) {
  const cleaned = cleanPath(value);
  if (!cleaned) return "";
  return cleaned.endsWith(path.sep) ? cleaned : `${cleaned}${path.sep}`;
}

function clampLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(parsed)));
}

function indexedPathRange(value) {
  const prefix = pathPrefix(value);
  if (!prefix) return null;
  const upperBound = `${prefix.slice(0, -1)}${String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)}`;
  return { prefix, upperBound, caseInsensitive: path.sep === "\\" };
}

function serializeFile(row) {
  return {
    type: "file",
    id: row.id,
    root: row.root,
    name: row.name,
    path: row.path,
    size: Number(row.size) || 0,
    modifiedAt: row.modifiedAt || "",
    sizeBasis: "indexed-file-size",
  };
}

function getFolderAggregate(db, folderPath) {
  const prefix = pathPrefix(folderPath);
  if (!prefix) return null;

  const upperBound = `${prefix.slice(0, -1)}${String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)}`;
  const collation = path.sep === "\\" ? " COLLATE NOCASE" : "";
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'file' THEN size ELSE 0 END), 0) AS totalSize,
      COUNT(CASE WHEN type = 'file' THEN 1 END) AS fileCount,
      COUNT(CASE WHEN type = 'directory' THEN 1 END) - 1 AS directoryCount
    FROM items
    WHERE path = ?${collation}
      OR (path > ?${collation} AND path < ?${collation})
  `).get(cleanPath(folderPath), prefix, upperBound);

  return {
    totalSize: Number(row?.totalSize) || 0,
    fileCount: Number(row?.fileCount) || 0,
    folderCount: Math.max(Number(row?.directoryCount) || 0, 0),
  };
}

function getTopFiles(db, limit) {
  const rows = db.prepare(`
    SELECT id, root, path, name, size, modified_at AS modifiedAt
    FROM items
    WHERE type = 'file'
    ORDER BY size DESC, id ASC
    LIMIT ?
  `).all(limit);

  return rows.map(serializeFile);
}

function getTopLevelFolders(db, limit) {
  const roots = db.prepare(`
    SELECT DISTINCT root
    FROM items
    WHERE root IS NOT NULL AND root != ''
    ORDER BY root
  `).all();

  const folders = [];

  // The current index does not persist recursive folder totals. To stay fast,
  // start with top-level folders for every indexed drive and calculate their
  // exact descendant size from the file index.
  for (const { root } of roots) {
    const rootClean = cleanPath(root);
    if (!rootClean) continue;

    const range = indexedPathRange(rootClean);
    if (!range) continue;
    const collation = range.caseInsensitive ? " COLLATE NOCASE" : "";

    // Restrict candidate directories to direct children in SQLite. Previously
    // every directory on a drive was copied into Node and depth-filtered.
    const candidates = db.prepare(`
      SELECT id, root, path, name, created_at AS createdAt, modified_at AS modifiedAt
      FROM items
      WHERE type = 'directory' AND root = ?
        AND path > ?${collation} AND path < ?${collation}
        AND instr(substr(path, length(?) + 1), ?) = 0
      ORDER BY path
    `).all(root, range.prefix, range.upperBound, range.prefix, path.sep);

    for (const row of candidates) {

      const aggregate = getFolderAggregate(db, row.path);
      if (!aggregate || aggregate.totalSize <= 0) continue;

      folders.push({
        type: "folder",
        id: row.id,
        root: row.root,
        name: row.name,
        path: row.path,
        size: aggregate.totalSize,
        fileCount: aggregate.fileCount,
        folderCount: aggregate.folderCount,
        createdAt: row.createdAt || "",
        modifiedAt: row.modifiedAt || "",
        sizeBasis: "indexed-descendant-file-size",
        scope: "top-level-folder",
      });
    }
  }

  folders.sort((a, b) => (b.size - a.size) || String(a.path).localeCompare(String(b.path)));
  return folders.slice(0, limit);
}

export async function buildProgramStorageRows(db, discoveredPrograms = null) {
  const programs = discoveredPrograms || await discoverInstalledPrograms();

  const indexedSizeStatement = db.prepare(`
    SELECT
      COALESCE(SUM(size), 0) AS totalSize,
      COUNT(*) AS fileCount
    FROM items
    WHERE type = 'file'
      AND (
        path = ? COLLATE NOCASE
        OR path LIKE ? ESCAPE '\\' COLLATE NOCASE
      )
  `);

  return programs.map((program) => {
    const installLocation = cleanPath(program.installLocation);
    const prefix = installLocation ? pathPrefix(installLocation) : "";

    let size = Number(program.estimatedSizeKB || 0) * 1024;
    let fileCount = 0;
    let sizeBasis = program.estimatedSizeKB ? "package-manager-or-registry-estimate" : "not-available";

    if (installLocation && prefix) {
      // Escape SQL LIKE metacharacters so paths containing %, _ or \\
      // are treated as literal path characters. The trailing wildcard still
      // allows SQLite to use idx_items_type_path_nocase as a prefix range.
      const escapedPrefix = prefix.replace(/[\\%_]/g, (character) => `\\${character}`);
      const row = indexedSizeStatement.get(installLocation, `${escapedPrefix}%`);
      const indexedSize = Number(row?.totalSize) || 0;

      if (indexedSize > 0) {
        size = indexedSize;
        fileCount = Number(row?.fileCount) || 0;
        sizeBasis = "indexed-install-location-size";
      }
    }

    return {
      type: "program",
      name: program.name,
      version: program.version,
      publisher: program.publisher,
      installLocation: program.installLocation || "",
      displayIcon: program.displayIcon || "",
      size,
      fileCount,
      sizeBasis,
      estimatedSizeKB: Number(program.estimatedSizeKB) || 0,
    };
  });
}

export async function getTopStorageSnapshot(db, options = {}) {
  const limit = clampLimit(options.limit);
  const include = {
    programs: options.include?.programs !== false,
    files: options.include?.files !== false,
    folders: options.include?.folders !== false,
  };

  const snapshot = {
    mode: "top",
    limit,
    include,
    indexedFileCount: Number(
      db.prepare("SELECT COUNT(*) AS count FROM items WHERE type='file'").get()?.count || 0,
    ),
    entities: {
      programs: [],
      files: [],
      folders: [],
    },
  };

  if (include.files) {
    snapshot.entities.files = getTopFiles(db, limit);
  }

  if (include.folders) {
    snapshot.entities.folders = getTopLevelFolders(db, limit);
  }

  if (include.programs) {
    // A top-storage preview should stay responsive. Rank applications using
    // their registry/package estimates; precise indexed size is calculated on
    // demand for an individual selected program below, not with one database
    // aggregation per installed application.
    const programs = (await discoverInstalledPrograms()).map((program) => {
      const estimatedSizeKB = Number(program.estimatedSizeKB) || 0;
      return {
        type: "program",
        name: program.name,
        version: program.version || "",
        publisher: program.publisher || "",
        installLocation: program.installLocation || "",
        displayIcon: program.displayIcon || "",
        size: estimatedSizeKB * 1024,
        fileCount: 0,
        sizeBasis: estimatedSizeKB > 0 ? "package-manager-or-registry-estimate" : "not-available",
        estimatedSizeKB,
      };
    });
    programs.sort((a, b) => (b.size - a.size) || a.name.localeCompare(b.name));
    snapshot.entities.programs = programs.slice(0, limit);
  }

  return snapshot;
}

export async function getStorageTarget(db, target = {}) {
  const type = String(target.type || "").trim().toLowerCase();

  if (type === "file" || type === "folder") {
    const id = Number(target.id);
    if (!Number.isInteger(id)) {
      const error = new Error("A valid item id is required.");
      error.code = "INVALID_TARGET";
      throw error;
    }

    const item = db.prepare(`
      SELECT
        id, root, path, name, type,
        size,
        created_at AS createdAt,
        modified_at AS modifiedAt
      FROM items
      WHERE id = ?
    `).get(id);

    if (!item || item.type !== (type === "folder" ? "directory" : "file")) {
      const error = new Error("The selected storage item was not found.");
      error.code = "TARGET_NOT_FOUND";
      throw error;
    }

    if (type === "file") {
      return serializeFile(item);
    }

    const aggregate = getFolderAggregate(db, item.path);
    return {
      type: "folder",
      id: item.id,
      root: item.root,
      name: item.name,
      path: item.path,
      size: aggregate.totalSize,
      fileCount: aggregate.fileCount,
      folderCount: aggregate.folderCount,
      createdAt: item.createdAt || "",
      modifiedAt: item.modifiedAt || "",
      sizeBasis: "indexed-descendant-file-size",
    };
  }

  if (type === "program") {
    const discoveredPrograms = await discoverInstalledPrograms();
    const name = String(target.name || "").trim().toLowerCase();
    const version = String(target.version || "").trim().toLowerCase();
    const publisher = String(target.publisher || "").trim().toLowerCase();

    const selected = discoveredPrograms.find((program) =>
      String(program.name || "").trim().toLowerCase() === name &&
      (!version || String(program.version || "").trim().toLowerCase() === version) &&
      (!publisher || String(program.publisher || "").trim().toLowerCase() === publisher),
    );

    if (!selected) {
      const error = new Error("The selected program was not found.");
      error.code = "TARGET_NOT_FOUND";
      throw error;
    }

    // Only one indexed install-location lookup is needed for a selected item.
    const [exact] = await buildProgramStorageRows(db, [selected]);
    return exact;
  }

  const error = new Error("Target type must be program, file, or folder.");
  error.code = "INVALID_TARGET";
  throw error;
}

export async function searchStorageTargets(db, options = {}) {
  const type = String(options.type || "").trim().toLowerCase();
  const query = String(options.query || "").trim();
  const limit = Math.min(30, Math.max(1, Number(options.limit) || 12));

  if (!query) return [];

  if (type === "file") {
    const like = `%${query}%`;
    const rows = db.prepare(`
      SELECT id, root, path, name, size, modified_at AS modifiedAt
      FROM items
      WHERE type = 'file'
        AND (name LIKE ? OR path LIKE ?)
      ORDER BY size DESC
      LIMIT ?
    `).all(like, like, limit);

    return rows.map(serializeFile);
  }

  if (type === "folder") {
    const like = `%${query}%`;
    const rows = db.prepare(`
      SELECT id, root, path, name, created_at AS createdAt, modified_at AS modifiedAt
      FROM items
      WHERE type = 'directory'
        AND (name LIKE ? OR path LIKE ?)
      ORDER BY path
      LIMIT ?
    `).all(like, like, limit);

    return rows
      .map((row) => {
        const aggregate = getFolderAggregate(db, row.path);
        return {
          type: "folder",
          id: row.id,
          root: row.root,
          name: row.name,
          path: row.path,
          size: aggregate.totalSize,
          fileCount: aggregate.fileCount,
          folderCount: aggregate.folderCount,
          createdAt: row.createdAt || "",
          modifiedAt: row.modifiedAt || "",
          sizeBasis: "indexed-descendant-file-size",
        };
      })
      .sort((a, b) => b.size - a.size);
  }

  return [];
}
