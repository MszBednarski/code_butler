import { useLayoutEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import Reactions from "./Reactions";
import type { ReactionSummary, ReactionTarget } from "./Reactions";

export type GroupMessage = {
  id: string;
  memberId: string;
  name: string;
  text: string;
  createdAt: number;
  isOwn: boolean;
};

export default function GroupChat({
  projectId,
  memberId,
  messages,
  reactions,
  onSend,
  onReact,
  onClose,
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
    opened = useRef(false),
    lastMessage = useRef(""),
    afterSend = useRef(false),
    nearBottom = useRef(true);
  useLayoutEffect(() => {
    localStorage.setItem(storageKey, text);
    if (textarea.current) {
      textarea.current.style.height = "auto";
      textarea.current.style.height =
        Math.min(textarea.current.scrollHeight, 120) + "px";
    }
  }, [text, storageKey]);
  useLayoutEffect(() => {
    const panel = scroll.current,
      latest = messages.at(-1)?.id || "";
    if (!panel || (opened.current && latest === lastMessage.current)) return;
    if (!opened.current || afterSend.current || nearBottom.current)
      panel.scrollTo({
        top: panel.scrollHeight,
        behavior: opened.current ? "smooth" : "auto",
      });
    opened.current = true;
    lastMessage.current = latest;
    afterSend.current = false;
  }, [messages]);
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
          <small>You and your teammates</small>
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
        className="conversation-scroll group-chat-scroll"
        ref={scroll}
        role="log"
        aria-label="Team messages"
        aria-live="polite"
        aria-relevant="additions text"
        onScroll={() => {
          const panel = scroll.current;
          if (panel)
            nearBottom.current =
              panel.scrollHeight - panel.scrollTop - panel.clientHeight < 140;
        }}
      >
        {!messages.length && (
          <div className="group-empty">
            <strong>Say hello to your team.</strong>
            <p>Share ideas, give feedback, and celebrate what you’ve made.</p>
          </div>
        )}
        {messages.map((message) => (
          <article
            key={message.id}
            className={
              "message group-message " +
              (message.isOwn ? "message-user" : "message-teammate")
            }
          >
            <div className="message-content">
              <div className="group-message-author">
                <strong>
                  {message.name}
                  {message.isOwn ? " (you)" : ""}
                </strong>
                <time dateTime={new Date(message.createdAt).toISOString()}>
                  {new Date(message.createdAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </div>
              <p>{message.text}</p>
              <Reactions
                targetType="message"
                targetId={message.id}
                summary={reactions}
                onReact={onReact}
              />
            </div>
          </article>
        ))}
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
            placeholder="Message your team…"
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
          <span>For everyone on this project.</span>
          <span>Enter sends · Shift+Enter for a new line</span>
        </div>
      </form>
    </section>
  );
}
