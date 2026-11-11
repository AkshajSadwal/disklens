import { readFile } from "node:fs/promises";

const packageMetadata = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
const repositoryUrl = "https://github.com/AkshajSadwal/disklens";
const latestReleaseApi = "https://api.github.com/repos/AkshajSadwal/disklens/releases/latest";

function parseStableVersion(value) {
  const match = String(value || "").trim().match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  return match ? match.slice(1).map(Number) : null;
}

export function isVersionNewer(latest, current) {
  const a = parseStableVersion(latest);
  const b = parseStableVersion(current);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return false;
}

export function registerAppRoutes(app, { fetchImpl = fetch, version = packageMetadata.version } = {}) {
  app.get("/api/app/version", async () => ({
    version,
    releasesUrl: `${repositoryUrl}/releases`,
  }));

  app.post("/api/app/update-check", async (_request, reply) => {
    let response;
    try {
      response = await fetchImpl(latestReleaseApi, {
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "DiskLens update checker",
        },
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      return reply.code(502).send({ error: "Could not reach GitHub. Check your connection and try again." });
    }

    if (response.status === 404) {
      return {
        currentVersion: version,
        latestVersion: null,
        updateAvailable: false,
        releasesUrl: `${repositoryUrl}/releases`,
        message: "No public release is available yet.",
      };
    }
    if (!response.ok) return reply.code(502).send({ error: `GitHub returned HTTP ${response.status}. Try again later.` });

    let release;
    try {
      const body = await response.text();
      if (Buffer.byteLength(body) > 256 * 1024) throw new Error("Release response is too large.");
      release = JSON.parse(body);
    } catch {
      return reply.code(502).send({ error: "GitHub returned an invalid release response." });
    }

    const latestVersion = String(release.tag_name || "").trim();
    const updateAvailable = isVersionNewer(latestVersion, version);
    if (updateAvailable === null) return reply.code(502).send({ error: "The latest release has an unsupported version tag." });
    const candidateUrl = String(release.html_url || "");
    const releasesUrl = candidateUrl.startsWith(`${repositoryUrl}/releases/tag/`) ? candidateUrl : `${repositoryUrl}/releases`;
    return {
      currentVersion: version,
      latestVersion,
      updateAvailable,
      releasesUrl,
      message: updateAvailable ? `DiskLens ${latestVersion} is available.` : "DiskLens is up to date.",
    };
  });
}
