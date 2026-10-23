import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import "./style.css";

type User = {
  id: string;
  name: string;
  githubLogin?: string;
  email?: string;
  isGuest: boolean;
};
type Session = {
  user: User | null;
  connections: { github: boolean; railway: boolean };
  capabilities: { github: boolean; railway: boolean; email: boolean };
  commit: string;
};
type Member = { id: string; name: string; prefix: string; role: string };
type Job = {
  id: string;
  requestKey: string;
  text: string;
  state: string;
  result?: string;
  error?: string;
  prUrl?: string;
  previewUrl?: string;
  createdAt: number;
  name?: string;
};
type Project = {
  id: string;
  name: string;
  description: string;
  state: string;
  error?: string;
  appUrl?: string;
  repoUrl?: string;
  isOwner: boolean;
  member: Member;
  members: Member[];
  ownMemberships: Member[];
  messages: { id: string; jobId: string; role: string; text: string }[];
  jobs: Job[];
  activity: Job[];
  tasks: { kind: string; state: string; error?: string; attempts: number }[];
};
type Summary = Pick<
  Project,
  "id" | "name" | "description" | "state" | "appUrl"
>;
type Codex = { state: string; code?: string; url?: string; message?: string };
const emptySession: Session = {
  user: null,
  connections: { github: false, railway: false },
  capabilities: { github: false, railway: false, email: false },
  commit: "dev",
};

class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
async function api<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response
    .json()
    .catch(() => ({
      error: "Butler could not reach its server. Please try again.",
    }));
  if (!response.ok)
    throw new ApiError(
      value.error || "Something interrupted this request.",
      response.status,
    );
  return value;
}
function navigate(url: string, replace = false) {
  history[replace ? "replaceState" : "pushState"]({}, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
function useRoute() {
  const [route, setRoute] = useState(location.pathname);
  useEffect(() => {
    const update = () => setRoute(location.pathname);
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  return route;
}
function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    arrow: <path d="m5 12 14 0m-6-6 6 6-6 6" />,
    plus: <path d="M12 5v14M5 12h14" />,
    check: <path d="m5 12 4 4L19 6" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    send: (
      <>
        <path d="m4 4 17 8-17 8 3-8-3-8Z" />
        <path d="M7 12h14" />
      </>
    ),
    copy: (
      <>
        <rect x="8" y="8" width="12" height="12" rx="2" />
        <path d="M16 8V4H4v12h4" />
      </>
    ),
    external: (
      <>
        <path d="M14 3h7v7m0-7L10 14M10 3H4v17h17v-6" />
      </>
    ),
    users: (
      <>
        <circle cx="9" cy="8" r="3" />
        <path d="M3 20v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m2 3a6 6 0 0 1 3 5" />
      </>
    ),
    chat: <path d="M4 4h16v12H9l-5 4V4Z" />,
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </>
    ),
    link: (
      <>
        <path d="m9 15 6-6m-5-3 2-2a5 5 0 0 1 7 7l-2 2M7 11l-2 2a5 5 0 0 0 7 7l2-2" />
      </>
    ),
    logout: <path d="M9 4H4v16h5m5-13 5 5-5 5m-5-5h10" />,
    github: (
      <path d="M9 20c-5 1-5-2-7-2m14 4v-4a4 4 0 0 0-1-3c3-.4 6-1.5 6-6a5 5 0 0 0-1.4-3.5A5 5 0 0 0 19.5 2S18 1.6 15 3a13 13 0 0 0-6 0C6 1.6 4.5 2 4.5 2a5 5 0 0 0-.1 3.5A5 5 0 0 0 3 9c0 4.5 3 5.6 6 6a4 4 0 0 0-1 3v4" />
    ),
    railway: (
      <>
        <path d="M4 4h16M6 8h12M8 12h8M3 16h18M5 20h14" />
        <path d="m8 12-4 8m12-8 4 8" />
      </>
    ),
    spark: <path d="m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3 3-7Z" />,
    refresh: (
      <>
        <path d="M20 7v5h-5M4 17v-5h5" />
        <path d="M6 6a8 8 0 0 1 14 6M4 12a8 8 0 0 0 14 6" />
      </>
    ),
    lock: (
      <>
        <rect x="5" y="10" width="14" height="11" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.spark}
    </svg>
  );
}
function Brand({ small = false }: { small?: boolean }) {
  return (
    <a
      className={"brand" + (small ? " small" : "")}
      href="/"
      onClick={(event) => {
        event.preventDefault();
        navigate("/");
      }}
    >
      <span className="brand-mark">✳</span>
      <span>
        butler<span className="brand-dot">.</span>
      </span>
    </a>
  );
}
function Avatar({ name, index = 0 }: { name: string; index?: number }) {
  return (
    <span className={`avatar color-${index % 5}`} title={name}>
      {name.trim().slice(0, 1).toUpperCase()}
    </span>
  );
}
function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}
function Alert({ children }: { children: React.ReactNode }) {
  return (
    <div className="notice" role="alert">
      <Icon name="spark" size={17} />
      <span>{children}</span>
    </div>
  );
}
async function copy(text: string) {
  if (navigator.clipboard) await navigator.clipboard.writeText(text);
  else throw new Error("Select and copy the link below.");
}
function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    const node = ref.current;
    return () => node?.close();
  }, []);
  return (
    <dialog
      className="modal"
      ref={ref}
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <button
        className="icon-button modal-close"
        aria-label="Close"
        onClick={onClose}
      >
        <Icon name="close" />
      </button>
      <h2>{title}</h2>
      {children}
    </dialog>
  );
}

