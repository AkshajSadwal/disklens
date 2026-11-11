import cors from "@fastify/cors";

export const DEFAULT_DISKLENS_WEB_ORIGIN = "http://127.0.0.1:3000";

function normalizedLoopbackOrigin(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash) return null;
    const hostname = url.hostname.toLowerCase();
    if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function isAllowedDiskLensOrigin(origin, configuredOrigin = DEFAULT_DISKLENS_WEB_ORIGIN) {
  // Requests from local scripts and the collector do not carry a browser Origin.
  if (origin == null || origin === "") return true;
  const requestOrigin = normalizedLoopbackOrigin(origin);
  const allowedOrigin = normalizedLoopbackOrigin(configuredOrigin) || DEFAULT_DISKLENS_WEB_ORIGIN;
  return requestOrigin !== null && requestOrigin === allowedOrigin;
}

/** Restrict browser access to the UI instance launched alongside this API. */
export async function installDiskLensOriginPolicy(app, configuredOrigin = process.env.DISKLENS_WEB_ORIGIN) {
  const allowedOrigin = normalizedLoopbackOrigin(configuredOrigin) || DEFAULT_DISKLENS_WEB_ORIGIN;
  const isAllowed = (origin) => isAllowedDiskLensOrigin(origin, allowedOrigin);

  await app.register(cors, {
    origin(origin, callback) {
      callback(null, isAllowed(origin));
    },
  });

  // CORS alone only controls whether a browser can read a response. Reject an
  // untrusted Origin at the API too, before any route can perform mutations.
  app.addHook("onRequest", (request, reply, done) => {
    const origin = request.headers.origin;
    if (origin && !isAllowed(origin)) {
      reply.code(403).send({
        code: "UNTRUSTED_ORIGIN",
        error: "This local API accepts browser requests only from the DiskLens UI.",
      });
      return;
    }
    done();
  });
}
