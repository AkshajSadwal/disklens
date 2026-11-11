"use client";

import { useEffect, useState } from "react";
import { API } from "../../lib/api";

const defaults = {
  provider: "local-rules",
  model: "",
  endpoint: "",
  keyConfigured: false,
  localFallback: true,
  maxResponseTokens: 800,
  requestBudget: 30,
  lastProvider: "",
};

export default function AISettingsPanel() {
  const [settings, setSettings] = useState(defaults);
  const [apiKey, setApiKey] = useState("");
  const [localEncryptionPassphrase, setLocalEncryptionPassphrase] = useState("");
  const [unlockPassphrase, setUnlockPassphrase] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function loadSettings() {
    setLoading(true);
    try {
      const response = await fetch(`${API}/api/ai/settings`);
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || "Could not load AI settings.");
      setSettings({ ...defaults, ...data });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadSettings(); }, []);

  function update(field, value) {
    setSettings((current) => ({ ...current, [field]: value }));
  }

  async function submitJson(url, method, body) {
    const response = await fetch(`${API}${url}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(data?.error || `Request failed (${response.status}).`);
      error.code = data?.code;
      throw error;
    }
    return data;
  }

  async function save() {
    setBusy("save"); setError(""); setMessage("");
    try {
      const saved = await submitJson("/api/ai/settings", "PUT", { ...settings, apiKey, localEncryptionPassphrase });
      setSettings({ ...defaults, ...saved });
      setApiKey("");
      setLocalEncryptionPassphrase("");
      setMessage(saved.credentialStorage === "encrypted-local"
        ? "Configuration saved with a locally encrypted credential. Unlock it again after a server restart or after 15 minutes."
        : "Configuration saved. The key remains in the operating system credential store or protected environment.");
    } catch (err) {
      if (err.code === "LOCAL_PASSPHRASE_REQUIRED") setError(`${err.message} Enter a local encryption passphrase below and save again.`);
      else setError(err.message);
    }
    finally { setBusy(""); }
  }

  async function unlock() {
    setBusy("unlock"); setError(""); setMessage("");
    try {
      await submitJson("/api/ai/settings/unlock", "POST", { passphrase: unlockPassphrase });
      setUnlockPassphrase("");
      await loadSettings();
      setMessage("Local credential unlocked for 15 minutes.");
    } catch (err) { setError(err.message); }
    finally { setBusy(""); }
  }

  async function testConnection() {
    setBusy("test"); setError(""); setMessage("");
    try {
      const result = await submitJson("/api/ai/settings/test", "POST", {
        provider: settings.provider, endpoint: settings.endpoint, apiKey,
      });
      setMessage(result.message);
    } catch (err) { setError(err.message); }
    finally { setBusy(""); }
  }

  async function removeConfiguration() {
    setBusy("remove"); setError(""); setMessage("");
    try {
      const next = await submitJson("/api/ai/settings", "DELETE");
      setSettings({ ...defaults, ...next });
      setApiKey("");
      setMessage("Saved provider configuration and credential removed.");
    } catch (err) { setError(err.message); }
    finally { setBusy(""); }
  }

  return (
    <section className="dl-settings-card" aria-labelledby="ai-settings-title">
      <header className="dl-settings-head">
        <div>
          <div className="dl-eyebrow">LOCAL PREFERENCES</div>
          <h2 id="ai-settings-title">AI provider</h2>
          <p>Local rules work offline. Hosted requests happen only after you start an AI analysis.</p>
        </div>
        <span className="dl-settings-badge">{settings.credentialStorage === "encrypted-local" ? (settings.keyUnlocked ? "Local key unlocked" : "Local key locked") : settings.keyConfigured ? "Credential saved" : "No hosted key"}</span>
      </header>

      {loading ? <div className="dl-settings-loading" role="status">Loading saved settings…</div> : (
        <div className="dl-settings-form">
          <label className="dl-settings-field">
            <span>Default provider</span>
            <select value={settings.provider} onChange={(event) => update("provider", event.target.value)}>
              <option value="local-rules">Local rules (offline)</option>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
              <option value="azure-openai">Azure OpenAI</option>
              <option value="compatible">OpenAI compatible</option>
            </select>
          </label>

          {settings.provider !== "local-rules" && <>
            <label className="dl-settings-field">
              <span>{settings.provider === "azure-openai" ? "Deployment name" : "Model name"}</span>
              <input value={settings.model} onChange={(event) => update("model", event.target.value)} placeholder={settings.provider === "anthropic" ? "claude-sonnet-4-20250514" : settings.provider === "azure-openai" ? "your-deployment-name" : "gpt-4.1-mini"} autoComplete="off" />
            </label>
            <label className="dl-settings-field">
              <span>Local encryption passphrase (optional)</span>
              <input type="password" value={localEncryptionPassphrase} onChange={(event) => setLocalEncryptionPassphrase(event.target.value)} autoComplete="new-password" minLength={12} placeholder="At least 12 characters" />
              <small>Used only if entered. The key is encrypted locally with scrypt and AES-256-GCM; the passphrase is never saved. You must unlock again after a server restart or 15 minutes.</small>
            </label>
            {settings.credentialStorage === "encrypted-local" && !settings.keyUnlocked && <div className="dl-settings-field">
              <span>Unlock saved local credential</span>
              <div className="dl-settings-row">
                <input type="password" value={unlockPassphrase} onChange={(event) => setUnlockPassphrase(event.target.value)} autoComplete="current-password" placeholder="Local encryption passphrase" />
                <button type="button" onClick={unlock} disabled={Boolean(busy) || !unlockPassphrase}>{busy === "unlock" ? "Unlocking…" : "Unlock"}</button>
              </div>
            </div>}
            {(settings.provider === "compatible" || settings.provider === "openai" || settings.provider === "azure-openai") && <label className="dl-settings-field">
              <span>{settings.provider === "compatible" ? "Base URL" : settings.provider === "azure-openai" ? "Azure OpenAI endpoint" : "Custom endpoint (optional)"}</span>
              <input value={settings.endpoint} onChange={(event) => update("endpoint", event.target.value)} placeholder={settings.provider === "compatible" ? "http://localhost:11434/v1" : settings.provider === "azure-openai" ? "https://your-resource.openai.azure.com" : "https://api.openai.com/v1"} autoComplete="url" />
              {settings.provider === "azure-openai" && <small>Uses Azure OpenAI v1. The v1 API infers its version; no api-version query is needed.</small>}
            </label>}
            <label className="dl-settings-field">
              <span>API key {settings.keyConfigured ? "(leave blank to keep saved key)" : ""}</span>
              <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="new-password" placeholder={settings.keyConfigured ? "Saved securely" : "Paste provider key"} />
            </label>
          </>}

          <div className="dl-settings-row">
            <label className="dl-settings-field">
              <span>Maximum response tokens</span>
              <input type="number" min="64" max="4096" value={settings.maxResponseTokens} onChange={(event) => update("maxResponseTokens", event.target.value)} />
            </label>
            <label className="dl-settings-field">
              <span>Daily request budget</span>
              <input type="number" min="1" max="500" value={settings.requestBudget} onChange={(event) => update("requestBudget", event.target.value)} />
            </label>
          </div>

          <label className="dl-settings-toggle">
            <input type="checkbox" checked={settings.localFallback} onChange={(event) => update("localFallback", event.target.checked)} />
            <span><strong>Use local rules if the provider fails</strong><small>Hosted input is limited to the selected metadata summary. Local fallback sends no data outside this device.</small></span>
          </label>

          <div className="dl-settings-actions">
            <button type="button" onClick={save} disabled={Boolean(busy) || loading}>{busy === "save" ? "Saving…" : "Save configuration"}</button>
            <button type="button" onClick={testConnection} disabled={Boolean(busy) || loading || settings.provider === "local-rules"}>{busy === "test" ? "Testing…" : "Test connection"}</button>
            <button type="button" className="subtle" onClick={removeConfiguration} disabled={Boolean(busy) || loading}>{busy === "remove" ? "Removing…" : "Remove configuration"}</button>
          </div>
          <div className="dl-settings-note">Test Connection checks provider authentication with a models-list request. It sends no indexed data and does not generate a response.</div>
          {settings.lastProvider && <div className="dl-settings-note">Last analysis handled by: <strong>{settings.lastProvider}</strong></div>}
        </div>
      )}
      {message && <div className="dl-settings-message" role="status">{message}</div>}
      {error && <div className="dl-settings-error" role="alert">{error}</div>}
    </section>
  );
}
