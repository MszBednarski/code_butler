import { useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import Reactions from "./Reactions";
import type { ReactionSummary, ReactionTarget } from "./Reactions";
import { chatBubbles, explainButler } from "./communication";
import type { ChatMessage } from "./communication";
import { useLatestChat } from "./latest-chat";
import VerificationMessage from "./VerificationMessage";
import type { Job } from "./workspace-types";

export type GroupMessage = {
  id: string;
  memberId: string;
  name: string;
  text: string;
  createdAt: number;
  isOwn: boolean;
  jobId?: string;
};
export type GroupAgent = {
  member: { id: string; name: string };
  messages: ChatMessage[];
  jobs: Job[];
};

export default function GroupChat({
  projectId,
  memberId,
  messages,
  reactions,
  onSend,
  onReact,
  onClose,
  agent,
  onInspect,
  onDismiss,
  onRetry,
  renderStatus,
  visibilityBusy,
  onRead,
  historyBefore,
  historyLoading,
  historyVersion,
  onHistory,
}: {
  projectId: string;
  memberId: string;
  messages: GroupMessage[];
  reactions?: ReactionSummary;
  onSend: (text: string, requestKey: string) => Promise<void>;
  onReact: (
    type: ReactionTarget,
    target: string,
    emoji: string,
    active: boolean,
  ) => Promise<void>;
  onClose: () => void;
  agent?: GroupAgent | null;
  onInspect: (job: Job) => void;
  onDismiss: (job: Job, dismissed: boolean) => void;
  onRetry: (job: Job) => void;
  renderStatus: (job: Job) => ReactNode;
  visibilityBusy: string;
  onRead: () => void;
  historyBefore?: string | null;
  historyLoading: boolean;
  historyVersion: number;
  onHistory: () => void;
}) {
  const storageKey = `butler-group-draft-${projectId}-${memberId}`;
  const [text, setText] = useState(
      () => localStorage.getItem(storageKey) || "",
    ),
    [sending, setSending] = useState(false),
    [error, setError] = useState("");
  const pending = useRef<{ text: string; key: string } | null>(null),
    scroll = useRef<HTMLDivElement>(null),
    textarea = useRef<HTMLTextAreaElement>(null),
    afterSend = useRef(false);
  const timeline = [
    ...messages.map((m) => ({ ...m, role: "user", kind: "human" })),
    ...chatBubbles(agent?.messages || []).map((m) => ({
      ...m,
      name: "@Butler",
      isOwn: false,
    })),
  ].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const latestJob = agent?.jobs.at(-1);
  const preview =
    latestJob?.state === "awaiting_approval" &&
    !latestJob.dismissedAt &&
    latestJob.artifactUrl
      ? latestJob
      : null;
  const lastRequest = new Map(
    messages.filter((m) => m.jobId).map((m) => [m.jobId, m.id]),
  );
  useLayoutEffect(() => {
    localStorage.setItem(storageKey, text);
    if (textarea.current) {
      textarea.current.style.height = "auto";
      textarea.current.style.height =
        Math.min(textarea.current.scrollHeight, 120) + "px";
    }
  }, [text, storageKey]);
  const trackScroll = useLatestChat(
    scroll,
    storageKey,
    historyVersion,
    afterSend,
  );
  useLayoutEffect(() => {
    if (scroll.current && Math.abs(scroll.current.scrollTop) < 140) onRead();
  }, [messages, agent?.messages, onRead]);
  async function send(event?: FormEvent) {
    event?.preventDefault();
    if (!text.trim() || sending) return;
    const request =
      pending.current?.text === text
        ? pending.current
        : { text, key: crypto.randomUUID() };
    pending.current = request;
    setSending(true);
    setError("");
    try {
      afterSend.current = true;
      await onSend(request.text, request.key);
      setText("");
      pending.current = null;
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setSending(false);
    }
  }
  return (
    <section className="group-chat-panel" aria-label="Group chat">
      <div className="panel-top">
        <div className="group-chat-heading">
          <strong>Group chat</strong>
          <small>
            {latestJob
              ? renderStatus(latestJob)
              : "Your team and a shared @Butler"}
          </small>
        </div>
        <button
          className="icon-button close-side-panel"
          aria-label="Hide group chat"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div
        className="conversation-scroll group-chat-scroll latest-chat"
        ref={scroll}
        role="log"
        aria-label="Team messages"
        aria-live="polite"
        aria-relevant="additions text"
        onScroll={() => {
          trackScroll();
          if (scroll.current && Math.abs(scroll.current.scrollTop) < 140)
            onRead();
        }}
      >
        <div className="conversation-history">
          {historyBefore && (
            <button
              className="text-button load-history"
              disabled={historyLoading}
              onClick={onHistory}
            >
              {historyLoading
                ? "Loading earlier messages…"
                : "Load earlier messages"}
            </button>
          )}
          {!timeline.length && (
            <div className="group-empty">
              <strong>Say hello to your team.</strong>
              <p>
                Talk to your team, or tag @Butler to give the shared agent a
                task.
              </p>
            </div>
          )}
          {timeline.map((message) => {
            const job = agent?.jobs.find((j) => j.id === message.jobId);
            const display =
              message.kind === "human"
                ? message.text
                : explainButler(message.text, message.kind);
            return (
              <article
                key={message.id}
                className={
                  "message group-message " +
                  (message.isOwn ? "message-user" : "message-teammate") +
                  (message.kind === "gemini" ? " message-kind-gemini" : "")
                }
              >
                <div className="message-content">
                  <div className="group-message-author">
                    <strong>
                      {message.kind === "gemini"
                        ? "Gemini · independent verification"
                        : message.name}
                      {message.isOwn ? " (you)" : ""}
                    </strong>
                    <time
                      dateTime={new Date(message.createdAt || 0).toISOString()}
                    >
                      {new Date(message.createdAt || 0).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                  </div>
                  {message.kind === "saved-preview" && job ? (
                    <article className="saved-preview-card">
                      <small>
                        {job.dismissedAt
                          ? "DISMISSED · SAVED HERE"
                          : "PREVIEW IN CHAT HISTORY"}
                      </small>
                      <strong>{job.prTitle || message.text}</strong>
                      <div className="artifact-card-actions">
                        {job.dismissedAt && (
                          <button
                            className="button secondary compact"
                            disabled={visibilityBusy === job.id}
                            onClick={() => onDismiss(job, false)}
                          >
                            Restore preview
                          </button>
                        )}
                        <button
                          className="text-button"
                          onClick={() => onInspect(job)}
                        >
                          View preview →
                        </button>
                      </div>
                    </article>
                  ) : message.kind === "gemini" ? (
                    <VerificationMessage text={message.text} />
                  ) : (
                    <p>{display}</p>
                  )}
                  {display !== message.text &&
                    message.kind !== "gemini" &&
                    message.kind !== "saved-preview" && (
                      <details className="developer-details">
                        <summary>Details for developers</summary>
                        <pre>{message.text}</pre>
                      </details>
                    )}
                  {job &&
                    message.kind === "human" &&
                    lastRequest.get(job.id) === message.id &&
                    renderStatus(job)}
                  {message.kind !== "saved-preview" && (
                    <Reactions
                      targetType="message"
                      targetId={message.id}
                      summary={reactions}
                      onReact={onReact}
                    />
                  )}
                </div>
              </article>
            );
          })}
          {preview && (
            <article className="artifact-card group-preview-card">
              <span className="small-label">GROUP PREVIEW · NOT PUBLISHED</span>
              <strong>
                {preview.prTitle || "Your group’s change is ready"}
              </strong>
              <p>
                {preview.canApprove
                  ? "Try it, then choose Make this the website when you’re happy."
                  : "Try it and react. The requester or team lead can approve it."}
              </p>
              <div className="artifact-card-actions">
                <button
                  className="button primary compact"
                  onClick={() => onInspect(preview)}
                >
                  Inspect preview →
                </button>
                <button
                  className="text-button dismiss-preview"
                  disabled={visibilityBusy === preview.id}
                  onClick={() => onDismiss(preview, true)}
                >
                  Dismiss
                </button>
              </div>
              <Reactions
                targetType="preview"
                targetId={preview.id}
                summary={reactions}
                onReact={onReact}
              />
            </article>
          )}
          {latestJob?.error && (
            <div className="group-send-error" role="status">
              <p>{explainButler(latestJob.error, "error")}</p>
              {latestJob.canApprove && latestJob.state === "preview_failed" && (
                <button
                  className="text-button"
                  onClick={() => onRetry(latestJob)}
                >
                  Retry preview
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      <form className="composer group-composer" onSubmit={send}>
        {error && (
          <p role="alert" className="group-send-error">
            {error}
          </p>
        )}
        <div className="composer-input">
          <textarea
            ref={textarea}
            value={text}
            placeholder="Message your team, or @Butler…"
            aria-label="Message your team"
            rows={2}
            maxLength={4000}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                event.keyCode !== 229
              ) {
                event.preventDefault();
                send();
              }
            }}
          />
          <button
            type="submit"
            className="send-button"
            aria-label="Send group message"
            disabled={sending || !text.trim()}
          >
            {sending ? "…" : "↑"}
          </button>
        </div>
        <div className="composer-note">
          <button
            type="button"
            className="text-button mention-butler"
            onClick={() => {
              setText((current) =>
                /(?:^|\s)@butler\b/i.test(current)
                  ? current
                  : `@Butler ${current}`,
              );
              textarea.current?.focus({ preventScroll: true });
            }}
          >
            @Butler <span>Give the shared agent a task</span>
          </button>
          <span>Enter sends · Shift+Enter for a new line</span>
        </div>
      </form>
    </section>
  );
}
