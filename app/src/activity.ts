import type { Job } from "./workspace-types";
import type { ChatMessage } from "./communication";

export type Notice = {
  id: string;
  channel: "chat" | "group" | "team" | "updates";
  title: string;
  detail: string;
  at: number;
  memberId?: string;
  job?: Job;
  unread: boolean;
  active?: boolean;
};
type ActivitySource = {
  member: { id: string };
  personalUpdateAt?: number;
  groupMessages?: { id: string; isOwn: boolean; createdAt: number }[];
  groupAgent?: { messages: ChatMessage[]; jobs: Job[] } | null;
  activity: Job[];
  releases?: {
    number: number;
    title: string;
    publishedAt?: number;
    mergedAt?: number;
    isLive: boolean;
  }[];
};
export function activityNotices(
  project: ActivitySource,
  seen: Record<string, number>,
): Notice[] {
  const items: Omit<Notice, "unread">[] = [];
  const group = [
    ...(project.groupMessages || []).filter((m) => !m.isOwn),
    ...(project.groupAgent?.messages || []).filter(
      (m) => m.kind !== "status" && m.kind !== "saved-preview",
    ),
  ];
  const latest = group.reduce((at, m) => Math.max(at, m.createdAt || 0), 0);
  const unreadMessages = group.filter(
    (m) => (m.createdAt || 0) > (seen.group || 0),
  ).length;
  if (latest)
    items.push({
      id: "group",
      channel: "group",
      title: unreadMessages
        ? `${unreadMessages} new group ${unreadMessages === 1 ? "message" : "messages"}`
        : "Group conversation",
      detail: "Your team and @Butler",
      at: latest,
    });
  if (project.personalUpdateAt)
    items.push({
      id: "chat",
      channel: "chat",
      title: "Your Butler has an update",
      detail: "Open your chat",
      at: project.personalUpdateAt,
      memberId: project.member.id,
    });
  const latestByMember = new Map<string, Job>();
  for (const job of project.activity) {
    if (!job.memberId || job.requestKey?.startsWith("review-fix:")) continue;
    const previous = latestByMember.get(job.memberId);
    if (
      !previous ||
      job.createdAt > previous.createdAt ||
      (job.createdAt === previous.createdAt &&
        (job.updatedAt || 0) > (previous.updatedAt || 0))
    )
      latestByMember.set(job.memberId, job);
  }
  for (const job of latestByMember.values()) {
    const channel = job.isGroup
      ? "group"
      : job.memberId === project.member.id
        ? "chat"
        : "team";
    if (
      job.state === "awaiting_approval" &&
      !job.dismissedAt &&
      (job.artifactUrl || job.previewUrl)
    )
      items.push({
        id: "preview:" + job.id,
        channel,
        title: job.isGroup
          ? "Group preview ready"
          : `${job.name || "Your teammate"}’s preview is ready`,
        detail: job.prTitle || "Try the proposed change",
        at: job.artifactReadyAt || job.updatedAt || job.createdAt,
        memberId: job.memberId,
        job,
      });
    else if (
      [
        "queued",
        "working",
        "building_preview",
        "creating_pr",
        "reviewing",
        "deploying",
      ].includes(job.state)
    )
      items.push({
        id: "working:" + job.id,
        channel,
        title: job.isGroup
          ? "Group Butler is working"
          : `${job.name || "Your teammate"}’s Butler is working`,
        detail:
          job.state === "building_preview"
            ? "Preparing a preview to try"
            : job.state === "reviewing"
              ? "Checking an approved change"
              : job.state === "deploying"
                ? "Updating the shared website"
                : "Open the chat to follow progress",
        at: job.startedAt || job.createdAt,
        memberId: job.memberId,
        job,
        active: true,
      });
    else if (
      [
        "failed",
        "preview_failed",
        "publish_failed",
        "needs_attention",
      ].includes(job.state)
    )
      items.push({
        id: "problem:" + job.id,
        channel,
        title: job.isGroup
          ? "Group change needs attention"
          : `${job.name || "Your Butler"}’s change needs attention`,
        detail:
          job.state === "preview_failed"
            ? "The preview couldn’t be prepared. Your work is saved."
            : "A change needs attention before it can go live.",
        at: job.finishedAt || job.updatedAt || job.createdAt,
        memberId: job.memberId,
        job,
      });
  }
  for (const release of (project.releases || []).slice(0, 8))
    items.push({
      id: "release:" + release.number,
      channel: "updates",
      title: release.isLive
        ? "Website updated"
        : "Website update is publishing",
      detail: release.title,
      at: release.publishedAt || release.mergedAt || 0,
    });
  return items
    .map((n) => ({ ...n, unread: !n.active && n.at > (seen[n.id] || 0) }))
    .sort((a, b) => Number(b.unread) - Number(a.unread) || b.at - a.at);
}
