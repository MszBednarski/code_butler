import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, rename } from "node:fs/promises";
import path from "node:path";

export const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
export const exists = async (file) =>
  readFile(file).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
export async function save(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}
export async function load(file, fallback = {}) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}
export function safeEnvironment(home, codex = false) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: "/tmp",
    LANG: "C.UTF-8",
    NO_COLOR: "1",
    CI: "1",
    IS_SANDBOX: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    ...(codex ? { CODEX_HOME: process.env.CODEX_HOME || "/data/codex" } : {}),
  };
}
export function run(
  file,
  args,
  {
    cwd,
    env = safeEnvironment("/data/build"),
    input,
    timeout = 900000,
    allowFailure = false,
    onLine,
    onChild,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    onChild?.(child);
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    let stdout = "",
      stderr = "",
      pending = "";
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk).slice(-2 * 1024 * 1024);
      if (onLine) {
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop();
        for (const line of lines) onLine(line);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-1024 * 1024);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (pending) onLine?.(pending);
      if ((code && !allowFailure) || signal) {
        const error = new Error(
          `${file} ${args[0] || ""} did not finish successfully.`,
        );
        error.code = code;
        error.output = (stdout + stderr).slice(-3000);
        reject(error);
      } else resolve({ code, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input || "");
  });
}
