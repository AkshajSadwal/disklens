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
    const originIsLoopback = LOOPBACK_HOSTS.has(originUrl.hostname.toLowerCase());
    const requestIsHttp = requestUrl.protocol === "http:" || requestUrl.protocol === "https:";
    const originIsHttp = originUrl.protocol === "http:" || originUrl.protocol === "https:";

    // Browsers may open DiskLens as 127.0.0.1 while Next.js constructs the
    // internal Request URL with localhost (or vice versa). Both resolve only
    // to the local machine, so accept either loopback hostname when scheme
    // and port match. Never accept a remote host or a different local port.
    return requestIsHttp && originIsHttp && originIsLoopback &&
      originUrl.protocol === requestUrl.protocol && originUrl.port === requestUrl.port &&
      !originUrl.username && !originUrl.password && !originUrl.pathname.replace(/^\/$/, "") &&
      !originUrl.search && !originUrl.hash;
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
