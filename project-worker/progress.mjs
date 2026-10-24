import { readdir, rm } from "node:fs/promises";
import { load, save } from "./runtime.mjs";

// Forward assistant messages, never reasoning, command output, or credential/login output.
export function assistantUpdate(event) {
  if (
    event?.type !== "item.completed" ||
    event.item?.type !== "agent_message" ||
    typeof event.item.text !== "string"
  )
    return null;
  return {
    key: String(event.item.id || "message").replace(/[^a-zA-Z0-9:._-]/g, "_"),
    text: event.item.text.slice(0, 20000),
  };
}
export function readableFailure(error, stage = "working on the change") {
  const output = String(error.output || error.message || "");
  if (error.code === "WORKSPACE_HAS_EDITS")
    return "Another change has unfinished work in this workspace. Everything is saved. Ask the team lead to help reopen this request; sending Continue again won’t resolve it.";
  if (/bwrap:|No permissions to create a new namespace/.test(output))
    return "The agent could not start its command sandbox. Your work is saved; the team lead needs to update the worker runtime.";
  if (/usage limit|rate limit|quota|too many requests|429/i.test(output))
    return "Codex reached an account or usage limit. Your work is saved. Wait for the limit to reset or ask the lead to check the Codex account, then send Continue.";
  if (
    /unauthorized|authentication|401|sign in|log in|token.*expired/i.test(
      output,
    )
  )
    return "Codex needs to reconnect. Ask the team lead to reconnect Codex, then send Continue. Your work is saved.";
  if (/EAI_AGAIN|ECONNRESET|ENOTFOUND|ETIMEDOUT|fetch failed/.test(output))
    return "The connection was interrupted. Your work is saved; send Continue to resume it.";
  if (stage === "checking the app")
    return "The app checks failed. The change has not been published. Send Fix the app checks to let your agent repair the saved work.";
  return `The agent stopped while ${stage}. Your edits and conversation are saved. Send Continue to resume, or ask the lead to inspect this request.`;
}
export function createProgress({ dataDir, api }) {
  const directory = `${dataDir}/events`;
  let queue = Promise.resolve(),
    retryAt = 0;
  const valid = (target) =>
    /^(jobs\/[a-f0-9-]{36}|pulls\/[1-9][0-9]*)$/.test(target);
  const file = (target) => `${directory}/${target.replace("/", "-")}.json`;
  const serialize = (work) => {
    queue = queue
      .then(work)
      .catch(() =>
        console.error("[progress] Updates are saved locally and will retry."),
      );
    return queue;
  };
  async function flushFile(name) {
    if (Date.now() < retryAt) return;
    const state = await load(name, { events: [] });
    if (!valid(state.target) || !state.events.length) return;
    while (state.events.length) {
      let events = state.events.slice(0, 50);
      while (
        Buffer.byteLength(JSON.stringify({ events })) > 96000 &&
        events.length > 1
      )
        events.pop();
      try {
        await api(`/${state.target}/events`, { events });
      } catch {
        retryAt = Date.now() + 15000;
        return;
      }
      state.events.splice(0, events.length);
      if (state.events.length) await save(name, state);
      else await rm(name, { force: true });
    }
  }
  function flush() {
    return serialize(async () => {
      const names = await readdir(directory).catch((e) => {
        if (e.code === "ENOENT") return [];
        throw e;
      });
      for (const name of names.filter((n) => n.endsWith(".json")))
        await flushFile(`${directory}/${name}`);
    });
  }
  const timer = setInterval(flush, 15000);
  timer.unref();
  return {
    post(target, key, text, kind = "status") {
      if (!valid(target) || !text) return Promise.resolve();
      return serialize(async () => {
        const name = file(target),
          state = await load(name, { target, events: [] });
        if (!state.events.some((e) => e.key === key))
          state.events.push({
            key,
            kind,
            text: String(text).slice(0, 20000),
            at: Date.now(),
          });
        await save(name, state);
        await flushFile(name);
      });
    },
    flush,
    stop: () => clearInterval(timer),
  };
}
