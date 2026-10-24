export type ChatMessage = {
  id: string;
  jobId: string;
  role: string;
  text: string;
  kind?: string;
  createdAt?: number;
  authorName?: string;
  authorRole?: string;
};

// Several internal steps can have the same plain-English explanation. Display
// one bubble for adjacent repeats in a request, keeping every distinct diagnostic.
export function chatBubbles<T extends ChatMessage>(messages: T[]) {
  const bubbles: (T & { diagnostics: string[] })[] = [];
  for (const message of messages) {
    const last = bubbles.at(-1);
    if (
      message.role === "assistant" &&
      last?.role === "assistant" &&
      message.kind !== "saved-preview" &&
      last.kind !== "saved-preview" &&
      last.jobId === message.jobId &&
      (!(last.kind === "agent" || message.kind === "agent") ||
        last.text.trim() === message.text.trim()) &&
      explainButler(last.text, last.kind) ===
        explainButler(message.text, message.kind)
    ) {
      if (!last.diagnostics.includes(message.text))
        last.diagnostics.push(message.text);
    } else bubbles.push({ ...message, diagnostics: [message.text] });
  }
  return bubbles;
}

// Older conversations keep their original diagnostic text. Present an explanation
// first, while retaining those diagnostics for people who choose developer details.
export function explainButler(text: string, kind = "message") {
  const raw = text.trim();
  if (!raw) return raw;
  const issue =
    kind === "error" ||
    /review blocked|review paused|\[P[0-3]\]|could not|couldn.t|does not|doesn.t|cannot|can.t|failed|failure|not work|absent|unresolved|needs (?:an? |to )|need.*fix|broken|missing/i.test(
      raw,
    );
  if (
    /no changes against|identical tree|requested .* (?:are absent|haven.t been)|contains no changes/i.test(
      raw,
    )
  )
    return `Your changes haven’t been added yet. ${/starter|placeholder/i.test(raw) ? "The preview still shows the starter page." : "The preview still matches the current website."} Ask Butler to finish your request.`;
  if (/repository creation failed|could not create.*repo/i.test(raw))
    return "Butler couldn’t create your project files. Try again, or check your GitHub connection.";
  if (/Boat build stopped|couldn.t finish the preview build/i.test(raw))
    return "Butler couldn’t prepare this preview. Your work is saved. Try preparing it again.";
  if (
    issue &&
    /bwrap|namespace|CODEX_HOME|command sandbox|reviewer.*(?:runtime|process)|could not start.*sandbox/i.test(
      raw,
    )
  )
    return "Butler couldn’t start its website checks. Your work is saved. Ask your team lead to update the workspace.";
  if (/automatic repairs.*limit|repair limit reached/i.test(raw))
    return "Butler tried to fix this, but needs more guidance. Tell it what still looks wrong or ask your team lead for help.";
  if (/reviewer found issues|sending them back.*automatic fix/i.test(raw))
    return "Butler found a problem and is trying to fix it before publishing. Your current website stays as it is.";
  if (
    issue &&
    /unresolved conflicts|merge conflicts?|conflicting changes|conflicts with|cannot.*merge|can.t.*merge/i.test(
      raw,
    ) &&
    !/\b(?:no|without|resolved|free of) (?:merge )?conflicts?\b/i.test(raw)
  )
    return "Two changes overlap. Butler needs to combine them before this can go on the website. Your work is saved.";
  if (
    /proposed merge.*(?:does not|did not|fail|broken)|app checks failed|compilation.*fail|typecheck.*fail|build.*(?:stopped|failed|did not pass)/i.test(
      raw,
    )
  )
    return "This change didn’t pass the website checks, so it hasn’t been published. Ask Butler to fix it and try again.";
  if (/usage limit|rate limit|quota|429|account or usage limit/i.test(raw))
    return "Codex has reached its usage limit. Your work is saved. Wait for the limit to reset, or ask your team lead to check the account.";
  if (
    /Codex.*(?:reconnect|authentication|unauthorized)|(?:401|expired).*(?:Codex|subscription)/i.test(
      raw,
    )
  )
    return "Codex needs you to sign in again. Ask your team lead to reconnect it. Your work is saved.";
  if (/EAI_AGAIN|ECONNRESET|ENOTFOUND|ETIMEDOUT|fetch failed/i.test(raw))
    return "The connection was interrupted. Your work is saved. Try again in a moment.";
  if (/review passed for PR|app checks passed and preview is live/i.test(raw))
    return "Your change passed the website checks. Butler is getting it ready to publish.";
  if (
    /^Reviewing PR #|code inspection passed|running the app checks|code review and compilation/i.test(
      raw,
    )
  )
    return "Checking that your changes work with the current website.";
  if (
    /^PR #\d+ is open|sent it for review|pull request for review|creating the pull request|opening.*pull request|preparing the pull request/i.test(
      raw,
    )
  )
    return "Your change is ready for its final checks. Butler will publish it once those pass.";
  if (/^Preview ready:|preview is ready.*pull request/i.test(raw))
    return "Your preview is ready. Try it here, then choose Make this the website when you’re happy with it.";
  if (/^PR #\d+ merged|^Merged |has been merged|was merged/i.test(raw))
    return /your change is live/i.test(raw)
      ? "Your change is on the website. Everyone can see it now."
      : "Your change has passed its checks. Butler is updating the shared website.";
  if (
    issue &&
    /onClick|pointerdown|keyboard control.*handler|preventDefault/i.test(raw)
  )
    return "Some controls don’t work properly with a keyboard. Ask Butler to fix them before publishing.";
  if (/app checks passed.*preparing.*preview/i.test(raw))
    return "Your change passed its checks. Butler is preparing a preview for you to try.";
  if (/review.*(?:paused|could not|retry|safely)/i.test(raw))
    return "Butler’s website checks paused. Your work is saved, and it will try again.";

  const technical =
    /\b(?:PR|SHA|commits?|branches?|repo(?:sitory)?|worker|sandbox|npm|git|diff|deploy(?:ment)?|artifact|typecheck|build)\b|\b[a-f0-9]{12,40}\b|\[P[0-3]\]|(?:app|src)\/[\w./-]+|```/i.test(
      raw,
    );
  const summary = raw
    .replace(/^Review (?:blocked|paused)(?: for PR #\d+)?[:.]\s*/i, "")
    .split(/\n\s*\n|\n\[P[0-3]\]/)[0]
    .trim();
  if (
    summary &&
    summary !== raw &&
    !/\b(?:PR|SHA|commit|branch|repo|worker|sandbox|npm|git|diff|deploy|artifact|typecheck|build)\b|[a-f0-9]{12,40}|(?:app|src)\/|\[P[0-3]\]|```/i.test(
      summary,
    )
  )
    return summary;
  if (!technical) return raw;
  if (
    /preview.*(?:fail|could not|did not|has not)|artifact.*(?:fail|did not)/i.test(
      raw,
    )
  )
    return "Butler couldn’t prepare this preview. Your work is saved. Try preparing it again.";
  if (
    /deploy|publish/i.test(raw) &&
    /fail|could not|did not|has not|stopped/i.test(raw)
  )
    return "The website hasn’t updated yet. Your changes are saved. Try publishing again.";
  if (/review.*(?:paused|could not|retry|safely)/i.test(raw))
    return "Butler’s website checks paused. Your work is saved, and it will try again.";
  if (/preserved|saved|restart|resum/i.test(raw))
    return "Your work is saved. Ask Butler to continue from where it left off.";
  return kind === "error" || kind === "review"
    ? "Butler found a problem that needs fixing before this change can go live. Ask it to fix the change."
    : "Butler is working on your website. You’ll see the result here when it’s ready.";
}
