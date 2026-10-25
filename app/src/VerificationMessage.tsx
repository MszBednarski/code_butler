export type VerificationUpdate = {
  phase?: string;
  summary: string;
  details?: string;
  model?: string;
};

export default function VerificationMessage({ text }: { text: string }) {
  let update: VerificationUpdate = { summary: text };
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed.summary === "string") update = parsed;
  } catch {}
  const label =
    update.phase === "passed"
      ? "Passed"
      : update.phase === "blocked"
        ? "Needs a fix"
        : update.phase === "error"
          ? "Verification paused"
          : update.phase === "plan"
            ? "Verification plan"
            : "Checking your change";
  return (
    <div className="gemini-verification">
      <div className="gemini-verification-heading">
        <span aria-hidden="true">✧</span>
        <strong>Gemini 4 Argon</strong>
        <span className={`gemini-verdict gemini-${update.phase || "check"}`}>
          {label}
        </span>
      </div>
      <p>{update.summary}</p>
      {update.details && (
        <details className="gemini-details">
          <summary>See Gemini’s checks</summary>
          <pre>{update.details}</pre>
        </details>
      )}
    </div>
  );
}
