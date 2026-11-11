const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const SAFE_METHODS = new Set(["GET", "HEAD"]);

export function isTrustedLocalProxyRequest(request) {
  let requestUrl;
  try {
    requestUrl = new URL(request.url);
  } catch {
    return false;
  }

  if (!LOOPBACK_HOSTS.has(requestUrl.hostname.toLowerCase())) return false;

  const origin = request.headers?.get?.("origin") ?? null;
  if (!origin) return SAFE_METHODS.has(String(request.method || "GET").toUpperCase());

  try {
    const originUrl = new URL(origin);
    return originUrl.origin === requestUrl.origin && LOOPBACK_HOSTS.has(originUrl.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function buildLocalApiTarget(requestUrl, pathSegments, apiOrigin = "http://127.0.0.1:4000") {
  const origin = new URL(apiOrigin);
  if (!(["http:", "https:"].includes(origin.protocol)) || !LOOPBACK_HOSTS.has(origin.hostname.toLowerCase()) || origin.username || origin.password) {
    throw new Error("DiskLens API proxy target must be a loopback URL.");
  }

  const incoming = new URL(requestUrl);
  const parts = Array.isArray(pathSegments) ? pathSegments : [pathSegments];
  const safePath = parts.filter((part) => part != null && String(part) !== "").map((part) => encodeURIComponent(String(part))).join("/");
  return `${origin.origin}/api/${safePath}${incoming.search}`;
}
