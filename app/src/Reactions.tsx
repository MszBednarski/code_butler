import { useEffect, useRef, useState } from "react";

export type Reaction = {
  emoji: string;
  count: number;
  reacted: boolean;
  names: string[];
};
export type ReactionSummary = Record<string, Reaction[]>;
export type ReactionTarget = "message" | "preview";

const choices = [
  ["👍", "Thumbs up"],
  ["❤️", "Heart"],
  ["🔥", "Fire"],
  ["😂", "Laugh"],
  ["🎉", "Celebrate"],
  ["👀", "Eyes"],
  ["🤩", "Star eyes"],
];

export default function Reactions({
  targetType,
  targetId,
  summary,
  onReact,
}: {
  targetType: ReactionTarget;
  targetId: string;
  summary?: ReactionSummary;
  onReact: (
    targetType: ReactionTarget,
    targetId: string,
    emoji: string,
    active: boolean,
  ) => Promise<void>;
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const reactions = summary?.[targetType + ":" + targetId] || [];
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  async function react(emoji: string) {
    setBusy(true);
    try {
      await onReact(
        targetType,
        targetId,
        emoji,
        !reactions.find((r) => r.emoji === emoji)?.reacted,
      );
      setOpen(false);
    } catch {
      /* The workspace displays request errors. */
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="reactions"
      ref={root}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      {reactions.map((reaction) => {
        const label =
          choices.find(([emoji]) => emoji === reaction.emoji)?.[1] ||
          reaction.emoji;
        return (
          <button
            key={reaction.emoji}
            className="reaction-count"
            disabled={busy}
            aria-label={`${label} reaction, ${reaction.count}`}
            aria-pressed={reaction.reacted}
            title={reaction.names.join(", ")}
            onClick={() => react(reaction.emoji)}
          >
            <span>{reaction.emoji}</span>
            <span>{reaction.count}</span>
          </button>
        );
      })}
      <button
        className="reaction-add"
        aria-label={`React to this ${targetType}`}
        aria-expanded={open}
        title={`React to this ${targetType}`}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">☺</span>
        <span>React</span>
      </button>
      {open && (
        <div
          className="emoji-picker"
          role="group"
          aria-label="Choose emoji reaction"
        >
          {choices.map(([emoji, label]) => (
            <button
              key={emoji}
              disabled={busy}
              aria-label={`${label} reaction`}
              aria-pressed={Boolean(
                reactions.find((r) => r.emoji === emoji)?.reacted,
              )}
              onClick={() => react(emoji)}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
