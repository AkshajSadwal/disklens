export async function uploadScanBatch({ server, root, scanId, replace, items }) {
  const response = await fetch(`${server}/api/scans`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      root,
      scanId,
      replace,
      items,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Server returned ${response.status}: ${await response.text()}`,
    );
  }

  return response.json();
}


export async function uploadDriveMetadata({ server, drive }) {
  const response = await fetch(`${server}/api/drives`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(drive),
  });

  if (!response.ok) {
    throw new Error(`Drive metadata upload failed: ${response.status}: ${await response.text()}`);
  }

  return response.json();
}
