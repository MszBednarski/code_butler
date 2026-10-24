import { test } from "node:test";
import assert from "node:assert/strict";
import { chatBubbles, explainButler } from "../src/communication.ts";

test("a failure mentioning PR creation never claims the change is ready to publish", () => {
  const text = "Creating the pull request failed. Your work is saved.";
  const explanation = explainButler(text, "error");
  assert.doesNotMatch(explanation, /ready for its final checks|will publish/);
  assert.match(explanation, /saved|problem|couldn.t/);
});

test("a workspace failure does not send people into a repeated Continue loop", () => {
  const explanation = explainButler(
    "The agent stopped while preparing the workspace. Your edits and conversation are saved. Send Continue to resume, or ask the lead to inspect this request.",
    "error",
  );
  assert.doesNotMatch(explanation, /Continue/);
  assert.match(explanation, /safe/);
  assert.match(explanation, /team lead/);
});

test("saved preview controls remain in history next to matching assistant text", () => {
  const messages = [
    { id: "reply", jobId: "job", role: "assistant", text: "Colourful jumps" },
    {
      id: "saved",
      jobId: "job",
      role: "assistant",
      kind: "saved-preview",
      text: "Colourful jumps",
    },
    { id: "next", jobId: "job", role: "assistant", text: "Colourful jumps" },
  ];
  assert.deepEqual(
    chatBubbles(messages).map((m) => m.id),
    ["reply", "saved", "next"],
  );
});

test("repeated explanations form one bubble without losing developer evidence or changing history", () => {
  const messages = [
    { id: "1", jobId: "job", role: "user", text: "Make the game multiplayer" },
    {
      id: "2",
      jobId: "job",
      role: "assistant",
      kind: "status",
      text: "App checks passed. Preparing the pull request.",
    },
    {
      id: "3",
      jobId: "job",
      role: "assistant",
      text: "I’ve sent it for review.",
    },
    {
      id: "4",
      jobId: "job",
      role: "assistant",
      text: "I’ve sent it for review.",
    },
  ];
  const original = structuredClone(messages),
    bubbles = chatBubbles(messages);
  assert.equal(bubbles.length, 2);
  assert.deepEqual(bubbles[1].diagnostics, [
    messages[1].text,
    messages[2].text,
  ]);
  assert.deepEqual(messages, original);
  assert.deepEqual(
    chatBubbles(messages),
    bubbles,
    "Polling must not add copies",
  );
});

test("user requests, new requests, distinct agent progress and repeated stages after a repair remain visible", () => {
  const message = (id, role, text, jobId = "job") => ({
    id,
    role,
    text,
    jobId,
  });
  const messages = [
    message("1", "user", "Continue"),
    message("2", "user", "Continue"),
    message("3", "assistant", "Checking the multiplayer lobby."),
    message("4", "assistant", "Two visitors now share scores."),
    message("5", "assistant", "Checking the multiplayer lobby."),
    message("6", "assistant", "Checking the multiplayer lobby.", "new-request"),
  ];
  assert.equal(chatBubbles(messages).length, messages.length);
});

test("hosting failures ask to retry the preview instead of falsely blaming app checks", () => {
  for (const error of [
    "The Boat build stopped before it passed. Its source and workspace are saved; inspect the build in Boat and retry.",
    "Butler couldn’t finish the preview build.",
  ])
    assert.equal(
      explainButler(error, "error"),
      "Butler couldn’t prepare this preview. Your work is saved. Try preparing it again.",
    );
  assert.match(
    explainButler("The proposed merge does not pass the app checks.", "error"),
    /didn’t pass the website checks/,
  );
});

test("different Codex updates remain separate even when their simplified explanations match", () => {
  const messages = [
    {
      id: "1",
      jobId: "job",
      role: "assistant",
      kind: "agent",
      text: "Updated app/src/game.ts.",
    },
    {
      id: "2",
      jobId: "job",
      role: "assistant",
      kind: "agent",
      text: "Updated app/src/lobby.ts.",
    },
    {
      id: "3",
      jobId: "job",
      role: "assistant",
      kind: "agent",
      text: "Updated app/src/lobby.ts.",
    },
  ];
  assert.equal(chatBubbles(messages).length, 2);
});