function Landing({ session, error }: { session: Session; error: string }) {
  return (
    <div className="landing">
      <header className="site-header">
        <Brand />
        <span className="header-note">Good ideas are a team sport.</span>
        <a
          className="button ghost compact"
          href={session.capabilities.github ? "/auth/github" : "#get-started"}
        >
          Get started <Icon name="arrow" size={16} />
        </a>
      </header>
      <main className="landing-main">
        <section className="hero-copy">
          <div className="eyebrow">
            <span className="tiny-star">✳</span> A LITTLE HELP. A LOT OF
            POSSIBILITIES.
          </div>
          <h1>
            Your idea.
            <br />
            Your people.
            <br />
            <em>Something real.</em>
          </h1>
          <p className="hero-description">
            Bring the whole team into building. Share a link, say what you want
            to change, and watch your website come to life.
          </p>
          <div id="get-started" className="hero-actions">
            <a
              className={
                "button primary" +
                (!session.capabilities.github ? " disabled" : "")
              }
              href={
                session.capabilities.github ? "/auth/github" : "#get-started"
              }
              aria-disabled={!session.capabilities.github}
            >
              <Icon name="github" />
              Start with GitHub
              <Icon name="arrow" size={18} />
            </a>
            <span>
              One setup for you.
              <br />
              One link for everyone else.
            </span>
          </div>
          {!session.capabilities.github && (
            <p className="setup-note">
              {error ||
                "Sign-in is being prepared. Your Butler operator needs to connect GitHub."}
            </p>
          )}
          <div className="hero-proof">
            <div className="avatar-stack">
              {["A", "J", "M", "S"].map((n, i) => (
                <Avatar key={n} name={n} index={i} />
              ))}
            </div>
            <span>
              For the ideas person, the designer,
              <br />
              and the friend who’s never written code.
            </span>
          </div>
        </section>
        <section
          className="hero-scene"
          aria-label="An illustration of collaborating with Butler"
        >
          <div className="scene-note">
            Everyone’s invited.<span>↘</span>
          </div>
          <div className="scene-window">
            <div className="scene-toolbar">
              <span className="window-dots">
                <i />
                <i />
                <i />
              </span>
              <span>the weekend project</span>
              <span className="live-pill">
                <i />
                LIVE
              </span>
            </div>
            <div className="scene-site">
              <span className="mini-label">A PLACE FOR GOOD COMPANY</span>
              <h2>
                More time
                <br />
                together.
              </h2>
              <div className="scene-arches">
                <span />
                <span />
                <span />
              </div>
              <span className="scene-site-button">Make a little room ↗</span>
            </div>
            <div className="scene-chat">
              <Avatar name="Maya" index={2} />
              <div>
                <strong>Maya</strong>
                <p>Can we make it feel a little warmer?</p>
              </div>
            </div>
            <div className="scene-chat answer">
              <span className="mini-butler">✳</span>
              <div>
                <strong>Butler</strong>
                <p>A softer palette, a friendlier welcome. Done.</p>
                <span className="published">
                  <Icon name="check" size={13} /> Change published
                </span>
              </div>
            </div>
          </div>
          <div className="floating-request">
            <Avatar name="Sam" index={3} />
            <span>“Let’s add a place to RSVP.”</span>
            <span className="tiny-star">✳</span>
          </div>
          <div className="scene-footer">
            <span>Different people.</span>
            <span>One shared creation.</span>
          </div>
        </section>
      </main>
      <section className="how-it-works">
        <div>
          <span>01</span>
          <h3>Start with an idea</h3>
          <p>
            Connect your tools once. Butler gets your team’s workspace ready.
          </p>
        </div>
        <div>
          <span>02</span>
          <h3>Invite your people</h3>
          <p>
            Send a link or show a QR code. Everyone gets a place to contribute.
          </p>
        </div>
        <div>
          <span>03</span>
          <h3>Make it together</h3>
          <p>
            Type or dictate a change. Butler builds, reviews, and publishes it.
          </p>
        </div>
      </section>
      <footer className="site-footer">
        <Brand small />
        <span>A little help, for everyone.</span>
        <small>Build {session.commit.slice(0, 7)}</small>
      </footer>
    </div>
  );
}

