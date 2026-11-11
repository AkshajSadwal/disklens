import { canonicalScanPath } from "./scanPaths.mjs";

/** Classifies each requested root at the end of a collector process. */
export function classifyScanJobRoots(job, exitCode, spawnFailed = false, platform = process.platform) {
  const currentKey = canonicalScanPath(job.currentRoot || job.roots[0], platform);
  const completedKeys = new Set([...job.completedRoots].map((root) => canonicalScanPath(root, platform)));

  return job.roots.map((root) => {
    const key = canonicalScanPath(root, platform);
    const wasCompleted = completedKeys.has(key);
    const status = wasCompleted ? "completed"
      : job.cancelRequested ? "aborted"
      : spawnFailed ? (key === currentKey ? "failed" : "interrupted")
      : exitCode === 0 ? "completed"
      : key === currentKey ? "failed" : "interrupted";
    return { root, status, startedAt: job.startedAt, jobId: job.id };
  });
}
