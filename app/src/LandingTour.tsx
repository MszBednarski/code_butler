import { useState } from "react";

import type { DemoWebsiteFeatures } from "./horse-demo";
import { horseDemoWebsite } from "./horse-demo";
import Reactions from "./Reactions";
import VerificationMessage from "./VerificationMessage";
import type { ReactionSummary, ReactionTarget } from "./Reactions";

type DemoOwner = "Maya" | "Sam" | "group";
const sampleChanges: Record<
  DemoOwner,
  { title: string; owner: string; features: DemoWebsiteFeatures; ready: string }
> = {
  Maya: {
    title: "Add colourful jumps to Jump Club",
    owner: "Maya’s",
    features: { colorful: true },
    ready:
      "Maya’s colourful jumps are ready. Try a round before making them live.",
  },
  Sam: {
    title: "Make jumping easier with a big tap button",
    owner: "Sam’s",
    features: { touchControls: true },
    ready:
      "Sam added a big jump button. Try it on your phone before making it live.",
  },
  group: {
    title: "Give Jump Club a sunset arena",
    owner: "Group Butler’s",
    features: { sunset: true },
    ready:
      "The group’s sunset arena is ready. Try a round before making it live.",
  },
};
const initialPreview = () => ({
  dismissed: false,
  saved: false,
  published: false,
});

