"use client";

import { useEffect, useState } from "react";
import { API } from "../../lib/api";

export default function UpdateCheckPanel() {
  const [version, setVersion] = useState("");
  const [releasesUrl, setReleasesUrl] = useState("https://github.com/AkshajSadwal/disklens/releases");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    fetch(`${API}/api/app/version`).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || "Could not load the installed version.");
      if (active) { setVersion(data.version || ""); setReleasesUrl(data.releasesUrl || releasesUrl); }
    }).catch((err) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, []);

  async function checkForUpdates() {
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch(`${API}/api/app/update-check`, { method: "POST" });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || `Update check failed (${response.status}).`);
      setVersion(data.currentVersion || version);
      setReleasesUrl(data.releasesUrl || releasesUrl);
      setMessage(data.message || "Release check completed.");
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  return (
    <section className="dl-settings-card" aria-labelledby="update-check-title">
      <header className="dl-settings-head">
        <div>
          <div className="dl-eyebrow">RELEASES</div>
          <h2 id="update-check-title">DiskLens updates</h2>
          <p>Installed version {version || "loading…"}. Check GitHub for a newer stable release.</p>
        </div>
      </header>
      <div className="dl-settings-form">
        <div className="dl-settings-actions">
          <button type="button" onClick={checkForUpdates} disabled={busy || !version}>{busy ? "Checking…" : "Check for updates"}</button>
          <a className="dl-settings-release-link" href={releasesUrl} target="_blank" rel="noreferrer">Open releases page</a>
        </div>
        <div className="dl-settings-note">The check contacts GitHub only when you press the button. DiskLens does not download or install updates automatically.</div>
        {message && <div className="dl-settings-message" role="status">{message}</div>}
        {error && <div className="dl-settings-error" role="alert">{error}</div>}
      </div>
    </section>
  );
}
