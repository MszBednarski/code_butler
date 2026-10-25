export type VerificationUpdate = {
  phase?: string;
  summary: string;
  details?: string;
  model?: string;
  sample?: boolean;
};

export default function VerificationMessage({ text }: { text: string }) {
  let update: VerificationUpdate = { summary: text };
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed.summary === "string") update = parsed;
  } catch {}
  const label =
    update.sample
      ? "Sample · not run"
      : update.phase === "passed"
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
        <strong>{update.sample ? "Sample Gemini verification" : "Gemini 4 Argon"}</strong>
        <span className={`gemini-verdict gemini-${update.sample ? "sample" : update.phase || "check"}`}>
          {label}
        </span>
      </div>
      {update.sample && <p className="gemini-sample-notice">Illustrative example. Gemini did not run these checks.</p>}
      <p>{update.summary}</p>
      {update.details && (
        <details className="gemini-details">
          <summary>{update.sample ? "See example checks" : "See Gemini’s checks"}</summary>
          <pre>{update.details}</pre>
        </details>
      )}
    </div>
  );
}
