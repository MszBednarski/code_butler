import { useState } from "react";

function sampleWebsite(rsvp: boolean) {
  return `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;padding:24px;font-family:system-ui,sans-serif;color:#293e32;background:#f8f3e9}header{display:flex;justify-content:space-between;font-size:10px;letter-spacing:1px}header span{color:#8d7455}h1{font-family:Georgia,serif;font-weight:400;font-size:42px;line-height:1.06;letter-spacing:-2px;margin:30px 0 12px}p{font-size:12px;line-height:1.7;color:#707b6a;max-width:250px}.date{display:flex;align-items:center;gap:14px;border-top:1px solid #dfe0d2;padding-top:18px;margin-top:24px;font-size:11px}.date b{font-family:Georgia,serif;font-size:30px;font-weight:400}.date span{display:block;color:#79816c;font-size:10px;margin-top:4px}button{background:#294b3a;border:0;border-radius:8px;padding:12px 18px;color:white;font-size:12px;margin-top:16px;cursor:pointer}#thanks{color:#456c45;font-size:11px}footer{margin-top:24px;color:#9b9e8d;font-size:9px}@media(max-width:350px){body{padding:20px}h1{font-size:36px}}</style><header><strong>THE SUNDAY TABLE</strong><span>GOOD COMPANY CLUB</span></header><h1>Good food.<br>Better company.</h1><p>A little supper club for our favorite people. Pull up a chair. There’s always room for one more.</p>${rsvp ? '<button onclick="this.hidden=true;document.getElementById(\'thanks\').hidden=false">Save me a seat →</button><p id="thanks" hidden>You’re on the list! (This is a demo.)</p>' : ""}<div class="date"><b>26</b><div>Our next get-together<span>Sunday · 6 pm · bring something to share</span></div></div><footer>Made together. Everyone brought something.</footer></html>`;
}

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
      aria-label="Try the Butler experience"
    >
      <div className="tour-top">
        <span className="tour-project-mark">✳</span>
        <div>
          <strong>The Sunday Table</strong>
          <small>A sample team project · try it below</small>
        </div>
        <span className="tour-demo-tag">INTERACTIVE DEMO</span>
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
            srcDoc={sampleWebsite(preview || published)}
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
                <p>Maya’s new RSVP button is ready to try. Happy with it?</p>
                <button
                  className="button primary compact"
                  onClick={() => {
                    setPublished(true);
                    setPreview(false);
                  }}
                >
                  Make this the website <span>→</span>
                </button>
              </>
            ) : published ? (
              <>
                <p>
                  <strong>That’s it. Your whole team sees the change.</strong>{" "}
                  This was a demo. Imagine what your team could make.
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
                <p>This is what everyone sees. Let’s make a change together.</p>
                <button
                  className="button primary compact"
                  onClick={() => setPanel("chat")}
                >
                  Try asking Butler for a change <span>→</span>
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
                ? "Can people save a seat for dinner?"
                : "Can we make this easy to use on a phone?"}
            </p>
          </div>
          <div className="tour-message tour-from-butler">
            <small>✳ Butler</small>
            <p>
              {person === "Maya"
                ? draft
                  ? "Your RSVP button is ready. Try the preview, then tell me when to add it to the website."
                  : "Of course. I’ll add a button so your friends can save a seat. You’ll get to try it before everyone sees it."
                : "I’m making the text easier to read and the buttons easier to tap. You can keep chatting while I work."}
            </p>
            <span className="tour-chat-progress">
              {person === "Maya" && draft
                ? "Ready to try"
                : "Making your changes · 12s"}
            </span>
          </div>
          <div className="tour-chat-composer">
            <span>No special commands. Just your own words.</span>
            <button className="button primary compact" onClick={requestChange}>
              {draft ? "Try the RSVP preview" : "Try: add an RSVP button"} →
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
