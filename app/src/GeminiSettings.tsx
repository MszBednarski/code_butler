import { useState, useRef, useEffect } from "react";

export default function GeminiSettings() {
  const [open, setOpen] = useState(false),
    [apiKey, setKey] = useState(""),
    [connected, setConnected] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const close = () => {
    setOpen(false);
    setKey("");
  };
  useEffect(() => {
    if (open) dialog.current?.showModal();
  }, [open]);
  async function request(body?: object) {
    const response = await fetch("/api/settings/verification", {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const value = await response.json();
    if (!response.ok) throw Error(value.error || "Couldn’t save Gemini.");
    setConnected(value.connected);
    return value;
  }
  async function show() {
    setOpen(true);
    setError("");
    try {
      await request();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function save(disconnect = false) {
    setBusy(true);
    setError("");
    try {
      await request(disconnect ? { disconnect: true } : { apiKey });
      setKey("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        className="button ghost compact gemini-settings-button"
        aria-label="Gemini checks"
        onClick={show}
      >
        ✧ <span>Gemini checks</span>
      </button>
      {open && (
        <dialog
          className="modal gemini-settings-modal"
          ref={dialog}
          aria-labelledby="gemini-settings-title"
          onCancel={close}
          onClick={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <button
            className="icon-button modal-close"
            aria-label="Close Gemini settings"
            onClick={close}
          >
            ×
          </button>
          <h2 id="gemini-settings-title">A second pair of eyes.</h2>
          <p>
            Optionally connect Gemini 4 Argon to check your changes
            independently. It shows its plan, real website checks and findings
            in the chat.
          </p>
          <p className="quiet-note">
            Saved to your account, including your existing projects. Your
            requests use your key; projects you lead can use it for team
            reviews. Without a key, Butler keeps its current checks.
          </p>
          {error && <p role="alert">{error}</p>}
          {connected ? (
            <>
              <p className="inline-status">
                ✓ Gemini verification connected. It will run on the next review.
              </p>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => save(true)}
              >
                Disconnect Gemini
              </button>
            </>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                save();
              }}
            >
              <label htmlFor="gemini-api-key">Your Gemini API key</label>
              <input
                id="gemini-api-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setKey(e.target.value)}
                required
                maxLength={256}
              />
              <p className="quiet-note">
                Encrypted on Butler’s server. It stays out of your code and your
                team’s agents. Gemini usage is billed to your Google account.{" "}
                <a
                  href="https://aistudio.google.com/api-keys"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Get a key in Google AI Studio ↗
                </a>
              </p>
              <button
                className="button primary full"
                disabled={busy || !apiKey.trim()}
              >
                {busy ? "Saving…" : "Connect Gemini verification"}
              </button>
            </form>
          )}
        </dialog>
      )}
    </>
  );
}
