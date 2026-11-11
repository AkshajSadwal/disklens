const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

async function postJson({ server, route, body, signal, retries = 3 }) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    try {
      const response = await fetch(`${server}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      if (response.ok) return response.json();
      const detail = await response.text();
      const error = new Error(`Server returned ${response.status}: ${detail}`);
      error.status = response.status;
      if (!RETRYABLE.has(response.status) || attempt === retries) throw error;
      lastError = error;
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw error;
      if (error.status && !RETRYABLE.has(error.status)) throw error;
      lastError = error;
      if (attempt === retries) break;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(4000, 350 * (2 ** attempt))));
  }
  throw lastError || new Error("Upload failed after retries.");
}

export async function startScan({ server, root, scanId, signal }) {
  return postJson({ server, route: "/api/scans", body: { phase: "start", root, scanId }, signal });
}

export async function uploadScanBatch({ server, root, scanId, items, signal }) {
  return postJson({ server, route: "/api/scans", body: { phase: "batch", root, scanId, items }, signal });
}

export async function updateScanProgress({ server, root, scanId, scanned, uploaded, skipped, total, signal }) {
  return postJson({
    server, route: "/api/scans",
    body: { phase: "progress", root, scanId, scanned, uploaded, skipped, total }, signal,
    retries: 1,
  });
}

export async function completeScan({ server, root, scanId, signal }) {
  return postJson({ server, route: "/api/scans", body: { phase: "complete", root, scanId }, signal });
}

export async function abortScan({ server, root, scanId }) {
  // Use an independent short request: the caller's scan signal is already aborted.
  return postJson({ server, route: "/api/scans", body: { phase: "abort", root, scanId }, retries: 1 });
}

export async function uploadDriveMetadata({ server, drive }) {
  return postJson({ server, route: "/api/drives", body: drive, retries: 2 });
}