export default function LandingTour() {
  const [panel, setPanel] = useState(() =>
      new URLSearchParams(location.search).get("demo") === "invite"
        ? "invite"
        : "website",
    ),
    [person, setPerson] = useState<"Maya" | "Sam">("Maya"),
    [previewOwner, setPreviewOwner] = useState<DemoOwner>("Maya"),
    [previews, setPreviews] = useState({
      Maya: initialPreview(),
      Sam: initialPreview(),
      group: initialPreview(),
    }),
    [published, setPublished] = useState<DemoWebsiteFeatures>({}),
    [preview, setPreview] = useState(false),
    [refresh, setRefresh] = useState(0),
    [copied, setCopied] = useState(false),
    [demoSeen, setDemoSeen] = useState(false),
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
      "preview:Sam": [
        { emoji: "👍", count: 1, reacted: false, names: ["Maya"] },
      ],
      "preview:group": [
        { emoji: "🔥", count: 2, reacted: false, names: ["Maya", "Sam"] },
      ],
      "preview:Maya": [
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
  const active = sampleChanges[previewOwner],
    activeState = previews[previewOwner];
  const personal = sampleChanges[person],
    personalState = previews[person];
  const hasPublished = Object.values(published).some(Boolean);
  function selectChat(owner: "Maya" | "Sam") {
    setPerson(owner);
    setPreviewOwner(owner);
    setPreview(!previews[owner].dismissed && !previews[owner].published);
    setPanel("chat");
  }
  function selectGroup() {
    setPreviewOwner("group");
    setPreview(!previews.group.dismissed && !previews.group.published);
    setPanel("group");
  }
  function inspectDemo(owner: DemoOwner) {
    setPreviewOwner(owner);
    setPreview(!previews[owner].published);
    setPanel("website");
  }
  function dismissDemo(owner: DemoOwner) {
    setPreviews((current) => ({
      ...current,
      [owner]: { ...current[owner], dismissed: true, saved: true },
    }));
    if (previewOwner === owner) setPreview(false);
  }
  function restoreDemo(owner: DemoOwner) {
    setPreviews((current) => ({
      ...current,
      [owner]: { ...current[owner], dismissed: false },
    }));
  }
  function proposal(owner: DemoOwner) {
    const state = previews[owner],
      change = sampleChanges[owner];
    if (state.published || state.dismissed) return null;
    return (
      <article className="artifact-card tour-proposal">
        <span className="small-label">
          {owner === "group" ? "GROUP PREVIEW" : "PREVIEW READY"} · NOT
          PUBLISHED
        </span>
        <strong>{change.title}</strong>
        <p>
          {change.owner} own preview. Try it here; the team lead can approve a
          teammate’s change too.
        </p>
        <div className="artifact-card-actions">
          <button
            className="button primary compact"
            onClick={() => inspectDemo(owner)}
          >
            Inspect preview →
          </button>
          <button
            className="text-button dismiss-preview"
            onClick={() => dismissDemo(owner)}
          >
            Dismiss
          </button>
        </div>
        <Reactions
          targetType="preview"
          targetId={owner}
          summary={reactions}
          onReact={react}
        />
      </article>
    );
  }
  function savedPreview(owner: DemoOwner) {
    const state = previews[owner];
    if (!state.saved) return null;
    return (
      <article className="saved-preview-card tour-saved-preview">
        <small className="small-label">
          {state.dismissed
            ? "DISMISSED · SAVED HERE"
            : "PREVIEW IN CHAT HISTORY"}
        </small>
        <strong>{sampleChanges[owner].title}</strong>
        <p>Changed your mind? Your preview stays in this chat’s history.</p>
        <div className="artifact-card-actions">
          {state.dismissed && (
            <button
              className="button secondary compact"
              onClick={() => restoreDemo(owner)}
            >
              Restore preview
            </button>
          )}
          <button className="text-button" onClick={() => inspectDemo(owner)}>
            View preview →
          </button>
        </div>
      </article>
    );
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
        <button
          className="tour-news"
          aria-label="What’s new in the demo"
          onClick={() => setPanel("news")}
        >
          ✳{!demoSeen && <span className="tour-new-badge">3</span>}
        </button>
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
            aria-label={label}
            aria-selected={panel === value}
            onClick={() => {
              if (value === "chat") selectChat(person);
              else if (value === "group") {
                selectGroup();
                setDemoSeen(true);
              } else setPanel(value);
            }}
          >
            {label}
            {value === "group" && !demoSeen && (
              <span className="tour-new-badge">2</span>
            )}
          </button>
        ))}
      </div>
      {panel === "news" && (
        <div className="tour-chat-panel">
          <h3>What’s new</h3>
          <p className="tour-chat-note">
            You don’t have to check every chat. Butler brings the important bits
            together.
          </p>
          <button
            className="notice-item notice-unread"
            onClick={() => {
              selectGroup();
              setDemoSeen(true);
            }}
          >
            <span className="notice-symbol">✳</span>
            <span>
              <strong>
                {previews.group.published
                  ? "Group change is on the website"
                  : previews.group.dismissed
                    ? "Group preview is saved in chat"
                    : "Group Butler has a preview"}
              </strong>
              <small>Your group’s sunset arena.</small>
            </span>
          </button>
          <button className="notice-item" onClick={() => selectChat("Sam")}>
            <span className="notice-symbol">↗</span>
            <span>
              <strong>
                {previews.Sam.published
                  ? "Sam’s change is on the website"
                  : previews.Sam.dismissed
                    ? "Sam’s preview is saved in chat"
                    : "Sam’s preview is ready"}
              </strong>
              <small>Big jump button · Sam’s separate preview</small>
            </span>
          </button>
          <button
            className="notice-item"
            onClick={() => {
              setPreview(false);
              setPanel("website");
            }}
          >
            <span className="notice-symbol">✓</span>
            <span>
              <strong>The shared website is ready</strong>
              <small>Open it here and play a round.</small>
            </span>
          </button>
          <div className="tour-chat-composer">
            <span>
              Sample updates. Your project shows its own messages, previews and
              published changes.
            </span>
          </div>
        </div>
      )}
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
                disabled={activeState.published || activeState.dismissed}
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
            <div>
              <strong>
                {preview ? `${active.owner} preview` : "Current website"}
              </strong>
              {preview && <small>{active.title}</small>}
            </div>
            <span>{preview ? "NOT PUBLISHED" : "LIVE DEMO"}</span>
          </div>
          <iframe
            key={`${preview}:${previewOwner}:${JSON.stringify(published)}:${refresh}`}
            srcDoc={horseDemoWebsite(
              preview ? { ...published, ...active.features } : published,
            )}
            title={
              preview
                ? `Butler demo — ${active.owner} preview`
                : "Butler demo — current website"
            }
            sandbox="allow-scripts"
          />
          {preview && (
            <div className="tour-preview-reactions">
              <Reactions
                targetType="preview"
                targetId={previewOwner}
                summary={reactions}
                onReact={react}
              />
            </div>
          )}
          <div className="tour-next" aria-live="polite">
            {preview && activeState.dismissed ? (
              <>
                <p>This preview is saved in {active.owner} chat history.</p>
                <button
                  className="button secondary compact"
                  onClick={() => restoreDemo(previewOwner)}
                >
                  Restore preview
                </button>
              </>
            ) : preview ? (
              <>
                <p>{active.ready}</p>
                <button
                  className="button primary compact"
                  onClick={() => {
                    setPublished((current) => ({
                      ...current,
                      ...active.features,
                    }));
                    setPreviews((current) => ({
                      ...current,
                      [previewOwner]: {
                        ...current[previewOwner],
                        published: true,
                      },
                    }));
                    setPreview(false);
                  }}
                >
                  Apply change in demo <span>→</span>
                </button>
              </>
            ) : hasPublished ? (
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
                  onClick={() => selectChat(person)}
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
            {(["Maya", "Sam"] as const).map((name) => (
              <button
                role="tab"
                aria-selected={person === name}
                aria-label={`${name}’s chat`}
                key={name}
                onClick={() => selectChat(name)}
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
              {personalState.published
                ? "This change is now on the shared website."
                : person === "Maya"
                  ? "The colourful jumps are ready. Play my preview before they go live."
                  : "The big tap button is ready. Try my phone-friendly preview before it goes live."}
            </p>
            <span className="tour-chat-progress">
              {personalState.published
                ? "On the shared website"
                : "Ready to try"}
            </span>
          </div>
          {proposal(person)}
          <div className="message message-kind-gemini"><div className="message-content">
            <VerificationMessage text={JSON.stringify({ phase: "plan", summary: "Before this goes live, I’ll independently check the change and show the results here.", details: `Example verification plan for ${person}’s change:\n1. Check that the website compiles.\n2. Open it at phone size and test the jump controls.\n3. Report any problems for Butler to fix, then check again.\n\nThis is a sample. Your project shows Gemini’s actual checks and findings.` })} />
          </div></div>
          {savedPreview(person)}
          <div className="tour-chat-composer">
            <span>Sample conversation · no live AI is running.</span>
            {!personalState.dismissed && (
              <button
                className="text-button"
                onClick={() => inspectDemo(person)}
              >
                {personalState.published
                  ? "View the shared website"
                  : `View ${personal.owner} preview`}{" "}
                →
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
            <p>
              <span className="tour-mention">@Butler</span> give the arena a
              sunset look while Maya and Sam work on their previews.
            </p>
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
            <small>✳ @Butler · group agent</small>
            <p>
              {previews.group.published
                ? "The sunset arena is now on the shared website."
                : "I’ve made a sunset arena in the group’s own preview. Maya and Sam keep their own previews while I work here."}
            </p>
            <button
              className="text-button"
              onClick={() => inspectDemo("group")}
            >
              {previews.group.published
                ? "View shared website"
                : "Inspect group preview"}{" "}
              →
            </button>
          </div>
          {proposal("group")}
          {savedPreview("group")}
          <div className="tour-chat-composer">
            <span>
              Talk as a team. Tag @Butler to build a shared idea in its own
              workstream. Sample conversation; no live AI.
            </span>
            <button
              className="button primary compact"
              onClick={() => selectChat(person)}
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
