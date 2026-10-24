import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import ReactDOM from "react-dom/client";
import "./style.css";
import { chatBubbles, explainButler } from "./communication";
import type { ChatMessage } from "./communication";
import { attachWorkspaceViewport } from "./workspace-viewport";
import LandingTour from "./LandingTour";
import Reactions from "./Reactions";
import type { ReactionSummary, ReactionTarget } from "./Reactions";

type User = {
  id: string;
  name: string;
  githubLogin?: string;
  email?: string;
  isGuest: boolean;
};
type Session = {
  user: User | null;
  connections: { github: boolean; railway: boolean; boat?: boolean };
  hostingProvider?: "railway" | "boat";
  capabilities: {
    github: boolean;
    githubRepositories?: boolean;
    boat?: boolean;
    railway: boolean;
    email: boolean;
  };
  commit: string;
};
type Member = {
  id: string;
  name: string;
  prefix: string;
  role: string;
  agentState?: string;
  startedAt?: number;
  finishedAt?: number;
};
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
  memberId?: string;
  prNumber?: number;
  startedAt?: number;
  finishedAt?: number;
  mergedAt?: number;
  publishedAt?: number;
  changeSha?: string;
  prTitle?: string;
  artifactUrl?: string;
  artifactReadyAt?: number;
  inspectedAt?: number;
  approvedAt?: number;
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
  codingReady: boolean;
  hostingProvider?: "railway" | "boat";
  githubAccess?: { repo: string; url: string } | null;
  member: Member;
  chatMember?: Member;
  readOnly?: boolean;
  members: Member[];
  ownMemberships: Member[];
  messages: ChatMessage[];
  reactions?: ReactionSummary;
  jobs: Job[];
  activity: Job[];
  releases?: {
    number: number;
    title: string;
    author?: string;
    sha: string;
    mergedAt?: number;
    publishedAt?: number;
    isLive: boolean;
    url: string;
  }[];
  tasks: { kind: string; state: string; error?: string; attempts: number }[];
};
function jobPreviewUrl(job: Job) {
  return job.state === "awaiting_approval"
    ? job.artifactUrl
    : job.previewUrl || job.artifactUrl;
}
type Summary = Pick<
  Project,
  "id" | "name" | "description" | "state" | "appUrl"
