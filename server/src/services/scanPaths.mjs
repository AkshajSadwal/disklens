import path from "node:path";

function pathApi(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

export function canonicalScanPath(value, platform = process.platform) {
  const api = pathApi(platform);
  const resolved = api.resolve(String(value || "").trim());
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function pathsOverlap(first, second, platform = process.platform) {
  const api = pathApi(platform);
  const a = canonicalScanPath(first, platform);
  const b = canonicalScanPath(second, platform);
  const isWithin = (parent, candidate) => {
    const relative = api.relative(parent, candidate);
    return relative === "" || (!api.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${api.sep}`));
  };
  return isWithin(a, b) || isWithin(b, a);
}

/** Normalize duplicate inputs and reject overlapping roots to avoid rescanning the same subtree. */
export function normalizeScanRoots(inputs, platform = process.platform) {
  const api = pathApi(platform);
  const roots = [];
  const seen = new Set();

  for (const value of inputs) {
    if (typeof value !== "string" || !value.trim()) continue;
    const root = api.resolve(value.trim());
    const key = canonicalScanPath(root, platform);
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(root);
  }

  for (let index = 0; index < roots.length; index += 1) {
    for (let other = index + 1; other < roots.length; other += 1) {
      if (pathsOverlap(roots[index], roots[other], platform)) {
        const error = new Error(`Selected locations overlap: ${roots[index]} and ${roots[other]}. Select the parent folder or the nested folder, not both.`);
        error.code = "SCAN_ROOT_OVERLAP";
        error.roots = [roots[index], roots[other]];
        throw error;
      }
    }
  }

  return roots;
}
