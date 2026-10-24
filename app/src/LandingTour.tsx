import { useState } from "react";

import { horseDemoWebsite } from "./horse-demo";
import Reactions from "./Reactions";
import type { ReactionSummary, ReactionTarget } from "./Reactions";

export default function LandingTour() {
  const [panel, setPanel] = useState(() =>
      new URLSearchParams(location.search).get("demo") === "invite"
        ? "invite"
        : "website",
    ),
    [person, setPerson] = useState("Maya"),
    [draft, setDraft] = useState(true),
    [dismissed, setDismissed] = useState(false),
    [saved, setSaved] = useState(false),
    [published, setPublished] = useState(false),
    [preview, setPreview] = useState(false),
    [refresh, setRefresh] = useState(0),
    [copied, setCopied] = useState(false),
    [reactions, setReactions] = useState<ReactionSummary>({
      "message:Maya": [
        { emoji: "🔥", count: 2, reacted: false, names: ["Sam", "You (demo)"] },
      ],
      "message:Sam": [
        { emoji: "👍", count: 1, reacted: false, names: ["Maya"] },
      ],
      "message:group": [
        { emoji: "❤️", count: 2, reacted: false, names: ["Maya", "Sam"] },
      ],
      "preview:jumps": [
        { emoji: "🎉", count: 2, reacted: false, names: ["Maya", "Sam"] },
      ],
    });
  async function react(
    type: ReactionTarget,
    id: string,
    emoji: string,
    active: boolean,
  ) {
    setReactions((current) => {
      const key = type + ":" + id;
      const items = [...(current[key] || [])];
      const previous = items.find((item) => item.emoji === emoji);
      if (Boolean(previous?.reacted) === active) return current;
      const count = (previous?.count || 0) + (active ? 1 : -1);
      const names = (previous?.names || []).filter((name) => name !== "You");
      if (active) names.push("You");
      return {
        ...current,
        [key]: [
          ...items.filter((item) => item.emoji !== emoji),
          ...(count ? [{ emoji, count, reacted: active, names }] : []),
        ],
      };
    });
  }
  function requestChange() {
    setDraft(true);
    setDismissed(false);
    setPreview(true);
    setPanel("website");
  }
  async function copyDemo() {
    try {
      await navigator.clipboard.writeText(
        location.origin + "/?demo=invite#try-butler",
      );
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <section
      id="try-butler"
      className="landing-tour"
      aria-label="Butler product demo"
    >
      <div className="tour-top">
        <span className="tour-project-mark">✳</span>
        <div>
          <strong>Jump Club</strong>
          <small>A sample project · no live AI</small>
        </div>
        <span className="tour-demo-tag">PRODUCT DEMO</span>
      </div>
      <div className="tour-nav" role="tablist" aria-label="Demo workspace">
        {[
          ["website", "Website"],
          ["chat", "Team chats"],
          ["group", "Group chat"],
          ["invite", "Invite"],
        ].map(([value, label]) => (
          <button
            key={value}
            role="tab"
            aria-selected={panel === value}
            onClick={() => setPanel(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {panel === "website" && (
        <div className="tour-website">
          <div className="tour-version-bar">
            <div role="tablist" aria-label="Demo website version">
              <button
                role="tab"
                aria-selected={!preview}
                onClick={() => setPreview(false)}
              >
                Current website
              </button>
              <button
                role="tab"
                aria-selected={preview}
                disabled={!draft || dismissed}
                onClick={() => setPreview(true)}
              >
                Change preview
              </button>
            </div>
            <button
              className="tour-refresh"
              aria-label="Refresh demo website"
              onClick={() => setRefresh((value) => value + 1)}
              title="Refresh website"
            >
              ↻
            </button>
          </div>
          <div className={"tour-context" + (preview ? " tour-is-preview" : "")}>
            <strong>{preview ? "Change preview" : "Current website"}</strong>
            <span>{preview ? "NOT PUBLISHED" : "LIVE DEMO"}</span>
          </div>
          <iframe
            key={`${preview}:${published}:${refresh}`}
            srcDoc={horseDemoWebsite(preview || published)}
            title={
              preview
                ? "Butler demo — change preview"
                : "Butler demo — current website"
            }
            sandbox="allow-scripts"
          />
          {preview && (
            <div className="tour-preview-reactions">
              <Reactions
                targetType="preview"
                targetId="jumps"
                summary={reactions}
                onReact={react}
              />
            </div>
          )}
          <div className="tour-next" aria-live="polite">
            {preview ? (
              <>
                <p>
                  The colourful jumps are ready. Try a round, then make them
                  live.
                </p>
                <button
                  className="button primary compact"
                  onClick={() => {
                    setPublished(true);
                    setDraft(false);
                    setPreview(false);
                  }}
                >
                  Apply change in demo <span>→</span>
                </button>
              </>
            ) : published ? (
              <>
                <p>
                  <strong>That’s it. Your whole team sees the change.</strong>{" "}
                  This is a demo. Connect your accounts to make something with
                  your team.
                </p>
                <button
                  className="text-button"
                  onClick={() => setPanel("invite")}
                >
                  Next: invite your people →
                </button>
              </>
            ) : (
              <>
                <p>
                  A sample website and conversation. Connect your accounts to
                  build your own.
                </p>
                <button
                  className="button primary compact"
                  onClick={() => setPanel("chat")}
                >
                  See a sample conversation <span>→</span>
                </button>
              </>
            )}
          </div>
        </div>
      )}
      {panel === "chat" && (
        <div className="tour-chat-panel">
          <div
            className="tour-chat-people"
            role="tablist"
            aria-label="Demo team chats"
          >
            {["Maya", "Sam"].map((name) => (
              <button
                role="tab"
                aria-selected={person === name}
                aria-label={`${name}’s chat`}
                key={name}
                onClick={() => setPerson(name)}
              >
                <span
                  className={"tour-avatar tour-person-" + name.toLowerCase()}
                >
                  {name[0]}
                </span>
                {name}’s chat
              </button>
            ))}
          </div>
          <p className="tour-chat-note">
            Follow your team’s agents. React to ideas before they go live.
          </p>
          <div className="tour-message tour-from-user">
            <small>{person}</small>
            <p>
              {person === "Maya"
                ? "Can the horse jump colourful showjumping fences?"
                : "Can we make this easy to use on a phone?"}
            </p>
            <Reactions
              targetType="message"
              targetId={person}
              summary={reactions}
              onReact={react}
            />
          </div>
          <div className="tour-message tour-from-butler">
            <small>✳ Butler</small>
            <p>
              {person === "Maya"
                ? draft
                  ? "The new jumps are ready. Play the preview, then tell me when to add them to the game."
                  : "Absolutely. I’ll add colourful poles and little flags. You can play a round before everyone sees the change."
                : "I’m making it work with a tap on your phone or Space on your keyboard. You can keep chatting while I work."}
            </p>
            <span className="tour-chat-progress">
              {person === "Maya" && draft
                ? "Ready to try"
                : "Making your changes · 12s"}
            </span>
          </div>
          {draft && !dismissed && (
            <article className="artifact-card tour-proposal">
              <span className="small-label">PREVIEW READY · NOT PUBLISHED</span>
              <strong>Add colourful jumps to Jump Club</strong>
              <p>
                Try it here. The team lead can approve a teammate’s preview too.
              </p>
              <div className="artifact-card-actions">
                <button
                  className="button primary compact"
                  onClick={requestChange}
                >
                  Inspect preview →
                </button>
                <button
                  className="text-button dismiss-preview"
                  onClick={() => {
                    setDismissed(true);
                    setSaved(true);
                    setPreview(false);
                  }}
                >
                  Dismiss
                </button>
              </div>
              <Reactions
                targetType="preview"
                targetId="jumps"
                summary={reactions}
                onReact={react}
              />
            </article>
          )}
          {saved && (
            <article className="saved-preview-card tour-saved-preview">
              <small className="small-label">
                {dismissed
                  ? "DISMISSED · SAVED HERE"
                  : "PREVIEW IN CHAT HISTORY"}
              </small>
              <strong>Add colourful jumps to Jump Club</strong>
              <p>Changed your mind? Your preview stays in chat history.</p>
              {dismissed && (
                <button
                  className="button secondary compact"
                  onClick={() => setDismissed(false)}
                >
                  Restore preview
                </button>
              )}
            </article>
          )}
          <div className="tour-chat-composer">
            <span>Sample conversation · no live AI is running.</span>
            {!dismissed && (
              <button className="text-button" onClick={requestChange}>
                {draft ? "View the sample preview" : "See the sample preview"} →
              </button>
            )}
          </div>
        </div>
      )}
      {panel === "group" && (
        <div className="tour-chat-panel">
          <p className="tour-chat-note">
            A place for your people, alongside their agents.
          </p>
          <div className="tour-message tour-from-butler">
            <small>Maya</small>
            <p>The new jumps are in my preview. What do you think?</p>
          </div>
          <div className="tour-message tour-from-butler">
            <small>Sam</small>
            <p>Love them! Let’s try it on our phones before we make it live.</p>
            <Reactions
              targetType="message"
              targetId="group"
              summary={reactions}
              onReact={react}
            />
          </div>
          <div className="tour-message tour-from-user">
            <small>You · team lead</small>
            <p>
              Looking good. I’ll inspect the preview and approve it for
              everyone.
            </p>
          </div>
          <div className="tour-chat-composer">
            <span>
              Sample group chat. Humans talking to humans; agents keep working.
            </span>
            <button
              className="button primary compact"
              onClick={() => setPanel("chat")}
            >
              See what the team is making →
            </button>
          </div>
        </div>
      )}
      {panel === "invite" && (
        <div className="tour-invite-panel">
          <span className="eyebrow">NO SETUP FOR EVERYONE ELSE</span>
          <h3>Scan. Join. Make something.</h3>
          <p>
            Share one link or QR code. Your teammates open it, enter their name,
            and start creating from their phone or laptop.
          </p>
          <img
            src="/demo-invite.svg"
            alt="QR code to open this public Butler demo"
            width="144"
            height="144"
          />
          <button className="button primary compact" onClick={copyDemo}>
            {copied ? "Demo link copied" : "Copy demo invite link"}{" "}
            <span>↗</span>
          </button>
          <small>
            This QR opens the demo. Your real project gets its own team
            invitation.
          </small>
        </div>
      )}
      <div className="tour-bottom">
        <span className="tour-mini-avatars">
          <i>M</i>
          <i>S</i>
          <i>Y</i>
        </span>
        <span>Different people. One shared creation.</span>
      </div>
    </section>
  );
}
