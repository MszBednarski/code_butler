import { useState } from "react";

import { horseDemoWebsite } from "./horse-demo";

export default function LandingTour() {
  const [panel, setPanel] = useState(() =>
      new URLSearchParams(location.search).get("demo") === "invite"
        ? "invite"
        : "website",
    ),
    [person, setPerson] = useState("Maya"),
    [draft, setDraft] = useState(false),
    [published, setPublished] = useState(false),
    [preview, setPreview] = useState(false),
    [refresh, setRefresh] = useState(0),
    [copied, setCopied] = useState(false);
  function requestChange() {
    setDraft(true);
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
          ["invite", "Invite your team"],
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
                disabled={!draft}
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
            Everyone gets a Butler. Everyone can follow along.
          </p>
          <div className="tour-message tour-from-user">
            <small>{person}</small>
            <p>
              {person === "Maya"
                ? "Can the horse jump colourful showjumping fences?"
                : "Can we make this easy to use on a phone?"}
            </p>
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
          <div className="tour-chat-composer">
            <span>Sample conversation · no live AI is running.</span>
            <button className="button primary compact" onClick={requestChange}>
              {draft ? "View the sample preview" : "See the sample preview"} →
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