> & { isOwner?: boolean };
type Codex = { state: string; code?: string; url?: string; message?: string };
const emptySession: Session = {
  user: null,
  hostingProvider: "boat",
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
  const value = await response.json().catch(() => ({
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
    share: (
      <>
        <path d="M12 15V3m-4 4 4-4 4 4" />
        <path d="M5 11H4v10h16V11h-1" />
      </>
    ),
    expand: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />,
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
      <div className="notice-body">
        {typeof children === "string" ? (
          <ButlerText text={children} kind="error" />
        ) : (
          children
        )}
      </div>
    </div>
  );
}
function ButlerText({
  text,
  kind = "message",
  developerUrl,
  diagnostics = [],
}: {
  text: string;
  kind?: string;
  developerUrl?: string;
  diagnostics?: string[];
}) {
  const explanation = explainButler(text, kind);
  const details = [...new Set([text, ...diagnostics])].filter(
    (value) => value.trim() !== explanation,
  );
  return (
    <>
      <p>{explanation}</p>
      {(details.length > 0 || developerUrl) && (
        <details className="developer-details">
          <summary>Details for developers</summary>
          {details.map((value) => (
            <p key={value}>{value}</p>
          ))}
          {developerUrl && (
            <a href={developerUrl} target="_blank" rel="noopener noreferrer">
              View code review on GitHub <Icon name="external" size={12} />
            </a>
          )}
        </details>
      )}
    </>
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
  const startUrl = session.user
    ? "/start"
    : session.capabilities.github
      ? "/auth/github?returnTo=%2Fstart"
      : "#get-started";
  return (
    <div className="landing">
      <header className="site-header">
        <Brand />
        <span className="header-note">Good ideas are a team sport.</span>
        <a
          className="button ghost compact"
          href={session.user ? "/projects" : startUrl}
        >
          {session.user ? "My projects" : "Get started"}{" "}
          <Icon name="arrow" size={16} />
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
            <em>One website.</em>
          </h1>
          <p className="hero-description">
            Building together should be as easy as sharing a link. One person
            connects the tools. Everyone else scans a QR code and starts
            creating — by typing or talking, right from their phone.
          </p>
          {error && <Alert>{error}</Alert>}
          <div id="get-started" className="hero-actions">
            <a
              className={
                "button primary" +
                (!session.user && !session.capabilities.github
                  ? " disabled"
                  : "")
              }
              href={startUrl}
              aria-disabled={!session.user && !session.capabilities.github}
            >
              <Icon name="github" />
              {session.user ? "Start a project" : "Start with GitHub"}
              <Icon name="arrow" size={18} />
            </a>
            <a className="button ghost" href="#try-butler">
              See how it works <Icon name="arrow" size={16} />
            </a>
          </div>
          {!session.capabilities.github && (
            <p className="setup-note">
              Sign-in is being prepared. Watch the product demo while we get
              ready.
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
        <LandingTour />
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
            Type or dictate a change. Try the preview. Say “Make this the
            website” when you’re happy with it.
          </p>
        </div>
      </section>
      <section className="landing-benefits" aria-label="Why build with Butler">
        <div className="landing-benefits-heading">
          <span className="eyebrow">EVERY VOICE CAN MAKE SOMETHING</span>
          <h2>
            One project.
            <br />
            <em>Your whole team, building.</em>
          </h2>
        </div>
        <div className="landing-benefit-grid">
          <article>
            <span>↗</span>
            <h3>Invite, don’t install.</h3>
            <p>
              One link or QR code is all your teammates need. No terminal, tool
              setup, or coding experience. Just a name and an idea.
            </p>
          </article>
          <article>
            <span>✳</span>
            <h3>See it happen together.</h3>
            <p>
              Each person gets a Butler. Follow each other’s chats, see what’s
              being made, and try changes on the same shared website.
            </p>
          </article>
          <article>
            <span>✓</span>
            <h3>Try it. Then make it live.</h3>
            <p>
              A preview first, your say next. Butler checks approved changes and
              updates the website for everyone.
            </p>
          </article>
        </div>
      </section>
      <section className="landing-ownership">
        <div>
          <span className="eyebrow">QUICK TO START. YOURS TO KEEP.</span>
          <h2>
            Start with a little vibe.
            <br />
            Take it as far as you like.
          </h2>
          <p>
            Your code stays in your GitHub. Underneath the easy experience are
            real pull requests, reviews, and automatic publishing. Bring in your
            usual development tools whenever you’re ready. Butler stays with
            you.
          </p>
        </div>
        <a className="button primary" href={startUrl}>
          Bring your team <Icon name="arrow" size={17} />
        </a>
      </section>
      <footer className="site-footer">
        <Brand small />
        <span>A little help, for everyone.</span>
        <small>Build {session.commit.slice(0, 7)}</small>
      </footer>
    </div>
  );
}

function OnboardingProgress({ step }: { step: number }) {
  return (
    <ol className="onboarding-progress" aria-label="Setup progress">
      {["GitHub", "Hosting", "Your idea", "Codex"].map((label, index) => (
        <li
          key={label}
          className={
            index < step ? "complete" : index === step ? "current" : ""
          }
          aria-current={index === step ? "step" : undefined}
        >
          <span>
            {index < step ? <Icon name="check" size={13} /> : index + 1}
          </span>
          <strong>{label}</strong>
        </li>
      ))}
    </ol>
  );
}
function ProjectCards({ projects }: { projects: Summary[] }) {
  return (
    <section className="projects-section">
      <div className="section-title">
        <h2>Your projects</h2>
      </div>
      <div className="project-cards">
        {projects.map((p, index) => (
          <button
            key={p.id}
            className={`project-card project-tone-${index % 3}`}
            onClick={() => navigate(`/p/${p.id}`)}
          >
            <span className="project-monogram">
              {p.name.slice(0, 1).toUpperCase()}
            </span>
            <h3>{p.name}</h3>
            <p>{p.description}</p>
            <span className="project-card-foot">
              Open your workspace
              <Icon name="arrow" size={16} />
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
type BoatConnectionState = {
  state: string;
  url?: string;
  code?: string;
  message?: string;
};
function BoatConnection({ onConnected }: { onConnected: () => Promise<void> }) {
  const [connection, setConnection] = useState<BoatConnectionState>({
      state: "loading",
    }),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const halted = useRef(false);
  useEffect(() => {
    let alive = true;
    const check = () =>
      halted.current
        ? Promise.resolve()
        : api<BoatConnectionState>("/api/auth/boat")
            .then((value) => {
              if (!alive) return;
              setConnection(value);
              setError("");
              if (value.state === "connected") onConnected();
            })
            .catch((e) => {
              if (alive) {
                halted.current = true;
                setConnection({ state: "signed_out" });
                setError(e.message);
              }
            });
    check();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") check();
    }, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [onConnected]);
  async function start() {
    halted.current = false;
    setBusy(true);
    setError("");
    try {
      setConnection(await api<BoatConnectionState>("/api/auth/boat", {}));
    } catch (e) {
      halted.current = true;
      setConnection({ state: "signed_out" });
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="boat-connection">
      {error && <Alert>{error}</Alert>}
      {connection.state === "pending" && connection.url ? (
        <>
          <p>
            Open Boat and sign in with your own account. Enter this Boat device
            code when asked:
          </p>
          <div className="device-code">
            <strong>{connection.code}</strong>
          </div>
          <a
            className="button primary full"
            href={connection.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open Boat sign-in
            <Icon name="external" size={17} />
          </a>
          <p className="quiet-note">
            Return here afterward. This step updates automatically.
          </p>
        </>
      ) : connection.state === "billing" && connection.url ? (
        <>
          <p>{connection.message}</p>
          <a
            className="button primary full"
            href={connection.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Activate my Boat account
            <Icon name="external" size={17} />
          </a>
          <p className="quiet-note">
            Check Boat’s trial and payment terms before confirming. Return here
            when activation is complete.
          </p>
        </>
      ) : connection.state === "connected" ? (
        <p className="inline-status">
          <Spinner />
          Your hosting is ready…
        </p>
      ) : connection.state === "loading" && !error ? (
        <p className="inline-status">
          <Spinner />
          Checking your Boat account…
        </p>
      ) : (
        <>
          <p>
            Sign in to Boat, then Butler will create your team’s workspace. No
            API key to copy.
          </p>
          <button
            className="button primary full"
            disabled={busy}
            onClick={start}
          >
            {busy ? <Spinner /> : <Icon name="link" />}
            {busy
              ? "Preparing sign-in…"
              : connection.state === "expired" || error
                ? "Try Boat sign-in again"
                : "Continue with Boat"}
            <Icon name="arrow" size={18} />
          </button>
        </>
      )}
    </div>
  );
}

function Dashboard({
  session,
  refresh,
  authError,
  listOnly = false,
}: {
  session: Session;
  refresh: () => Promise<void>;
  authError: string;
  listOnly?: boolean;
}) {
  const [projectsLoaded, setProjectsLoaded] = useState(false),
    [memberSaving, setMemberSaving] = useState(false);
  const [projects, setProjects] = useState<Summary[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>(
      [],
    ),
    [workspace, setWorkspace] = useState(""),
    [hostingConfirmed, setHostingConfirmed] = useState(false),
    [hostingLoaded, setHostingLoaded] = useState(false),
    [hostingFailed, setHostingFailed] = useState(false),
    [hostingReconnect, setHostingReconnect] = useState(false),
    [hostingAttempt, setHostingAttempt] = useState(0);
  const [description, setDescription] = useState(
    () => localStorage.getItem("butler-project-idea") || "",
  );
  const [createKey] = useState(() => {
    const key =
      sessionStorage.getItem("butler-create-key") || crypto.randomUUID();
    sessionStorage.setItem("butler-create-key", key);
    return key;
  });
  const useBoat = session.hostingProvider !== "railway";
  const workspaceKey = `butler-hosting-${session.user!.id}`;
  useEffect(() => {
    let alive = true;
    api<{ projects: Summary[] }>("/api/projects")
      .then(({ projects: found }) => {
        if (!alive) return;
        setProjects(found);
      })
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setProjectsLoaded(true));
    return () => {
      alive = false;
    };
  }, [session.user?.id]);
  useEffect(() => {
    localStorage.setItem("butler-project-idea", description);
  }, [description]);
  useEffect(() => {
    if (listOnly || useBoat || !session.connections.railway) return;
    let alive = true;
    setHostingLoaded(false);
    setHostingFailed(false);
    setHostingReconnect(false);
    api<{ id: string; name: string }[]>("/api/railway/workspaces")
      .then((found) => {
        if (!alive) return;
        setWorkspaces(found);
        const saved = localStorage.getItem(workspaceKey);
        const selected =
          found.length === 1
            ? found[0].id
            : found.find((w) => w.id === saved)?.id || "";
        setWorkspace(selected);
        setHostingConfirmed(Boolean(selected));
      })
      .catch((e) => {
        if (alive) {
          setError(e.message);
          setHostingFailed(true);
          setHostingReconnect(
            e instanceof ApiError && [401, 403].includes(e.status),
          );
        }
      })
      .finally(() => alive && setHostingLoaded(true));
    return () => {
      alive = false;
    };
  }, [
    listOnly,
    useBoat,
    session.connections.railway,
    workspaceKey,
    hostingAttempt,
  ]);
  const memberOnly = listOnly;
  const step =
    !session.user?.githubLogin || !session.connections.github
      ? 0
      : useBoat
        ? !session.connections.boat
          ? 1
          : 2
        : !session.connections.railway || !hostingLoaded || !hostingConfirmed
          ? 1
          : 2;
  const githubAvailable = session.user?.githubLogin
    ? session.capabilities.githubRepositories
    : session.capabilities.github;
  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (step !== 2 || busy) return;
    setError("");
    setBusy(true);
    try {
      const result = await api<{ id: string }>("/api/projects", {
        name: "Your new project",
        generateName: true,
        description,
        requestKey: createKey,
        workspaceId: useBoat ? undefined : workspace,
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
    navigate("/", true);
  }
  if (!projectsLoaded)
    return (
      <div className="loading-page">
        <Brand />
        <Spinner />
        <p>Finding your workspace…</p>
      </div>
    );
  return (
    <div className="dashboard">
      <header className="site-header">
        <Brand />
        <div className="account-menu">
          {listOnly && (
            <a className="button ghost compact" href="/start">
              <Icon name="plus" size={15} />
              New project
            </a>
          )}
          <Avatar name={session.user!.name} />
          <span>{session.user!.name.split(" ")[0]}</span>
          {session.user?.isGuest ? (
            <button
              className="icon-button"
              aria-label="Save your access"
              onClick={() => setMemberSaving(true)}
            >
              <Icon name="lock" />
            </button>
          ) : (
            <button
              className="icon-button"
              onClick={logout}
              aria-label="Sign out"
            >
              <Icon name="logout" />
            </button>
          )}
        </div>
      </header>
      {memberOnly ? (
        <main className="dashboard-main">
          <h1>Your projects.</h1>
          <p className="page-description">
            Pick up your conversation and keep making things together.
          </p>
          <ProjectCards projects={projects} />
        </main>
      ) : (
        <main className="dashboard-main onboarding-main">
          <OnboardingProgress step={step} />
          <div className="eyebrow">STEP {step + 1} OF 4</div>
          <h1>
            {step === 0
              ? "First, your GitHub."
              : step === 1
                ? "A home for your app."
                : "What would you like to build?"}
          </h1>
          <p className="page-description">
            {step === 0
              ? "Let Butler create and save your project for you."
              : step === 1
                ? `Butler uses your ${useBoat ? "Boat" : "Railway"} account to keep your website and your team’s Butlers running.`
                : "Describe the idea in your own words. Butler will set everything up."}
          </p>
          {(error || authError) && <Alert>{error || authError}</Alert>}
          {step === 0 && (
            <section className="create-card onboarding-card">
              <span className="round-icon">
                <Icon name="github" />
              </span>
              <h2>Butler handles the project files.</h2>
              <p>
                We’ll create a new private GitHub repository for your project.
                If GitHub asks you to add it to Butler, approve only that
                project. Setup continues automatically when you return.
              </p>
              <a
                className={
                  "button primary full" + (!githubAvailable ? " disabled" : "")
                }
                aria-disabled={!githubAvailable}
                href={
                  githubAvailable
                    ? session.user?.githubLogin
                      ? "/auth/github/install?returnTo=%2Fstart"
                      : "/auth/github?returnTo=%2Fstart"
                    : undefined
                }
              >
                {session.user?.githubLogin
                  ? "Allow Butler to set up my project"
                  : "Continue with GitHub"}
                <Icon name="arrow" size={18} />
              </a>
              <p className="quiet-note">
                {githubAvailable
                  ? "Keep access limited to selected repositories. Butler will tell you which new project to approve if GitHub asks."
                  : "GitHub setup is being finished. Please try again shortly."}
              </p>
            </section>
          )}
          {step === 1 && useBoat && (
            <section className="create-card onboarding-card">
              <span className="round-icon">
                <Icon name="grid" />
              </span>
              <h2>Let Butler prepare your workspace.</h2>
              <BoatConnection onConnected={refresh} />
            </section>
          )}
          {step === 1 && !useBoat && (
            <section className="create-card onboarding-card">
              <span className="round-icon">
                <Icon name="railway" />
              </span>
              <h2>
                {session.connections.railway && workspaces.length > 1
                  ? "Choose where it should live."
                  : "Let Butler publish your app."}
              </h2>
              {!session.connections.railway ||
              hostingReconnect ||
              (hostingLoaded && !hostingFailed && workspaces.length === 0) ? (
                <>
                  <p>
                    Approve Railway access, then you’ll come straight back to
                    your idea.
                  </p>
                  <a
                    className={
                      "button primary full" +
                      (!session.capabilities.railway ? " disabled" : "")
                    }
                    aria-disabled={!session.capabilities.railway}
                    href={
                      session.capabilities.railway
                        ? "/auth/railway?returnTo=%2Fstart"
                        : undefined
                    }
                  >
                    Continue with Railway
                    <Icon name="arrow" size={18} />
                  </a>
                  {!session.capabilities.railway && (
                    <p className="quiet-note">
                      Railway setup is being finished. Please try again shortly.
                    </p>
                  )}
                </>
              ) : !hostingLoaded ? (
                <p className="inline-status">
                  <Spinner />
                  Checking your Railway account…
                </p>
              ) : hostingFailed ? (
                <button
                  className="button primary full"
                  onClick={() => {
                    setError("");
                    setHostingAttempt((n) => n + 1);
                  }}
                >
                  Try again
                  <Icon name="refresh" size={18} />
                </button>
              ) : (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (workspace) {
                      localStorage.setItem(workspaceKey, workspace);
                      setHostingConfirmed(true);
                    }
                  }}
                >
                  <label htmlFor="hosting-workspace">
                    Your Railway workspace
                  </label>
                  <select
                    id="hosting-workspace"
                    value={workspace}
                    onChange={(event) => setWorkspace(event.target.value)}
                    required
                  >
                    <option value="">Choose a workspace</option>
                    {workspaces.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                  <button className="button primary full" disabled={!workspace}>
                    Continue
                    <Icon name="arrow" size={18} />
                  </button>
                </form>
              )}
            </section>
          )}
          {step === 2 && (
            <form className="create-card onboarding-card" onSubmit={create}>
              <label htmlFor="project-idea">Your idea</label>
              <textarea
                id="project-idea"
                autoFocus
                placeholder="A website for our supper club, with upcoming dinners and a way to join…"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={10000}
                rows={5}
                required
                minLength={3}
              />
              <button
                className="button primary full"
                disabled={busy || description.trim().length < 3}
              >
                {busy ? <Spinner /> : <Icon name="spark" />}
                {busy ? "Creating your project…" : "Create my project"}
                {!busy && <Icon name="arrow" size={18} />}
              </button>
              <p className="quiet-note">
                Next: sign in to Codex, then invite your team.
              </p>
            </form>
          )}
          {projects.length > 0 && <ProjectCards projects={projects} />}
        </main>
      )}
      {memberSaving && projects.length > 0 && (
        <SaveAccess
          session={session}
          projectId={projects[0].id}
          onClose={() => setMemberSaving(false)}
        />
      )}
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

function ShareWebsite({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const [share, setShare] = useState<{ url: string; qr: string } | null>(null),
    [message, setMessage] = useState("");
  useEffect(() => {
    api<{ url: string; qr: string }>(`/api/projects/${projectId}/share`)
      .then(setShare)
      .catch((e) => setMessage(e.message));
  }, [projectId]);
  return (
    <Modal title="Share the current website." onClose={onClose}>
      <p>
        Scan to open the live website on any phone. Anyone can look — they won’t
        be joining your team.
      </p>
      {share ? (
        <>
          <span className="share-live-label">CURRENT WEBSITE · LIVE</span>
          <img
            className="share-website-qr"
            src={share.qr}
            alt="QR code for the current website"
          />
          <input
            className="copy-input"
            aria-label="Current website link"
            readOnly
            value={share.url}
            onFocus={(event) => event.target.select()}
          />
          <button
            className="button primary full"
            onClick={() =>
              copy(share.url)
                .then(() => setMessage("Website link copied."))
                .catch((e) => setMessage(e.message))
            }
          >
            <Icon name="copy" size={16} />
            Copy website link
          </button>
          <a
            className="text-button share-open-link"
            href={share.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open website <Icon name="external" size={13} />
          </a>
        </>
      ) : (
        !message && <Spinner />
      )}
      {message && (
        <p className="inline-status" role="status">
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
        {connection.message && <ButlerText text={connection.message} />}
        {error && (
          <div role="alert">
            <ButlerText text={error} kind="error" />
          </div>
        )}
      </div>
    </div>
  );
}
const jobLabel: Record<string, string> = {
  queued: "Waiting to start",
  working: "Making your changes",
  reviewing: "Checking your changes",
  building_preview: "Preparing preview",
  awaiting_approval: "Ready to try",
  creating_pr: "Preparing to publish",
  deploying: "Updating website",
  live: "On the website",
  unchanged: "Done",
  failed: "Butler paused",
  preview_failed: "Preview couldn’t load",
  publish_failed: "Website hasn’t updated",
  needs_attention: "Changes need more work",
};
function elapsed(start: number, end: number) {
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  return seconds < 60
    ? `${seconds}s`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
      : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
function statusLabel(job: Pick<Job, "state" | "error">) {
  return job.state === "needs_attention" &&
    /bwrap|namespace|Review could not|reviewer process|review.*retry|review.*paused/i.test(
      job.error || "",
    )
    ? "Website checks paused"
    : jobLabel[job.state] || "Getting ready";
}
function JobState({ job, clock = Date.now() }: { job: Job; clock?: number }) {
  return (
    <span className={"job-state state-" + job.state}>
      {["live", "unchanged"].includes(job.state) ? (
        <Icon name="check" size={12} />
      ) : [
          "working",
          "reviewing",
          "deploying",
          "building_preview",
          "creating_pr",
        ].includes(job.state) ? (
        <Spinner />
      ) : (
        <i />
      )}
      {statusLabel(job)}
      {job.startedAt && (
        <span className="elapsed" aria-label="Elapsed time">
          {" "}
          · {elapsed(job.startedAt, job.finishedAt || clock)}
        </span>
      )}
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
    [sharingWebsite, setSharingWebsite] = useState(false),
    [saving, setSaving] = useState(false),
    [tab, setTab] = useState("chat"),
    [teamSection, setTeamSection] = useState("activity"),
    [sidebarOpen, setSidebarOpen] = useState(true),
    [websiteExpanded, setWebsiteExpanded] = useState(false),
    [sending, setSending] = useState(false),
    [codexReady, setCodexReady] = useState(false),
    [memberId, setMemberId] = useState(""),
    [chatId, setChatId] = useState(""),
    [clock, setClock] = useState(Date.now());
  const [text, setText] = useState(
    () => localStorage.getItem(`butler-draft-${projectId}`) || "",
  );
  const conversation = useRef<HTMLDivElement>(null),
    textarea = useRef<HTMLTextAreaElement>(null),
    lastMessage = useRef(""),
    lastChat = useRef(""),
    scrollAfterSend = useRef(false),
    pendingKey = useRef<{ text: string; key: string } | null>(null),
    lastLive = useRef("");
  const [previewVersion, setPreviewVersion] = useState("");
  const [frameReload, setFrameReload] = useState(0);
  const [artifact, setArtifact] = useState<Job | null>(null);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [inspection, setInspection] = useState("");
  const workspaceVisible = Boolean(
    project &&
      !(
        project.isOwner &&
        !project.codingReady &&
        !codexReady &&
        (project.state !== "ready" ||
          project.jobs.every(
            (job) => job.requestKey === "initial" && job.state === "queued",
          ))
      ),
  );
  useEffect(
    () => (workspaceVisible ? attachWorkspaceViewport() : undefined),
    [workspaceVisible],
  );
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector("dialog[open]"))
        setWebsiteExpanded(false);
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, []);
  const refresh = useCallback(async () => {
    try {
      const data = await api<Project>(
        `/api/projects/${projectId}?${new URLSearchParams({ ...(memberId ? { member: memberId } : {}), ...(chatId ? { chat: chatId } : {}) })}`,
      );
      setProject(data);
      setError("");
      const live =
        data.releases?.find((release) => release.isLive)?.sha ||
        data.jobs.filter((j) => j.state === "live").at(-1)?.id;
      if (live && lastLive.current !== live) {
        lastLive.current = live;
        setPreviewVersion(live);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projectId, memberId, chatId]);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  function viewChat(id: string) {
    if (!project) return;
    if (project.ownMemberships.some((m) => m.id === id)) {
      setMemberId(id);
      setChatId("");
    } else setChatId(id);
    setTab("chat");
    setSidebarOpen(true);
  }
  function selectPanel(value: string) {
    setTab(value);
    setSidebarOpen(true);
    if (value === "team") setTeamSection("activity");
    if (value === "updates") setTeamSection("updates");
  }
  const connected = useCallback(() => setCodexReady(true), []);
  useEffect(() => {
    if (project?.hostingProvider !== "boat") return;
    const wake = () => {
      if (document.visibilityState === "visible")
        api(`/api/projects/${projectId}/wake`, {}).catch(() => {});
    };
    wake();
    const timer = setInterval(wake, 60000);
    window.addEventListener("focus", wake);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", wake);
    };
  }, [project?.hostingProvider, projectId]);
  useEffect(() => {
    if (project?.state !== "github_access" || !project.isOwner) return;
    let checkedAt = 0,
      checking = false,
      alive = true;
    const check = () => {
      if (
        document.visibilityState !== "visible" ||
        checking ||
        Date.now() - checkedAt < 3000
      )
        return;
      checkedAt = Date.now();
      checking = true;
      api<{ ready: boolean }>(`/api/projects/${projectId}/github-access`, {})
        .then((value) => {
          if (alive && value.ready) return refresh();
        })
        .catch((e) => {
          if (alive) setError(e.message);
        })
        .finally(() => {
          checking = false;
        });
    };
    check();
    const timer = setInterval(check, 10000);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [project?.state, project?.isOwner, projectId, refresh]);
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
  useLayoutEffect(() => {
    const latest = project?.messages.at(-1)?.id;
    const chat = project?.chatMember?.id || project?.member.id;
    if (latest && latest !== lastMessage.current) {
      lastMessage.current = latest;
      const panel = conversation.current;
      if (
        panel &&
        (scrollAfterSend.current ||
          lastChat.current !== chat ||
          panel.scrollHeight - panel.scrollTop - panel.clientHeight < 140)
      )
        panel.scrollTo({
          top: panel.scrollHeight,
          behavior: lastChat.current === chat ? "smooth" : "auto",
        });
      lastChat.current = chat || "";
      scrollAfterSend.current = false;
    }
  }, [project?.messages]);
  async function send(event?: React.FormEvent) {
    event?.preventDefault();
    if (
      !text.trim() ||
      sending ||
      !project ||
      project.readOnly ||
      (chatId && chatId !== project.member.id)
    )
      return;
    setSending(true);
    setError("");
    const draft = text;
    const request =
      pendingKey.current?.text === draft
        ? pendingKey.current
        : { text: draft, key: crypto.randomUUID() };
    pendingKey.current = request;
    scrollAfterSend.current = true;
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
  function inspect(job: Job) {
    setArtifact(job);
    setInspection("");
    setTab("preview");
  }
  function showCurrentWebsite() {
    setArtifact(null);
    setTab("preview");
  }
  async function markInspected(job: Job) {
    if (
      !project ||
      job.memberId !== project.member.id ||
      job.state !== "awaiting_approval"
    )
      return;
    try {
      await api(
        `/api/projects/${projectId}/jobs/${job.id}/inspect${memberId ? "?member=" + memberId : ""}`,
        { sha: job.changeSha },
      );
      setInspection(job.id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function approve(job: Job) {
    setApprovalBusy(true);
    setError("");
    try {
      await api(
        `/api/projects/${projectId}/jobs/${job.id}/approve${memberId ? "?member=" + memberId : ""}`,
        { sha: job.changeSha },
      );
      setArtifact(null);
      setTab("chat");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setApprovalBusy(false);
    }
  }
  async function retryPreview(job: Job) {
    try {
      await api(
        `/api/projects/${projectId}/jobs/${job.id}/retry${memberId ? "?member=" + memberId : ""}`,
        {},
      );
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function react(
    targetType: ReactionTarget,
    targetId: string,
    emoji: string,
    active: boolean,
  ) {
    try {
      const response = await api<{ reactions: ReactionSummary }>(
        `/api/projects/${projectId}/reactions${memberId ? "?member=" + memberId : ""}`,
        { targetType, targetId, emoji, active },
      );
      setProject((current) =>
        current?.id === projectId
          ? { ...current, reactions: response.reactions }
          : current,
      );
    } catch (error) {
      setError((error as Error).message);
      throw error;
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
  const chatMember = project.chatMember || project.member,
    readOnly = Boolean(project.readOnly);
  const shownArtifact = artifact
    ? project.jobs.find((j) => j.id === artifact.id) || artifact
    : null;
  const canApprove =
    shownArtifact?.memberId === project.member.id &&
    shownArtifact?.state === "awaiting_approval";
  const latestPreview = project.jobs.filter((job) => jobPreviewUrl(job)).at(-1);
  const websiteUrl = shownArtifact
    ? jobPreviewUrl(shownArtifact)
    : project.appUrl;
  const firstSetup =
    project.isOwner &&
    !project.codingReady &&
    !codexReady &&
    (preparing ||
      project.jobs.every(
        (job) => job.requestKey === "initial" && job.state === "queued",
      ));
  if (firstSetup)
    return (
      <div className="dashboard">
        <header className="site-header">
          <Brand />
          <span className="header-note">{project.name}</span>
        </header>
        <main className="dashboard-main onboarding-main">
          <OnboardingProgress step={3} />
          <div className="eyebrow">STEP 4 OF 4</div>
          <h1>
            {project.githubAccess
              ? "Approve your project on GitHub."
              : preparing
                ? "We’re setting things up."
                : "One last sign-in."}
          </h1>
          <p className="page-description">
            {preparing
              ? "Your idea is saved. Butler is creating your project and getting your team’s workspace ready."
              : "Connect your Codex subscription once. Then invite everyone to their own Butler."}
          </p>
          <section className="create-card onboarding-card">
            {project.githubAccess ? (
              <>
                <p>
                  Your project files are created. GitHub needs your approval
                  before Butler can finish setup.
                </p>
                <p>
                  Keep <strong>Only select repositories</strong>, add{" "}
                  <strong style={{ overflowWrap: "anywhere" }}>
                    {project.githubAccess.repo.split("/")[1]}
                  </strong>
                  , then click Save.
                </p>
                <a
                  className="button primary full"
                  href={project.githubAccess.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Approve project access <Icon name="external" size={18} />
                </a>
                <p className="quiet-note">
                  Come back here afterward. Butler will resume your saved
                  project.
                </p>
              </>
            ) : preparing ? (
              <>
                <p className="inline-status" role="status">
                  <Spinner />
                  {project.state === "repository"
                    ? "Creating your project files…"
                    : project.state === "failed"
                      ? "Setup needs another try."
                      : "Preparing your workspace…"}
                </p>
                {project.error && <Alert>{project.error}</Alert>}
                {["failed", "retrying"].includes(project.state) && (
                  <button className="button primary full" onClick={retry}>
                    Try again
                    <Icon name="refresh" size={18} />
                  </button>
                )}
              </>
            ) : (
              <CodexConnection project={project} onConnected={connected} />
            )}
          </section>
          {error && <Alert>{error}</Alert>}
        </main>
      </div>
    );
  return (
    <div
      className={
        "workspace-shell" +
        (tab === "preview" ? " viewing-website" : "") +
        (websiteExpanded ? " website-expanded" : "")
      }
    >
      <header className="workspace-header">
        <Brand small />
        <span className="header-divider" />
        <div className="project-identity">
          <strong>{project.name}</strong>
          <small>Your shared creation</small>
        </div>
        <nav className="desktop-workspace-nav" aria-label="Workspace panels">
          {[
            ["chat", "chat", "Chat"],
            ["team", "users", "Team"],
            ["updates", "check", "Updates"],
          ].map(([value, icon, label]) => (
            <button
              key={value}
              aria-pressed={
                sidebarOpen &&
                (value === "chat"
                  ? !["team", "updates"].includes(tab)
                  : tab === value)
              }
              onClick={() => selectPanel(value)}
            >
              <Icon name={icon} size={15} />
              {label}
            </button>
          ))}
        </nav>
        <div className="workspace-header-actions">
          <button
            className="avatar-stack team-toggle"
            aria-label="Show your team"
            onClick={() => selectPanel(tab === "team" ? "chat" : "team")}
          >
            {project.members.slice(0, 4).map((m, i) => (
              <Avatar key={m.id} name={m.name} index={i} />
            ))}
          </button>
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
          ["chat", "chat", "Your chat"],
          ["preview", "grid", "Website"],
          ["team", "users", "Team"],
          ["updates", "check", "Updates"],
        ].map(([value, icon, label]) => (
          <button
            key={value}
            role="tab"
            aria-selected={tab === value}
            className={tab === value ? "selected" : ""}
            onClick={() => selectPanel(value)}
          >
            <Icon name={icon} size={16} />
            {label}
          </button>
        ))}
      </div>
      <main
        className={
          "project-layout tab-" + tab + (sidebarOpen ? "" : " sidebar-closed")
        }
      >
        <section
          className={
            "preview-panel" +
            (shownArtifact ? " showing-preview" : " showing-current")
          }
          aria-label="Website viewer"
        >
          <div className="website-toolbar">
            <button
              className="icon-button viewer-back"
              aria-label="Back to chat"
              title="Back to chat"
              onClick={() => {
                setWebsiteExpanded(false);
                selectPanel("chat");
              }}
            >
              <Icon name="arrow" size={18} />
            </button>
            <select
              className="website-version-picker"
              aria-label="Website version"
              title={shownArtifact?.prTitle || "Choose which website to view"}
              value={shownArtifact ? "preview" : "current"}
              onChange={(event) => {
                if (event.target.value === "current") showCurrentWebsite();
                else {
                  const job = shownArtifact || latestPreview;
                  if (job) inspect(job);
                }
              }}
            >
              <option value="current">
                Current website · {project.appUrl ? "Live" : "Getting ready"}
              </option>
              <option
                value="preview"
                disabled={!latestPreview && !shownArtifact}
              >
                Change preview ·{" "}
                {shownArtifact?.state === "live" ? "Copy" : "Not live"}
              </option>
            </select>
            <div className="website-toolbar-actions">
              <button
                className="icon-button"
                disabled={!websiteUrl}
                onClick={() => setFrameReload((value) => value + 1)}
                aria-label={
                  shownArtifact
                    ? "Refresh change preview"
                    : "Refresh current website"
                }
                title="Refresh website"
              >
                <Icon name="refresh" size={16} />
              </button>
              <button
                className="icon-button"
                disabled={!project.appUrl}
                onClick={() => setSharingWebsite(true)}
                aria-label="Share current website"
                title="Share current website"
              >
                <Icon name="share" size={16} />
              </button>
              {websiteUrl && (
                <a
                  className="icon-button"
                  href={websiteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={
                    shownArtifact
                      ? "Open change preview in new tab"
                      : "Open current website in new tab"
                  }
                  title="Open in new tab"
                >
                  <Icon name="external" size={16} />
                </a>
              )}
              <button
                className="icon-button viewer-expand"
                onClick={() => setWebsiteExpanded((value) => !value)}
                aria-label={
                  websiteExpanded ? "Exit expanded website" : "Expand website"
                }
                title={
                  websiteExpanded ? "Exit expanded website" : "Expand website"
                }
              >
                <Icon name={websiteExpanded ? "close" : "expand"} size={17} />
              </button>
            </div>
          </div>
          {error && (
            <div className="viewer-error">
              <Alert>{error}</Alert>
              <button
                className="icon-button"
                aria-label="Dismiss website notice"
                onClick={() => setError("")}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
          )}
          <div className="preview-surface">
            {websiteUrl ? (
              <iframe
                key={
                  shownArtifact
                    ? shownArtifact.id + shownArtifact.changeSha + frameReload
                    : previewVersion + frameReload
                }
                src={
                  websiteUrl +
                  (!shownArtifact && previewVersion
                    ? "?butler=" + previewVersion
                    : "")
                }
                title={
                  project.name +
                  (shownArtifact ? " — change preview" : " — current website")
                }
                onLoad={() => {
                  if (shownArtifact) markInspected(shownArtifact);
                }}
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
            {shownArtifact && websiteUrl && (
              <div className="preview-reactions">
                <Reactions
                  key={shownArtifact.id}
                  targetType="preview"
                  targetId={shownArtifact.id}
                  summary={project.reactions}
                  onReact={react}
                />
              </div>
            )}
          </div>
          {canApprove && shownArtifact && (
            <div className="preview-approval">
              <span title={shownArtifact.prTitle}>
                {shownArtifact.prTitle || "Your change is ready to try"}
              </span>
              <button
                className="button primary compact"
                disabled={
                  approvalBusy ||
                  (!shownArtifact.inspectedAt &&
                    inspection !== shownArtifact.id)
                }
                onClick={() => approve(shownArtifact)}
              >
                {approvalBusy ? <Spinner /> : <Icon name="check" size={16} />}
                Make this the website
              </button>
            </div>
          )}
        </section>
        <section className="conversation-panel">
          <div className="panel-top">
            <div className="agent-heading">
              <span className="mini-butler">✳</span>
              <div>
                <strong>{chatMember.name}’s Butler</strong>
                <small>
                  {readOnly
                    ? "Watching your teammate’s chat"
                    : "Your chat · visible to your team"}
                </small>
              </div>
            </div>
            <div className="side-panel-actions">
              {project.members.length > 1 ? (
                <select
                  className="workspace-picker"
                  aria-label="Choose a team chat"
                  value={chatMember.id}
                  onChange={(e) => viewChat(e.target.value)}
                >
                  {project.members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                      {project.ownMemberships.some((own) => own.id === m.id)
                        ? " (you)"
                        : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="saved-label">
                  <Icon name="check" size={12} />
                  Saved
                </span>
              )}
              <button
                className="icon-button close-side-panel"
                aria-label="Hide chat"
                title="Hide chat"
                onClick={() => setSidebarOpen(false)}
              >
                <Icon name="close" size={16} />
              </button>
            </div>
          </div>
          <div className="conversation-scroll" ref={conversation}>
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
                    <div className="setup-error">
                      <ButlerText text={project.error} kind="error" />
                    </div>
                    <button className="text-button" onClick={retry}>
                      Try again <Icon name="refresh" size={13} />
                    </button>
                  </>
                )}
              </div>
            )}
            {project.isOwner &&
              !readOnly &&
              project.state === "ready" &&
              project.tasks
                .filter((task) => task.state === "failed")
                .map((task, index) => (
                  <Alert key={task.kind + index}>
                    <strong>
                      {task.kind === "worker-update"
                        ? "Butler couldn’t update its workspace"
                        : task.kind === "sync-history"
                          ? "Website history could not be loaded"
                          : task.kind === "artifact"
                            ? "Your preview isn’t ready yet"
                            : "Your website hasn’t updated yet"}
                    </strong>
                    <ButlerText
                      text={
                        task.error || "Your work is saved. Try this step again."
                      }
                      kind="error"
                    />
                    <button className="text-button" onClick={retry}>
                      Retry{" "}
                      {task.kind === "worker-update"
                        ? "workspace update"
                        : task.kind === "sync-history"
                          ? "history sync"
                          : task.kind === "artifact"
                            ? "preview"
                            : "publishing"}{" "}
                      <Icon name="refresh" size={13} />
                    </button>
                  </Alert>
                ))}
            {project.isOwner && !readOnly && (
              <CodexConnection project={project} onConnected={connected} />
            )}
            <div className="agent-welcome">
              <span className="mini-butler">✳</span>
              <div>
                <p>
                  {readOnly
                    ? `You’re watching ${chatMember.name}’s conversation.`
                    : `Hi ${project.member.name.split(" ")[0]}. What would you like to make?`}
                </p>
                <small>
                  {readOnly
                    ? "Everyone on this project can follow the work here. Send requests from your own chat."
                    : "Tell me in your own words. I’ll make a preview. Try it, then choose Make this the website when you’re happy with it."}
                </small>
              </div>
            </div>
            {chatBubbles(project.messages).map((message) => {
              const job = project.jobs.find((j) => j.id === message.jobId);
              return (
                <div
                  key={message.id}
                  className={
                    "message message-" +
                    message.role +
                    " message-kind-" +
                    (message.kind || "message")
                  }
                >
                  {message.role === "assistant" && (
                    <span className="mini-butler">✳</span>
                  )}
                  <div className="message-content">
                    {message.kind && message.kind !== "message" && (
                      <small className="message-caption">
                        {message.kind === "review"
                          ? "Website checks"
                          : message.kind === "error"
                            ? "Update failed"
                            : message.kind === "status"
                              ? "Butler"
                              : "Codex"}
                        {message.createdAt
                          ? ` · ${new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                          : ""}
                      </small>
                    )}
                    {message.role === "user" ? (
                      <p>{message.text}</p>
                    ) : (
                      <ButlerText
                        text={message.text}
                        kind={message.kind}
                        diagnostics={message.diagnostics}
                      />
                    )}
                    {message.role === "user" && job && (
                      <JobState job={job} clock={clock} />
                    )}
                    <Reactions
                      targetType="message"
                      targetId={message.id}
                      summary={project.reactions}
                      onReact={react}
                    />
                  </div>
                </div>
              );
            })}
            {latestJob?.error && (
              <Alert>
                <strong>{statusLabel(latestJob)}</strong>
                <ButlerText
                  text={latestJob.error}
                  kind="error"
                  developerUrl={latestJob.prUrl}
                />
                {!readOnly && latestJob.state === "preview_failed" ? (
                  <button
                    className="text-button"
                    onClick={() => retryPreview(latestJob)}
                  >
                    Retry {latestJob.approvedAt ? "publishing" : "preview"}{" "}
                    <Icon name="refresh" size={13} />
                  </button>
                ) : (
                  !readOnly &&
                  !/automatically|bwrap|namespace/i.test(latestJob.error) && (
                    <button
                      className="text-button"
                      onClick={() => {
                        setText(
                          "Please finish my changes and fix the problem you found.",
                        );
                        textarea.current?.focus({ preventScroll: true });
                      }}
                    >
                      Ask Butler to fix this <Icon name="arrow" size={13} />
                    </button>
                  )
                )}
              </Alert>
            )}
            {latestJob &&
              [
                "working",
                "reviewing",
                "deploying",
                "building_preview",
                "creating_pr",
              ].includes(latestJob.state) && (
                <div className="working-line">
                  <span className="mini-butler">✳</span>
                  <Spinner />
                  <span>
                    {latestJob.state === "working"
                      ? "Working on your idea…"
                      : latestJob.state === "building_preview"
                        ? "Building your preview…"
                        : latestJob.state === "creating_pr"
                          ? "Getting your change ready for the website…"
                          : latestJob.state === "reviewing"
                            ? "Making sure everything works together…"
                            : "Publishing your change…"}
                    {latestJob.startedAt &&
                      ` · ${elapsed(latestJob.startedAt, clock)}`}
                  </span>
                </div>
              )}
            {project.jobs
              .filter((j) => j.state === "awaiting_approval" && j.artifactUrl)
              .map((job) => (
                <article className="artifact-card" key={job.id}>
                  <span className="small-label">
                    PREVIEW READY · NOT PUBLISHED
                  </span>
                  <strong>{job.prTitle || "Your change is ready"}</strong>
                  <p>
                    {readOnly
                      ? "Your teammate can inspect and approve this change."
                      : "Try your change before it goes to the shared website."}
                  </p>
                  <button
                    className="button primary compact"
                    onClick={() => inspect(job)}
                  >
                    <Icon name="grid" size={16} />
                    Inspect preview <Icon name="arrow" size={16} />
                  </button>
                </article>
              ))}
            {project.jobs
              .filter((j) => j.previewUrl)
              .slice(-1)
              .map((job) => (
                <button
                  key={job.id}
                  className="preview-link"
                  onClick={() =>
                    job.state === "live" ? showCurrentWebsite() : inspect(job)
                  }
                >
                  <Icon name="grid" size={16} />
                  {job.state === "live"
                    ? "View current website"
                    : "View change preview"}
                  <Icon name="arrow" size={14} />
                </button>
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
          </div>
          {readOnly ? (
            <div className="composer read-only-notice">
              <p>You’re viewing {chatMember.name}’s chat.</p>
              <button
                className="button secondary full"
                onClick={() => viewChat(project.member.id)}
              >
                Back to my chat <Icon name="arrow" size={16} />
              </button>
            </div>
          ) : (
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
                    : !project.codingReady
                      ? "Your lead is connecting Codex. Requests wait safely."
                      : "Type it. Dictate it. Make it happen."}
                </span>
                <span>↵ ⌘ / Ctrl</span>
              </div>
            </form>
          )}
        </section>
        <section className="team-panel" aria-label="Team and website updates">
          <div className="panel-top">
            <strong>
              {teamSection === "updates" ? "Website updates" : "Your team"}
            </strong>
            <span>{project.members.length}</span>
            <button
              className="icon-button close-side-panel"
              aria-label="Hide team panel"
              title="Hide team panel"
              onClick={() => setSidebarOpen(false)}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
          <div
            className="team-section-switch"
            role="tablist"
            aria-label="Team views"
          >
            <button
              role="tab"
              aria-selected={teamSection === "activity"}
              onClick={() => selectPanel("team")}
            >
              People & activity
            </button>
            <button
              role="tab"
              aria-selected={teamSection === "updates"}
              onClick={() => selectPanel("updates")}
            >
              Website updates
            </button>
          </div>
          <div className="team-content">
            {teamSection === "activity" ? (
              <div className="team-overview">
                <section className="team-roster" aria-label="Team members">
                  <div className="team-section-heading">
                    <h3>People</h3>
                    <p>Your teammates and their Butlers.</p>
                  </div>
                  {project.members.map((member, i) => (
                    <div className="team-member" key={member.id}>
                      <Avatar name={member.name} index={i} />
                      <div>
                        <strong>{member.name}</strong>
                        <small>
                          {member.agentState
                            ? `${statusLabel({ state: member.agentState })}${member.startedAt ? ` · ${elapsed(member.startedAt, member.finishedAt || clock)}` : ""}`
                            : member.role === "owner"
                              ? "Team lead"
                              : "Teammate"}
                        </small>
                      </div>
                      <button
                        className="text-button"
                        onClick={() => viewChat(member.id)}
                      >
                        {project.ownMemberships.some((m) => m.id === member.id)
                          ? "My chat"
                          : "View chat"}
                      </button>
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
                </section>
                <section className="team-activity" aria-label="Team activity">
                  <div className="team-section-heading">
                    <h3>Team activity</h3>
                    <p>Requests and work in progress.</p>
                  </div>
                  {project.activity.length === 0 && (
                    <p className="quiet-note">
                      Your team’s requests will appear here.
                    </p>
                  )}
                  {project.activity.map((job) => (
                    <div className="activity-item" key={job.id}>
                      <button
                        className="text-button"
                        onClick={() => job.memberId && viewChat(job.memberId)}
                      >
                        <strong>{job.name}</strong>
                      </button>
                      <p>{job.text}</p>
                      <JobState job={job} clock={clock} />
                    </div>
                  ))}
                </section>
              </div>
            ) : (
              <div className="release-history">
                <div className="team-section-heading">
                  <h3>Website updates</h3>
                  <p>What changed, who made it, and when it went live.</p>
                </div>
                {(!project.releases || project.releases.length === 0) && (
                  <p className="quiet-note">
                    Follow your team’s changes as they’re added to the website.
                  </p>
                )}
                {project.releases?.map((release) => (
                  <article className="release-card" key={release.number}>
                    <div className="release-top">
                      <a
                        href={release.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Change #{release.number}{" "}
                        <Icon name="external" size={12} />
                      </a>
                      <span
                        className={
                          release.isLive ? "release-live" : "release-pending"
                        }
                      >
                        {release.isLive ? "Live" : "Publishing"}
                      </span>
                    </div>
                    <strong>{release.title}</strong>
                    <small>
                      {release.author}
                      {release.mergedAt
                        ? ` · Checked ${new Date(release.mergedAt).toLocaleString()}`
                        : " · Checked"}
                    </small>
                    {release.publishedAt && (
                      <small>
                        Published{" "}
                        {new Date(release.publishedAt).toLocaleString()}
                      </small>
                    )}
                    {release.isLive && project.appUrl && (
                      <button
                        className="text-button"
                        onClick={showCurrentWebsite}
                      >
                        View current website <Icon name="arrow" size={12} />
                      </button>
                    )}
                  </article>
                ))}
              </div>
            )}
          </div>
          {project.isOwner && project.repoUrl && (
            <a
              className="team-project-files"
              href={project.repoUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Icon name="github" size={13} />
              Project files <Icon name="external" size={11} />
            </a>
          )}
        </section>
      </main>
      {invite && <Invite project={project} onClose={() => setInvite(false)} />}{" "}
      {sharingWebsite && (
        <ShareWebsite
          projectId={projectId}
          onClose={() => setSharingWebsite(false)}
        />
      )}
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
        navigate("/projects", true);
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
function InstallationSetup() {
  const [secret] = useState(() => {
    const value = new URLSearchParams(location.hash.slice(1)).get("token");
    if (value) sessionStorage.setItem("butler-admin-link", value);
    return value || sessionStorage.getItem("butler-admin-link") || "";
  });
  const [status, setStatus] = useState<{
      github: boolean;
      githubApp?: boolean;
      githubAppName?: string;
      railway: boolean;
      publicUrl: string;
      railwaySettingsUrl: string;
    } | null>(null),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState("");
  const [githubId, setGithubId] = useState(""),
    [githubSecret, setGithubSecret] = useState(""),
    [railwayId, setRailwayId] = useState(""),
    [railwaySecret, setRailwaySecret] = useState("");
  useEffect(() => {
    if (!secret) {
      setError(
        "Open the private installation link provided by your Butler operator.",
      );
      return;
    }
    api<{
      github: boolean;
      githubApp?: boolean;
      githubAppName?: string;
      railway: boolean;
      publicUrl: string;
      railwaySettingsUrl: string;
    }>("/api/setup/status", { token: secret })
      .then(setStatus)
      .catch((e) => setError(e.message));
  }, [secret]);
  async function save(provider: string, event: React.FormEvent) {
    event.preventDefault();
    setBusy(provider);
    setError("");
    setMessage("");
    try {
      const result = await api<typeof status>("/api/setup/save", {
        token: secret,
        provider,
        clientId: provider === "github" ? githubId : railwayId,
        clientSecret: provider === "github" ? githubSecret : railwaySecret,
      });
      setStatus(result);
      if (provider === "github") setGithubSecret("");
      else setRailwaySecret("");
      setMessage(
        (provider === "github" ? "GitHub" : "Railway") +
          " is connected. Settings saved and applied immediately.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function registerGithubApp() {
    setBusy("github-app");
    setError("");
    try {
      const result = await api<{ url: string; manifest: object }>(
        "/api/setup/github-app/manifest",
        { token: secret },
      );
      const form = document.createElement("form");
      form.method = "POST";
      form.action = result.url;
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "manifest";
      input.value = JSON.stringify(result.manifest);
      form.append(input);
      document.body.append(form);
      form.submit();
    } catch (e) {
      setError((e as Error).message);
      setBusy("");
    }
  }
  function urls(provider: string) {
    const home = status!.publicUrl,
      callback = home + "/auth/" + provider + "/callback";
    return (
      <div className="setup-urls">
        <label>
          Homepage
          <input readOnly value={home} onFocus={(e) => e.target.select()} />
        </label>
        <label>
          Callback URL
          <div>
            <input
              readOnly
              value={callback}
              onFocus={(e) => e.target.select()}
            />
            <button
              type="button"
              className="icon-button"
              aria-label={"Copy " + provider + " callback URL"}
              onClick={() =>
                copy(callback)
                  .then(() => setMessage("Callback URL copied."))
                  .catch((e) => setMessage(e.message))
              }
            >
              <Icon name="copy" size={16} />
            </button>
          </div>
        </label>
      </div>
    );
  }
  const githubUrl = status
    ? "https://github.com/settings/applications/new?" +
      new URLSearchParams({
        "oauth_application[name]": "Pocket Butler",
        "oauth_application[url]": status.publicUrl,
        "oauth_application[callback_url]":
          status.publicUrl + "/auth/github/callback",
      })
    : "#";
  return (
    <div className="dashboard">
      <header className="site-header">
        <Brand />
        <span className="header-note">Private installation setup</span>
      </header>
      <main className="dashboard-main setup-main">
        <div className="eyebrow">ONE SETUP. EVERY TEAM.</div>
        <h1>
          Make room
          <br />
          <em>for everyone.</em>
        </h1>
        <p className="page-description">
          Register Butler’s two integrations once. Paste their credentials here;
          Butler saves and applies everything. Team leads only sign in
          afterward.
        </p>
        {error && <Alert>{error}</Alert>}
        {message && (
          <p className="inline-status" role="status">
            {message}
          </p>
        )}
        {status ? (
          <div className="setup-cards">
            <form className="create-card" onSubmit={(e) => save("github", e)}>
              <div className="card-heading">
                <span className="round-icon">
                  <Icon name="github" />
                </span>
                <div>
                  <h2>1. GitHub</h2>
                  <p>
                    {status.github
                      ? "Connected — you can update it below."
                      : "Create the OAuth app, then paste its two values."}
                  </p>
                </div>
                {status.github && <Icon name="check" />}
              </div>
              <p className="setup-instructions">
                Sign-in reads a profile only. Code access uses a separate GitHub
                App with selected repositories, short-lived credentials, and no
                repository administration or organization permissions.
              </p>
              <button
                type="button"
                className="button primary full"
                disabled={Boolean(busy)}
                onClick={registerGithubApp}
              >
                {busy === "github-app"
                  ? "Opening GitHub…"
                  : status.githubApp
                    ? "Register a replacement repository app"
                    : "Register limited repository app"}
              </button>
              {status.githubApp && (
                <p className="inline-status">
                  Repository app configured: {status.githubAppName}
                </p>
              )}
              <details className="optional-details">
                <summary>Advanced: profile-only OAuth credentials</summary>
                <a
                  className="button ghost full"
                  href={githubUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open GitHub registration
                  <Icon name="external" size={16} />
                </a>
                <p className="setup-instructions">
                  These OAuth credentials are for profile sign-in only. Keep the
                  existing values if already saved. The repository app above
                  saves its own credentials automatically when you confirm
                  registration.
                </p>
                {urls("github")}
                <label>
                  Client ID
                  <input
                    autoComplete="off"
                    value={githubId}
                    onChange={(e) => setGithubId(e.target.value)}
                    required
                    placeholder="Paste from GitHub"
                  />
                </label>
                <label>
                  Client secret
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={githubSecret}
                    onChange={(e) => setGithubSecret(e.target.value)}
                    required
                    placeholder="Paste the generated secret"
                  />
                </label>
                <button
                  className="button primary full"
                  disabled={Boolean(busy) || !githubId || !githubSecret}
                >
                  {busy === "github" ? (
                    <Spinner />
                  ) : (
                    <Icon name="check" size={17} />
                  )}
                  Save GitHub
                </button>
              </details>
            </form>
            <form className="create-card" onSubmit={(e) => save("railway", e)}>
              <div className="card-heading">
                <span className="round-icon">
                  <Icon name="railway" />
                </span>
                <div>
                  <h2>Railway (optional legacy hosting)</h2>
                  <p>
                    {status.railway
                      ? "Connected — you can update it below."
                      : "Create the OAuth app in your workspace."}
                  </p>
                </div>
                {status.railway && <Icon name="check" />}
              </div>
              <a
                className="button ghost full"
                href={status.railwaySettingsUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open Railway settings
                <Icon name="external" size={16} />
              </a>
              <p className="setup-instructions">
                Workspace settings → Developer → New OAuth App. Name it Pocket
                Butler, add the callback below, and copy the client ID and
                secret.
              </p>
              {urls("railway")}
              <label>
                Client ID
                <input
                  autoComplete="off"
                  value={railwayId}
                  onChange={(e) => setRailwayId(e.target.value)}
                  required
                  placeholder="Paste from Railway"
                />
              </label>
              <label>
                Client secret
                <input
                  type="password"
                  autoComplete="new-password"
                  value={railwaySecret}
                  onChange={(e) => setRailwaySecret(e.target.value)}
                  required
                  placeholder="Paste the generated secret"
                />
              </label>
              <button
                className="button primary full"
                disabled={Boolean(busy) || !railwayId || !railwaySecret}
              >
                {busy === "railway" ? (
                  <Spinner />
                ) : (
                  <Icon name="check" size={17} />
                )}
                Save Railway
              </button>
            </form>
          </div>
        ) : (
          !error && <Spinner />
        )}
        {status?.github && status.githubApp && (
          <div className="setup-complete">
            <Icon name="check" />
            <h2>Ready for your first team.</h2>
            <p>
              Sign in with GitHub, connect your Boat account, and create a
              project. Codex sign-in happens inside the project.
            </p>
            <a className="button primary" href="/auth/github?returnTo=%2Fstart">
              Start your first project
              <Icon name="arrow" size={17} />
            </a>
          </div>
        )}
        <p className="quiet-note">
          This link controls your Butler installation. Keep it private. No
          Railway variable editing or redeploy is needed to save these
          connections.
        </p>
      </main>
    </div>
  );
}
function App() {
  const route = useRoute(),
    [session, setSession] = useState<Session>(emptySession),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState(""),
    [authError, setAuthError] = useState(
      () => new URLSearchParams(location.search).get("auth_error") || "",
    );
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
  const boatConnected = useCallback(async () => {
    await refresh();
    navigate("/start", true);
  }, [refresh]);
  useEffect(() => {
    const value = new URLSearchParams(location.search).get("auth_error");
    if (value) {
      setAuthError(value);
      history.replaceState({}, "", location.pathname + location.hash);
    }
  }, [refresh]);
  useEffect(() => {
    refresh();
  }, [route, refresh]);
  if (route === "/setup") return <InstallationSetup />;
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
  if (route === "/connect/boat")
    return (
      <div className="dashboard">
        <header className="site-header">
          <Brand />
        </header>
        <main className="dashboard-main onboarding-main">
          <div className="eyebrow">BOAT HOSTING PILOT</div>
          <h1>A new home for your team.</h1>
          <p className="page-description">
            Try Boat for new projects. Your existing projects stay where they
            are.
          </p>
          <section className="create-card onboarding-card">
            {(error || authError) && <Alert>{error || authError}</Alert>}
            {session.user?.githubLogin ? (
              <BoatConnection onConnected={boatConnected} />
            ) : (
              <a
                className="button primary full"
                href="/auth/github?returnTo=%2Fconnect%2Fboat"
              >
                Continue with GitHub
                <Icon name="arrow" size={18} />
              </a>
            )}
          </section>
        </main>
      </div>
    );
  if (route === "/start" || route === "/projects")
    return session.user ? (
      <Dashboard
        key={route}
        session={session}
        refresh={refresh}
        authError={authError}
        listOnly={route === "/projects"}
      />
    ) : (
      <div className="join-page">
        <Brand />
        <main className="join-card">
          <h1>Come on in.</h1>
          <p>
            Sign in to{" "}
            {route === "/start"
              ? "start a project with your team"
              : "return to your projects"}
            .
          </p>
          <a
            className="button primary full"
            href={`/auth/github?returnTo=${encodeURIComponent(route)}`}
          >
            <Icon name="github" />
            Continue with GitHub
          </a>
        </main>
      </div>
    );
  return <Landing session={session} error={error || authError} />;
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
