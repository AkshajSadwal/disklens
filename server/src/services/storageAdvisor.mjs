import { discoverInstalledPrograms } from "./programDiscovery.mjs";

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 10;

function cleanPath(value) {
  return String(value ?? "")
    .trim()
    .replace(/^"|"$/g, "")
    .replace(/[\\/]+$/, "");
}


function pathPrefix(value) {
  const cleaned = cleanPath(value);
  return cleaned ? `${cleaned}\\%` : "";
}

function clampLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(parsed)));
}

function folderDepth(pathValue) {
  return (String(pathValue ?? "").match(/\\/g) || []).length;
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

  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'file' THEN size ELSE 0 END), 0) AS totalSize,
      COUNT(CASE WHEN type = 'file' THEN 1 END) AS fileCount,
      COUNT(CASE WHEN type = 'directory' THEN 1 END) - 1 AS folderCount
    FROM items
    WHERE path = ? OR path LIKE ?
  `).get(folderPath, prefix);

  return {
    totalSize: Number(row?.totalSize) || 0,
    fileCount: Number(row?.fileCount) || 0,
    folderCount: Math.max(Number(row?.folderCount) || 0, 0),
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

    const rootDepth = folderDepth(root);

    const candidates = db.prepare(`
      SELECT id, root, path, name, created_at AS createdAt, modified_at AS modifiedAt
      FROM items
      WHERE type = 'directory'
        AND root = ?
        AND (length(path) - length(replace(path, '\\', ''))) = ?
      ORDER BY path
    `).all(root, rootDepth);

    for (const row of candidates) {
      const depth = folderDepth(row.path);
      if (depth !== rootDepth) continue;

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

async function buildProgramStorageRows(db) {
  const programs = await discoverInstalledPrograms();

  const indexedSizeStatement = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'file' THEN size ELSE 0 END), 0) AS totalSize,
      COUNT(CASE WHEN type = 'file' THEN 1 END) AS fileCount
    FROM items
    WHERE type = 'file'
      AND (path = ? OR path LIKE ?)
  `);

  return programs.map((program) => {
    const installLocation = cleanPath(program.installLocation);
    const prefix = installLocation ? `${installLocation}\\%` : "";

    let size = Number(program.estimatedSizeKB || 0) * 1024;
    let fileCount = 0;
    let sizeBasis = "windows-estimated-install-size";

    if (installLocation && prefix) {
      const row = indexedSizeStatement.get(installLocation, prefix);
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
    const programs = await buildProgramStorageRows(db);
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
    const programs = await buildProgramStorageRows(db);
    const name = String(target.name || "").trim().toLowerCase();
    const version = String(target.version || "").trim().toLowerCase();
    const publisher = String(target.publisher || "").trim().toLowerCase();

    const exact = programs.find((program) =>
      program.name.toLowerCase() === name &&
      (!version || program.version.toLowerCase() === version) &&
      (!publisher || program.publisher.toLowerCase() === publisher),
    );

    if (!exact) {
      const error = new Error("The selected program was not found.");
      error.code = "TARGET_NOT_FOUND";
      throw error;
    }

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
