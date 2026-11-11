export const MINIMUM_NODE_MAJOR = 22;

export function supportsDiskLensNode(version = process.versions.node) {
  const match = String(version || "").match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return Boolean(match && Number(match[1]) >= MINIMUM_NODE_MAJOR);
}

export function requireSupportedNodeRuntime(component, version = process.versions.node) {
  if (supportsDiskLensNode(version)) return;
  const detected = String(version || "unknown");
  const error = new Error(`${component} requires Node.js ${MINIMUM_NODE_MAJOR} or later; detected ${detected}.`);
  error.code = "UNSUPPORTED_NODE_VERSION";
  throw error;
}