function Dashboard({
  session,
  refresh,
}: {
  session: Session;
  refresh: () => Promise<void>;
}) {
  const [projects, setProjects] = useState<Summary[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>([]),
    [workspace, setWorkspace] = useState("");
  const [description, setDescription] = useState(
      () => localStorage.getItem("butler-project-idea") || "",
    ),
    [projectName, setProjectName] = useState(""),
    [createKey] = useState(
      () => sessionStorage.getItem("butler-create-key") || crypto.randomUUID(),
    );
  useEffect(() => {
    api<{ projects: Summary[] }>("/api/projects")
      .then((v) => setProjects(v.projects))
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    localStorage.setItem("butler-project-idea", description);
  }, [description]);
  useEffect(() => {
    if (session.connections.railway)
      api<{ id: string; name: string }[]>("/api/railway/workspaces")
        .then((v) => {
          setWorkspaces(v);
          if (v.length === 1) setWorkspace(v[0].id);
        })
        .catch((e) => setError(e.message));
  }, [session.connections.railway]);
  async function create(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    sessionStorage.setItem("butler-create-key", createKey);
    try {
      const result = await api<{ id: string }>("/api/projects", {
        name:
          projectName.trim() ||
          description.trim().split(/\s+/).slice(0, 5).join(" ").slice(0, 45) ||
          "Our next idea",
        description,
        requestKey: createKey,
        workspaceId: workspace || undefined,
      });
      localStorage.removeItem("butler-project-idea");
      sessionStorage.removeItem("butler-create-key");
      navigate(`/p/${result.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    await api("/api/auth/logout", {});
    await refresh();
  }
  return (
    <div className="dashboard">
      <header className="site-header">
        <Brand />
        <div className="account-menu">
          <Avatar name={session.user!.name} />
          <span>{session.user!.name.split(" ")[0]}</span>
          <button
            className="icon-button"
            onClick={logout}
            aria-label="Sign out"
          >
            <Icon name="logout" />
          </button>
        </div>
      </header>
      <main className="dashboard-main">
        <div className="eyebrow">A LITTLE HELP GETTING STARTED</div>
        <h1>
          What shall we
          <br />
          <em>make together?</em>
        </h1>
        <p className="page-description">
          A fresh idea, your favorite people, and a Butler for everyone.
        </p>
        {error && <Alert>{error}</Alert>}
        <div className="dashboard-grid">
          <form className="create-card" onSubmit={create}>
            <div className="card-heading">
              <span className="round-icon">
                <Icon name="spark" />
              </span>
              <div>
                <h2>Start something new</h2>
                <p>Your first website is a conversation away.</p>
              </div>
            </div>
            <label htmlFor="project-idea">What would you like to build?</label>
            <textarea
              id="project-idea"
              autoFocus
              placeholder="A website for our supper club, with upcoming dinners and a way to join…"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={10000}
              rows={4}
              required
              minLength={3}
            />
            <details className="optional-details">
              <summary>
                Give it a name <span>optional</span>
              </summary>
              <input
                aria-label="Project name"
                placeholder="Our next idea"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                maxLength={50}
              />
            </details>
            {workspaces.length > 1 && (
              <label className="workspace-select">
                Where should it live?
                <select
                  value={workspace}
                  onChange={(e) => setWorkspace(e.target.value)}
                  required
                >
                  <option value="">Choose your Railway workspace</option>
                  {workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button
              className="button primary full"
              disabled={
                busy ||
                !session.connections.github ||
                !session.connections.railway ||
                description.trim().length < 3 ||
                (workspaces.length > 1 && !workspace)
              }
            >
              {busy ? <Spinner /> : <Icon name="plus" />}
              {busy ? "Creating your project…" : "Create & invite your team"}
              <Icon name="arrow" size={18} />
            </button>
            <p className="quiet-note">
              Your work and conversations are saved as you go.
            </p>
          </form>
          <aside className="connection-card">
            <span className="small-label">YOUR CONNECTIONS</span>
            <h2>
              Set up once.
              <br />
              Keep making things.
            </h2>
            <div className="connection-row">
              <span className="connection-icon">
                <Icon name="github" />
              </span>
              <div>
                <strong>GitHub</strong>
                <small>A home for your team’s work</small>
              </div>
              {session.connections.github ? (
                <span className="connection-check">
                  <Icon name="check" size={17} />
                </span>
              ) : (
                <a className="text-link" href="/auth/github">
                  Connect ↗
                </a>
              )}
            </div>
            <div className="connection-row">
              <span className="connection-icon">
                <Icon name="railway" />
              </span>
              <div>
                <strong>Railway</strong>
                <small>A home for your website</small>
              </div>
              {session.connections.railway ? (
                <span className="connection-check">
                  <Icon name="check" size={17} />
                </span>
              ) : (
                <a
                  className={
                    "text-link" +
                    (!session.capabilities.railway ? " disabled" : "")
                  }
                  href={session.capabilities.railway ? "/auth/railway" : "#"}
                >
                  Connect ↗
                </a>
              )}
            </div>
            <div className="connection-row muted">
              <span className="connection-icon">
                <Icon name="spark" />
              </span>
              <div>
                <strong>Codex</strong>
                <small>Connect your subscription inside your new project</small>
              </div>
            </div>
            {!session.capabilities.railway && (
              <p className="quiet-note">
                Your Butler operator is preparing the Railway connection.
              </p>
            )}
            <div className="connection-foot">
              <Icon name="users" />
              <span>
                Your teammates only need
                <br />
                your invitation. We’ll handle the rest.
              </span>
            </div>
          </aside>
        </div>
        {projects.length > 0 && (
          <section className="projects-section">
            <div className="section-title">
              <h2>Pick up where you left off</h2>
              <span>
                {projects.length} project{projects.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="project-cards">
              {projects.map((p, i) => (
                <button
                  key={p.id}
                  className={`project-card project-tone-${i % 3}`}
                  onClick={() => navigate(`/p/${p.id}`)}
                >
                  <span className="project-monogram">
                    {p.name.slice(0, 1).toUpperCase()}
                  </span>
                  <h3>{p.name}</h3>
                  <p>{p.description}</p>
                  <span className="project-card-foot">
                    {p.state === "ready"
                      ? "Open your workspace"
                      : "Workspace preparing"}
                    <Icon name="arrow" size={16} />
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function Join() {
  const [info, setInfo] = useState<{
      id: string;
      name: string;
      ownerName: string;
    } | null>(null),
    [name, setName] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [secret] = useState(
    () => new URLSearchParams(location.hash.slice(1)).get("invite") || "",
  );
  useEffect(() => {
    if (!secret) {
      setError("Open the complete invitation link from your team lead.");
      return;
    }
    api<{ id: string; name: string; ownerName: string }>(
      "/api/invites/inspect",
      { token: secret },
    )
      .then(setInfo)
      .catch((e) => setError(e.message));
  }, [secret]);
  async function join(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ projectId: string }>("/api/invites/join", {
        token: secret,
        name,
      });
      navigate(`/p/${result.projectId}`, true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="join-page">
      <Brand />
      <main className="join-card">
        <div className="join-art">
          <span>✳</span>
          <div className="avatar-stack">
            {["You", "M", "J"].map((n, i) => (
              <Avatar key={n} name={n} index={i + 1} />
            ))}
          </div>
        </div>
        <div className="eyebrow">THERE’S A PLACE FOR YOU HERE</div>
        <h1>
          You’re on
          <br />
          <em>the team.</em>
        </h1>
        {info ? (
          <>
            <p>
              <strong>{info.ownerName.split(" ")[0]}</strong> invited you to
              help build <strong>{info.name}</strong>.
            </p>
            <form onSubmit={join}>
              <label htmlFor="join-name">What should we call you?</label>
              <input
                id="join-name"
                autoComplete="given-name"
                placeholder="Your first name"
                value={name}
                maxLength={50}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                required
              />
              <button
                className="button primary full"
                disabled={busy || !name.trim()}
              >
                {busy ? <Spinner /> : <Icon name="spark" />}
                {busy ? "Making room for you…" : "Join & start creating"}
                <Icon name="arrow" size={18} />
              </button>
            </form>
            <p className="quiet-note">
              Just bring your ideas. Your workspace is saved automatically.
            </p>
          </>
        ) : (
          !error && <Spinner />
        )}
        {error && <Alert>{error}</Alert>}
      </main>
    </div>
  );
}

function Invite({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}) {
  const [invite, setInvite] = useState<{ url: string; qr: string } | null>(
      null,
    ),
    [message, setMessage] = useState("");
  useEffect(() => {
    api<{ url: string; qr: string }>(`/api/projects/${project.id}/invite`)
      .then(setInvite)
      .catch((e) => setMessage(e.message));
  }, [project.id]);
  return (
    <Modal title="Bring your people." onClose={onClose}>
      <p>
        One scan, and they’re part of <strong>{project.name}</strong>. Everyone
        gets their own workspace.
      </p>
      {invite ? (
        <>
          <img
            className="invite-qr"
            src={invite.qr}
            alt={`QR code to join ${project.name}`}
          />
          <button
            className="button primary full"
            onClick={() =>
              copy(invite.url)
                .then(() => setMessage("Invite link copied."))
                .catch((e) => setMessage(e.message))
            }
          >
            <Icon name="link" />
            Copy team invitation
          </button>
          <input
            className="copy-input"
            readOnly
            value={invite.url}
            aria-label="Team invitation link"
            onFocus={(e) => e.target.select()}
          />
          <p className="quiet-note">
            Anyone with this invitation can join your team.
          </p>
        </>
      ) : (
        !message && <Spinner />
      )}
      {message && (
        <p role="status" className="inline-status">
          {message}
        </p>
      )}
    </Modal>
  );
}

function SaveAccess({
  session,
  projectId,
  onClose,
}: {
  session: Session;
  projectId: string;
  onClose: () => void;
}) {
  const [link, setLink] = useState(""),
    [email, setEmail] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  async function recovery() {
    setBusy(true);
    try {
      const value = await api<{ url: string }>("/api/auth/recovery", {});
      setLink(value.url);
      await copy(value.url)
        .then(() =>
          setMessage(
            "Private sign-in link copied. Save it somewhere only you can access.",
          ),
        )
        .catch((e) => setMessage(e.message));
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function send(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api("/api/auth/email", { email, returnTo: `/p/${projectId}` });
      setMessage("Check your email for your sign-in link.");
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Your ideas have a home." onClose={onClose}>
      <p>
        Keep a private sign-in link to return to this same workspace from any
        device.
      </p>
      <button
        className="button primary full"
        disabled={busy}
        onClick={recovery}
      >
        <Icon name="lock" />
        Copy my private sign-in link
      </button>
      {link && (
        <input
          className="copy-input"
          aria-label="Your private sign-in link"
          readOnly
          value={link}
          onFocus={(e) => e.target.select()}
        />
      )}
      <p className="quiet-note">
        Keep this link for yourself. Use the team invitation to invite other
        people.
      </p>
      {session.capabilities.email && (
        <form className="email-form" onSubmit={send}>
          <label htmlFor="save-email">Or save with your email</label>
          <div>
            <input
              id="save-email"
              type="email"
              required
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <button className="button ghost compact" disabled={busy}>
              Send link
            </button>
          </div>
        </form>
      )}
      {session.capabilities.github && (
        <a
          className="button ghost full"
          href={`/auth/github?purpose=account&returnTo=${encodeURIComponent("/p/" + projectId)}`}
        >
          <Icon name="github" />
          Save with GitHub
        </a>
      )}
      {message && (
        <p className="inline-status" role="status">
          {message}
        </p>
      )}
    </Modal>
  );
}

function CodexConnection({
  project,
  onConnected,
}: {
  project: Project;
  onConnected: () => void;
}) {
  const [connection, setConnection] = useState<Codex>({ state: "loading" }),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [copied, setCopied] = useState(false);
  useEffect(() => {
    if (project.state !== "ready") return;
    let alive = true;
    const refresh = () =>
      api<Codex>(`/api/projects/${project.id}/codex`)
        .then((value) => {
          if (alive) {
            setConnection(value);
            if (value.state === "connected") onConnected();
          }
        })
        .catch((e) => {
          if (alive) setError(e.message);
        });
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [project.id, project.state, onConnected]);
  async function start() {
    setError("");
    setBusy(true);
    try {
      setConnection(await api<Codex>(`/api/projects/${project.id}/codex`, {}));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (project.state !== "ready") return null;
  if (connection.state === "connected")
    return (
      <div className="codex-connected">
        <Icon name="check" size={14} />
        Your team’s Codex is connected
      </div>
    );
  return (
    <div className="codex-card">
      <span className="round-icon">
        <Icon name="spark" />
      </span>
      <div className="codex-content">
        <h3>One last connection.</h3>
        <p>Sign in to your Codex subscription to get everyone building.</p>
        {connection.state === "pending" && connection.code && connection.url ? (
          <>
            <div className="device-code">
              <strong>{connection.code}</strong>
              <button
                className="icon-button"
                aria-label="Copy Codex sign-in code"
                onClick={() =>
                  copy(connection.code!)
                    .then(() => setCopied(true))
                    .catch(() => setError("Select the code to copy it."))
                }
              >
                <Icon name={copied ? "check" : "copy"} size={17} />
              </button>
            </div>
            <a
              className="button primary compact"
              href={connection.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open Codex sign-in
              <Icon name="external" size={15} />
            </a>
            <small>
              Enter the code in your browser, then come back here. This page
              updates automatically.
            </small>
          </>
        ) : connection.state === "starting" || busy ? (
          <p className="inline-status">
            <Spinner />
            Preparing your sign-in link…
          </p>
        ) : (
          <button
            className="button primary compact"
            onClick={start}
            disabled={connection.state === "loading"}
          >
            {connection.state === "loading" ? (
              <Spinner />
            ) : (
              <Icon name="link" size={16} />
            )}
            Connect Codex
          </button>
        )}
        {connection.message && <small>{connection.message}</small>}
        {error && <small role="alert">{error}</small>}
      </div>
    </div>
  );
}
const jobLabel: Record<string, string> = {
  queued: "Queued",
  working: "Working",
  reviewing: "Reviewing",
  deploying: "Publishing",
  live: "Live",
  unchanged: "Done",
  failed: "Needs a hand",
  needs_attention: "Needs a hand",
};
function JobState({ job }: { job: Job }) {
  return (
    <span className={"job-state state-" + job.state}>
      {["live", "unchanged"].includes(job.state) ? (
        <Icon name="check" size={12} />
      ) : ["working", "reviewing", "deploying"].includes(job.state) ? (
        <Spinner />
      ) : (
        <i />
      )}
      {jobLabel[job.state] || job.state}
    </span>
  );
}

function Workspace({
  projectId,
  session,
  refreshSession,
}: {
  projectId: string;
  session: Session;
  refreshSession: () => Promise<void>;
}) {
  const [project, setProject] = useState<Project | null>(null),
    [error, setError] = useState(""),
    [invite, setInvite] = useState(false),
    [saving, setSaving] = useState(false),
    [tab, setTab] = useState("chat"),
    [sending, setSending] = useState(false),
    [codexReady, setCodexReady] = useState(false),
    [memberId, setMemberId] = useState("");
  const [text, setText] = useState(
    () => localStorage.getItem(`butler-draft-${projectId}`) || "",
  );
  const bottom = useRef<HTMLDivElement>(null),
    textarea = useRef<HTMLTextAreaElement>(null),
    lastMessage = useRef(""),
    pendingKey = useRef<{ text: string; key: string } | null>(null),
    lastLive = useRef("");
  const [previewVersion, setPreviewVersion] = useState("");
  const refresh = useCallback(async () => {
    try {
      const data = await api<Project>(
        `/api/projects/${projectId}${memberId ? "?member=" + memberId : ""}`,
      );
      setProject(data);
      setError("");
      const live = data.jobs.filter((j) => j.state === "live").at(-1)?.id;
      if (live && lastLive.current !== live) {
        lastLive.current = live;
        setPreviewVersion(live);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projectId, memberId]);
  const connected = useCallback(() => setCodexReady(true), []);
  useEffect(() => {
    refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 2500);
    const focus = () => {
      refresh();
      refreshSession();
    };
    window.addEventListener("focus", focus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [refresh, refreshSession]);
  useEffect(() => {
    localStorage.setItem(`butler-draft-${projectId}`, text);
    if (textarea.current) {
      textarea.current.style.height = "auto";
      textarea.current.style.height =
        Math.min(textarea.current.scrollHeight, 150) + "px";
    }
  }, [text, projectId]);
  useEffect(() => {
    const latest = project?.messages.at(-1)?.id;
    if (latest && latest !== lastMessage.current) {
      const hadPrevious = Boolean(lastMessage.current);
      lastMessage.current = latest;
      if (hadPrevious && (!project?.isOwner || codexReady))
        bottom.current?.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
        });
    }
  }, [project?.messages]);
  async function send(event?: React.FormEvent) {
    event?.preventDefault();
    if (!text.trim() || sending || !project) return;
    setSending(true);
    setError("");
    const draft = text;
    const request =
      pendingKey.current?.text === draft
        ? pendingKey.current
        : { text: draft, key: crypto.randomUUID() };
    pendingKey.current = request;
    try {
      await api(
        `/api/projects/${projectId}/messages${memberId ? "?member=" + memberId : ""}`,
        { text: draft, requestKey: request.key },
      );
      setText("");
      pendingKey.current = null;
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }
  async function retry() {
    try {
      await api(`/api/projects/${projectId}/retry`, {});
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  if (!project)
    return (
      <div className="loading-page">
        <Brand />
        {error ? (
          <Alert>{error}</Alert>
        ) : (
          <>
            <Spinner />
            <p>Opening your workspace…</p>
          </>
        )}
      </div>
    );
  const preparing = project.state !== "ready",
    stage = [
      "queued",
      "repository",
      "infrastructure",
      "deploying",
      "ready",
    ].indexOf(project.state),
    latestJob = project.jobs.at(-1);
  return (
    <div className="workspace-shell">
      <header className="workspace-header">
        <Brand small />
        <span className="header-divider" />
        <div className="project-identity">
          <strong>{project.name}</strong>
          <small>Your shared creation</small>
        </div>
        <div className="workspace-header-actions">
          <div className="avatar-stack">
            {project.members.slice(0, 4).map((m, i) => (
              <Avatar key={m.id} name={m.name} index={i} />
            ))}
          </div>
          {project.isOwner && (
            <button
              className="button primary compact"
              onClick={() => setInvite(true)}
            >
              <Icon name="users" size={17} />
              <span>Invite team</span>
            </button>
          )}
          <button
            className="icon-button"
            aria-label="Save your workspace access"
            onClick={() => setSaving(true)}
          >
            <Icon name="lock" size={18} />
          </button>
        </div>
      </header>
      <div className="mobile-tabs" role="tablist" aria-label="Workspace panels">
        {[
          ["chat", "chat", "Your agent"],
          ["preview", "grid", "Website"],
          ["team", "users", "Team"],
        ].map(([value, icon, label]) => (
          <button
            key={value}
            role="tab"
            aria-selected={tab === value}
            className={tab === value ? "selected" : ""}
            onClick={() => setTab(value)}
          >
            <Icon name={icon} size={16} />
            {label}
          </button>
        ))}
      </div>
      <main className={"project-layout tab-" + tab}>
        <section className="preview-panel">
          <div className="panel-top">
            <span>
              <span
                className={"status-dot" + (project.appUrl ? " green" : "")}
              />
              {project.appUrl
                ? "Your shared website"
                : "Your website starts here"}
            </span>
            {project.appUrl && (
              <a
                className="icon-button"
                href={project.appUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Open website"
              >
                <Icon name="external" size={16} />
              </a>
            )}
          </div>
          <div className="preview-surface">
            {project.appUrl ? (
              <iframe
                key={previewVersion}
                src={
                  project.appUrl +
                  (previewVersion ? "?butler=" + previewVersion : "")
                }
                title={project.name + " live website"}
                sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
              />
            ) : (
              <div className="preview-placeholder">
                <span className="big-butler">✳</span>
                <p className="eyebrow">EVERYTHING STARTS SOMEWHERE</p>
                <h2>
                  A little idea.
                  <br />
                  <em>A lot of possibility.</em>
                </h2>
                <p>
                  Your team’s website will appear right here.
                  <br />
                  You can start sharing ideas already.
                </p>
                <div className="placeholder-stack">
                  {project.members.slice(0, 5).map((m, i) => (
                    <Avatar name={m.name} key={m.id} index={i} />
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="preview-bottom">
            <span>
              <Icon name="users" size={14} />
              {project.members.length} person
              {project.members.length === 1 ? "" : "s"} making this together
            </span>
            {project.isOwner && project.repoUrl && (
              <a
                href={project.repoUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Project files ↗
              </a>
            )}
          </div>
        </section>
        <section className="conversation-panel">
          <div className="panel-top">
            <div className="agent-heading">
              <span className="mini-butler">✳</span>
              <div>
                <strong>{project.member.name}’s Butler</strong>
                <small>Your own space to make things</small>
              </div>
            </div>
            {project.ownMemberships.length > 1 ? (
              <select
                className="workspace-picker"
                aria-label="Your saved workspaces"
                value={project.member.id}
                onChange={(e) => setMemberId(e.target.value)}
              >
                {project.ownMemberships.map((m, i) => (
                  <option key={m.id} value={m.id}>
                    {m.name} · workspace {i + 1}
                  </option>
                ))}
              </select>
            ) : (
              <span className="saved-label">
                <Icon name="check" size={12} />
                Saved
              </span>
            )}
          </div>
          <div className="conversation-scroll">
            {preparing && (
              <div className="provision-card">
                <span className="small-label">MAKING ROOM FOR YOUR TEAM</span>
                <h3>
                  {project.state === "failed"
                    ? "Let’s get your workspace ready."
                    : project.state === "retrying"
                      ? "Giving setup another try…"
                      : "Your workspace is taking shape."}
                </h3>
                <p>Your ideas are saved while we prepare everything.</p>
                <div className="setup-steps">
                  {[
                    "Create project",
                    "Prepare workspace",
                    "Publish website",
                  ].map((label, i) => (
                    <span
                      key={label}
                      className={
                        stage > i + 1
                          ? "complete"
                          : stage === i + 1
                            ? "current"
                            : ""
                      }
                    >
                      {stage > i + 1 ? <Icon name="check" size={12} /> : <i />}
                      {label}
                    </span>
                  ))}
                </div>
                {project.error && project.isOwner && (
                  <>
                    <p className="setup-error">{project.error}</p>
                    <button className="text-button" onClick={retry}>
                      Try again <Icon name="refresh" size={13} />
                    </button>
                  </>
                )}
              </div>
            )}
            {project.isOwner && (
              <CodexConnection project={project} onConnected={connected} />
            )}
            <div className="agent-welcome">
              <span className="mini-butler">✳</span>
              <div>
                <p>
                  Hi {project.member.name.split(" ")[0]}. What would you like to
                  make?
                </p>
                <small>
                  Tell me in your own words. I’ll build it, get it reviewed, and
                  help bring it to the website.
                </small>
              </div>
            </div>
            {project.messages.map((message) => {
              const job = project.jobs.find((j) => j.id === message.jobId);
              return (
                <div
                  key={message.id}
                  className={"message message-" + message.role}
                >
                  {message.role === "assistant" && (
                    <span className="mini-butler">✳</span>
                  )}
                  <div className="message-content">
                    <p>{message.text}</p>
                    {message.role === "user" && job && <JobState job={job} />}
                  </div>
                </div>
              );
            })}
            {latestJob &&
              ["working", "reviewing", "deploying"].includes(
                latestJob.state,
              ) && (
                <div className="working-line">
                  <span className="mini-butler">✳</span>
                  <Spinner />
                  <span>
                    {latestJob.state === "working"
                      ? "Working on your idea…"
                      : latestJob.state === "reviewing"
                        ? "Making sure everything works together…"
                        : "Publishing your change…"}
                  </span>
                </div>
              )}
            {project.jobs
              .filter((j) => j.previewUrl)
              .slice(-1)
              .map((job) => (
                <a
                  key={job.id}
                  className="preview-link"
                  href={job.previewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Icon name="grid" size={16} />
                  {job.state === "live"
                    ? "Your change has been published"
                    : "Take a look at your change"}
                  <Icon name="external" size={14} />
                </a>
              ))}
            {session.user?.isGuest && project.messages.length > 0 && (
              <button
                className="save-access-card"
                onClick={() => setSaving(true)}
              >
                <Icon name="lock" size={16} />
                <span>
                  <strong>Make yourself at home.</strong>
                  <small>Save access to return from any device.</small>
                </span>
                <Icon name="arrow" size={16} />
              </button>
            )}
            {error && <Alert>{error}</Alert>}
            <div ref={bottom} />
          </div>
          <form className="composer" onSubmit={send}>
            <div className="composer-input">
              <textarea
                ref={textarea}
                placeholder="What would you like to change?"
                aria-label="Tell your agent what to change"
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={20000}
                rows={2}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              <button
                type="submit"
                className="send-button"
                aria-label="Send request"
                disabled={!text.trim() || sending}
              >
                {sending ? <Spinner /> : <Icon name="arrow" size={21} />}
              </button>
            </div>
            <div className="composer-note">
              <span>
                {preparing
                  ? "You can send ideas while we prepare."
                  : project.isOwner && !codexReady
                    ? "Requests wait safely until Codex is connected."
                    : "Type it. Dictate it. Make it happen."}
              </span>
              <span>↵ ⌘ / Ctrl</span>
            </div>
          </form>
        </section>
        <section className="team-panel">
          <div className="panel-top">
            <strong>Your people</strong>
            <span>{project.members.length}</span>
          </div>
          <div className="team-content">
            {project.members.map((member, i) => (
              <div className="team-member" key={member.id}>
                <Avatar name={member.name} index={i} />
                <div>
                  <strong>{member.name}</strong>
                  <small>
                    {member.role === "owner" ? "Team lead" : "Teammate"}
                  </small>
                </div>
                {member.id === project.member.id && <span>You</span>}
              </div>
            ))}
            {project.isOwner && (
              <button
                className="button ghost full"
                onClick={() => setInvite(true)}
              >
                <Icon name="plus" size={16} />
                Invite someone
              </button>
            )}
            <h3>Coming together</h3>
            {project.activity.map((job) => (
              <div className="activity-item" key={job.id}>
                <strong>{job.name}</strong>
                <p>{job.text}</p>
                <JobState job={job} />
              </div>
            ))}
          </div>
        </section>
      </main>
      {invite && <Invite project={project} onClose={() => setInvite(false)} />}{" "}
      {saving && (
        <SaveAccess
          session={session}
          projectId={projectId}
          onClose={() => setSaving(false)}
        />
      )}
    </div>
  );
}

function Recover({ refresh }: { refresh: () => Promise<void> }) {
  const [error, setError] = useState("");
  useEffect(() => {
    const secret = new URLSearchParams(location.hash.slice(1)).get("token");
    if (!secret) {
      setError("Open the complete private sign-in link you saved.");
      return;
    }
    api("/api/auth/recover", { token: secret })
      .then(async () => {
        await refresh();
        navigate("/", true);
      })
      .catch((e) => setError(e.message));
  }, [refresh]);
  return (
    <div className="loading-page">
      <Brand />
      {error ? (
        <Alert>{error}</Alert>
      ) : (
        <>
          <Spinner />
          <p>Welcome back. Finding your workspace…</p>
        </>
      )}
    </div>
  );
}
function EmailComplete({ refresh }: { refresh: () => Promise<void> }) {
  const [error, setError] = useState("");
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const secret = new URLSearchParams(location.hash.slice(1)).get("token");
    if (!secret) {
      setError("Open the complete sign-in link from your email.");
      return;
    }
    api<{ returnTo: string }>("/api/auth/email/complete", { token: secret })
      .then(async (value) => {
        await refresh();
        navigate(value.returnTo || "/", true);
      })
      .catch((e) => setError(e.message));
  }, [refresh]);
  return (
    <div className="loading-page">
      <Brand />
      {error ? (
        <Alert>{error}</Alert>
      ) : (
        <>
          <Spinner />
          <p>Saving your workspace…</p>
        </>
      )}
    </div>
  );
}
function App() {
  const route = useRoute(),
    [session, setSession] = useState<Session>(emptySession),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      setSession(await api<Session>("/api/session"));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoaded(true);
    }
  }, []);
  useEffect(() => {
    const value = new URLSearchParams(location.search).get("auth_error");
    if (value) {
      setError(value);
      history.replaceState({}, "", location.pathname + location.hash);
    }
    const resize = () =>
      document.documentElement.style.setProperty(
        "--app-height",
        `${window.visualViewport?.height || innerHeight}px`,
      );
    resize();
    window.visualViewport?.addEventListener("resize", resize);
    return () => window.visualViewport?.removeEventListener("resize", resize);
  }, [refresh]);
  useEffect(() => {
    refresh();
  }, [route, refresh]);
  if (route === "/join") return <Join />;
  if (route === "/recover") return <Recover refresh={refresh} />;
  if (route === "/email") return <EmailComplete refresh={refresh} />;
  const project = /^\/p\/([a-f0-9-]{36})$/.exec(route)?.[1];
  if (project)
    return (
      <Workspace
        key={project}
        projectId={project}
        session={session}
        refreshSession={refresh}
      />
    );
  if (!loaded)
    return (
      <div className="loading-page">
        <Brand />
        <Spinner />
      </div>
    );
  return session.user ? (
    <Dashboard session={session} refresh={refresh} />
  ) : (
    <Landing session={session} error={error} />
  );
}
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
if ("serviceWorker" in navigator)
  window.addEventListener("load", () =>
    navigator.serviceWorker.register("/sw.js").catch(() => {}),
  );
