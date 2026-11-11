/** Keep the development UI private to this machine unless explicitly proxied. */
export function buildFrontendDevArgs(nextExecutable, port) {
  return [nextExecutable, "dev", "-H", "127.0.0.1", "-p", String(port)];
}

/** Start a prebuilt production frontend for desktop/source installers. */
export function buildFrontendStartArgs(nextExecutable, port) {
  return [nextExecutable, "start", "-H", "127.0.0.1", "-p", String(port)];
}
