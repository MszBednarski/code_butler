import { test } from "node:test";
import assert from "node:assert/strict";
import { activityNotices } from "../src/activity.ts";

test("relevant group, personal, teammate preview and published changes have persistent read markers", () => {
  const project = {
    member: { id: "alice" },
    personalUpdateAt: 20,
    groupMessages: [
      { id: "human", isOwn: false, createdAt: 30 },
      { id: "self", isOwn: true, createdAt: 40 },
    ],
    groupAgent: {
      messages: [
        { id: "progress", kind: "status", createdAt: 50 },
        { id: "answer", kind: "agent", createdAt: 35 },
      ],
      jobs: [],
    },
    activity: [
      {
        id: "proposal",
        memberId: "bob",
        name: "Bob",
        state: "awaiting_approval",
        artifactUrl: "https://preview.example.test",
        artifactReadyAt: 60,
        createdAt: 10,
        prTitle: "Colourful jumps",
      },
      {
        id: "old",
        memberId: "bob",
        name: "Bob",
        state: "awaiting_approval",
        artifactUrl: "https://old.example.test",
        createdAt: 1,
      },
    ],
    releases: [
      { number: 1, title: "New riding arena", isLive: true, publishedAt: 70 },
    ],
  };
  const unread = activityNotices(project, {});
  assert.equal(unread.length, 4);
  assert.ok(unread.every((n) => n.unread));
  assert.equal(
    unread.find((n) => n.id === "group").title,
    "2 new group messages",
  );
  assert.equal(unread.find((n) => n.id === "preview:proposal").channel, "team");
  assert.equal(
    unread.find((n) => n.id === "release:1").detail,
    "New riding arena",
  );
  const seen = Object.fromEntries(unread.map((n) => [n.id, n.at]));
  assert.ok(
    activityNotices(project, JSON.parse(JSON.stringify(seen))).every(
      (n) => !n.unread,
    ),
  );
  project.activity[0].artifactReadyAt = 80;
  assert.deepEqual(
    activityNotices(project, seen)
      .filter((n) => n.unread)
      .map((n) => n.id),
    ["preview:proposal"],
  );
  project.activity[0].dismissedAt = 90;
  assert.equal(
    activityNotices(project, seen).some((n) => n.id === "preview:proposal"),
    false,
  );
});

test("ongoing work stays discoverable without repeatedly becoming unread", () => {
  const p = {
    member: { id: "alice" },
    activity: [
      {
        id: "work",
        memberId: "shared",
        isGroup: true,
        createdAt: 10,
        startedAt: 20,
        state: "working",
      },
    ],
  };
  const items = activityNotices(p, {});
  assert.equal(items.length, 1);
  assert.equal(items[0].active, true);
  assert.equal(items[0].unread, false);
  assert.equal(items[0].channel, "group");
  assert.equal(items[0].title, "Group Butler is working");
});
