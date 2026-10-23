import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { run, safeEnvironment } from "./runtime.mjs";

export function parseDeviceOutput(output) {
  const clean = output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const match = clean.match(/https:\/\/auth\.openai\.com\/[^\s\x1b<>]+/);
  const code = clean.match(/\b[A-Z0-9]{4,5}-[A-Z0-9]{4,5}\b/);
  if (!match || !code) return null;
  const url = new URL(match[0].replace(/[.,)]$/, ""));
  if (url.hostname !== "auth.openai.com") return null;
  return { url: url.href, code: code[0] };
}

export async function createCodexAuth({
  dataDir = "/data",
  command = "codex",
} = {}) {
  const home = `${dataDir}/leader`,
    codexHome = `${dataDir}/codex`;
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  process.env.CODEX_HOME = codexHome;
  await writeFile(
    `${codexHome}/config.toml`,
    'forced_login_method = "chatgpt"\ncli_auth_credentials_store = "file"\n',
    { mode: 0o600 },
  );
  let child,
    pending = null,
    state = "signed_out",
    output = "",
    started = 0,
    lastChecked = 0;
  const env = {
    ...safeEnvironment(home, true),
    NO_BROWSER: "true",
    BROWSER: "false",
  };
  async function status(force = false) {
    if (force || Date.now() - lastChecked > 5000) {
      const result = await run(command, ["login", "status"], {
        env,
        timeout: 20000,
        allowFailure: true,
      });
      lastChecked = Date.now();
      if (result.code === 0 && /ChatGPT/i.test(result.stdout + result.stderr)) {
        state = "connected";
        pending = null;
      } else if (!child) state = state === "error" ? "error" : "signed_out";
    }
    if (child && Date.now() - started > 900000) {
      child.kill();
      state = "error";
      pending = null;
    }
    return {
      state,
      ...(state === "pending" ? pending : {}),
      ...(state === "error"
        ? {
            message:
              "Enable device-code login in ChatGPT Settings → Security, then try connecting again.",
          }
        : {}),
    };
  }
  async function start() {
    if ((await status(true)).state === "connected" || child) return status();
    state = "starting";
    pending = null;
    output = "";
    started = Date.now();
    child = spawn(command, ["login", "--device-auth"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const capture = (chunk) => {
      output = (output + chunk.toString()).slice(-12000);
      const value = parseDeviceOutput(output);
      if (value) {
        pending = value;
        state = "pending";
      }
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", () => {
      state = "error";
      pending = null;
      child = null;
    });
    child.once("close", (code) => {
      child = null;
      if (code !== 0) {
        state = "error";
        pending = null;
      }
      lastChecked = 0;
    });
    return { state: "starting" };
  }
  return {
    status,
    start,
    stop() {
      child?.kill();
    },
  };
}
