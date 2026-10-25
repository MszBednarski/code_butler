import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { chromium } from "playwright-core";
import { safeEnvironment, sleep, load, save } from "./runtime.mjs";

export async function readAppFile(directory, name) {
  if (typeof name !== "string" || name.length > 250)
    throw Error("Choose a file inside app/.");
  const relative = name.startsWith("app/") ? name.slice(4) : name;
  if (
    relative
      .split(/[\\/]/)
      .some(
        (part) =>
          part.startsWith(".") || ["node_modules", "dist"].includes(part),
      )
  )
    throw Error("Only app source files can be inspected.");
  const root = await realpath(path.join(directory, "app"));
  const file = await realpath(path.resolve(root, relative));
  if (!file.startsWith(root + path.sep))
    throw Error("Only this app’s files can be inspected.");
  return (await readFile(file, "utf8")).slice(0, 20000);
}
export async function browserCheck(
  directory,
  home,
  steps = [],
  { executablePath = process.env.CHROMIUM_PATH || "/usr/bin/chromium" } = {},
) {
  if (!Array.isArray(steps) || steps.length > 12)
    throw Error("Use at most twelve browser steps.");
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  const child = spawn("npm", ["start"], {
    cwd: `${directory}/app`,
    env: { ...safeEnvironment(home), PORT: String(port) },
    stdio: "ignore",
    detached: true,
  });
  let browser, spawnError;
  child.on("error", (error) => {
    spawnError = error;
  });
  try {
    let ready = false;
    for (let i = 0; i < 50; i++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null)
        throw Error("The built website did not start.");
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(500) });
        if (r.ok) {
          ready = true;
          break;
        }
      } catch {}
      await sleep(200);
    }
    if (!ready) throw Error("The built website did not become ready.");
    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      serviceWorkers: "block",
    });
    page.setDefaultTimeout(4000);
    const errors = [],
      results = [];
    page.on("pageerror", (error) => errors.push(error.message.slice(0, 500)));
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 12000,
    });
    if (!response?.ok())
      throw Error("The local website returned an unsuccessful response.");
    for (const step of steps) {
      if (
        !step ||
        !["click", "fill", "press", "expect_text", "expect_visible"].includes(
          step.action,
        ) ||
        [step.selector, step.text, step.key].some(
          (v) => v !== undefined && (typeof v !== "string" || v.length > 1000),
        )
      )
        throw Error("Invalid browser step.");
      try {
        const target = step.selector
          ? page.locator(step.selector).first()
          : page.getByText(step.text || "", { exact: false }).first();
        if (step.action === "click") await target.click();
        if (step.action === "fill") await target.fill(step.text || "");
        if (step.action === "press") await target.press(step.key || "Enter");
        if (step.action === "expect_text") {
          if (!step.text) throw Error("Text assertions need expected text.");
          await (
            step.selector ? target.filter({ hasText: step.text }) : target
          ).waitFor({ state: "visible" });
        }
        if (step.action === "expect_visible") {
          if (!step.selector)
            throw Error("Visibility assertions need a selector.");
          await target.waitFor({ state: "visible" });
        }
        results.push({ ...step, passed: true });
      } catch (error) {
        results.push({
          ...step,
          passed: false,
          error: error.message.slice(0, 1200),
        });
        break;
      }
    }
    const content = await page.locator("body").innerText();
    const controls = await page
      .locator("button,input,select,textarea,a,[role=button]")
      .evaluateAll((nodes) =>
        nodes.slice(0, 60).map((n) => ({
          tag: n.tagName,
          text: (n.innerText || n.getAttribute("aria-label") || "").slice(
            0,
            150,
          ),
          id: n.id,
          type: n.getAttribute("type"),
          placeholder: n.getAttribute("placeholder"),
        })),
      );
    const screenshot = (
      await page.screenshot({ type: "jpeg", quality: 30 })
    ).toString("base64");
    return {
      passed: errors.length === 0 && results.every((r) => r.passed),
      assertions: results.filter(
        (r) => r.passed && r.action.startsWith("expect_"),
      ).length,
      viewport: "390 × 844",
      results,
      errors,
      text: content.slice(0, 12000),
      controls,
      ...(screenshot.length < 65000 ? { screenshot } : {}),
    };
  } finally {
    await browser?.close();
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
    }
  }
}

export async function verifyWithGemini(
  agent,
  { pr, base, directory, home, key, evidenceFile, checkBrowser = browserCheck },
) {
  const endpoint = `/pulls/${pr.number}/gemini`;
  const report = async (suffix, phase, summary, details) => {
    const update = { phase, summary: summary.slice(0, 1500), details: details?.slice(0, 12000), model: "gemini-4-argon" };
    while (JSON.stringify(update).length > 19000) update.details = update.details?.slice(0, Math.floor(update.details.length / 2));
    return agent.reportPull?.(
      pr.number,
      `${key}:gemini:${suffix}`.slice(0, 160),
      JSON.stringify(update),
      "gemini",
    );
  };
  const diff =
    (await agent.git(["diff", "--stat", "HEAD"], directory)).stdout +
    "\n" +
    (await agent.git(["diff", "HEAD", "--", "app"], directory)).stdout;
  let interaction = await agent.api(endpoint, {
    operation: "start",
    head: pr.head.sha,
    base,
    context: diff.slice(0, 60000),
  });
  const evidence = evidenceFile ? await load(evidenceFile) : {};
  let checks = evidence.key === key ? evidence.checks : null,
    browser = evidence.key === key ? evidence.browser : null;
  const deadline = Date.now() + 8 * 60000;
  await report(
    "start",
    "plan",
    "I’m Gemini, your independent verifier. I’ll check what you asked for, run the website checks and try the result at phone size.",
    `Model: gemini-4-argon\nReviewing the proposed change against the current website.\nThe coding agent cannot see your Gemini key.`,
  );
  for (
    let turn = 0;
    turn < 9 && Date.now() < deadline && !agent.stopping;
    turn++
  ) {
    while (["queued", "in_progress"].includes(interaction.status)) {
      if (Date.now() > deadline || agent.stopping)
        throw Error("Gemini verification paused before completing.");
      await sleep(1500);
      interaction = await agent.api(endpoint, {
        operation: "poll",
        head: pr.head.sha,
        base,
      });
    }
    const text =
      interaction.output_text ||
      (interaction.steps || [])
        .filter((s) => s.type === "model_output")
        .flatMap((s) => s.content || [])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
    if (text)
      await report(
        `${turn}:explanation`,
        turn === 0 ? "plan" : "check",
        text.slice(0, 1500),
        text.length > 1500 ? text.slice(0, 12000) : undefined,
      );
    const calls = (interaction.steps || []).filter(
      (s) => s.type === "function_call",
    );
    if (!calls.length)
      throw Error("Gemini did not finish its evidence-backed verification.");
    const input = [];
    for (const call of calls) {
      const args = call.arguments || {};
      if (call.name === "finish_verification") {
        const verdict = {
          decision: args.decision,
          summary: args.summary,
          findings: args.findings,
        };
        if (
          !["approve", "block"].includes(verdict.decision) ||
          typeof verdict.summary !== "string" ||
          !Array.isArray(verdict.findings) ||
          verdict.findings.some((f) => typeof f !== "string")
        )
          throw Error("Invalid Gemini verification verdict.");
        if (
          verdict.decision === "approve" &&
          (!checks?.passed ||
            !browser?.passed ||
            !browser.assertions ||
            verdict.findings.length)
        ) {
          verdict.decision = "block";
          verdict.findings.push(
            "Gemini did not establish a passing build and a successful browser assertion for this change.",
          );
          verdict.summary =
            "This change still needs a completed website check before it can go live.";
        }
        await report(
          "verdict",
          verdict.decision === "approve" ? "passed" : "blocked",
          verdict.summary,
          `${verdict.findings.join("\n")}\n\nApp checks: ${checks?.passed ? "passed" : "not passed"}\nPhone browser assertions: ${browser?.assertions || 0}\n${JSON.stringify(browser?.results || [], null, 2)}`.slice(
            0,
            14000,
          ),
        );
        return {
          ...verdict,
          verifier: "gemini",
          evidence: {
            checks: checks?.passed || false,
            browser: browser?.passed || false,
            assertions: browser?.assertions || 0,
          },
        };
      }
      let result;
      try {
        if (call.name === "read_app_file")
          result = {
            path: args.path,
            text: await readAppFile(directory, args.path),
          };
        else if (call.name === "run_app_checks") {
          try {
            await agent.build(directory, home);
            checks = {
              passed: true,
              steps: [
                "Dependency install",
                "Typecheck (if configured)",
                "Production build",
                "Tests (if configured)",
              ],
            };
          } catch (error) {
            checks = {
              passed: false,
              error: String(error.output || error.message).slice(-5000),
            };
          }
          result = checks;
        } else if (call.name === "check_browser") {
          if (!checks?.passed)
            result = {
              passed: false,
              error:
                "Run and pass app checks before inspecting the built website.",
            };
          else {
            browser = await checkBrowser(directory, home, args.steps);
            result = browser;
          }
        } else throw Error("This verification tool is not allowed.");
      } catch (error) {
        result = { passed: false, error: String(error.message).slice(0, 1500) };
      }
      const { screenshot, ...publicResult } = result;
      if (evidenceFile)
        await save(evidenceFile, {
          key,
          checks,
          browser: browser && { ...browser, screenshot: undefined },
        });
      await report(
        `${call.id}:result`,
        "check",
        call.name === "run_app_checks"
          ? result.passed
            ? "The website checks passed."
            : "The website checks found a problem."
          : call.name === "check_browser"
            ? result.passed
              ? `I opened the website at phone size and checked ${result.assertions || 0} expectations.`
              : "The phone browser check found a problem."
            : "I’m inspecting the code behind your change.",
        JSON.stringify(publicResult, null, 2).slice(0, 12000),
      );
      input.push({
        type: "function_result",
        name: call.name,
        call_id: call.id,
        result: [
          { type: "text", text: JSON.stringify(publicResult) },
          ...(screenshot
            ? [{ type: "image", mime_type: "image/jpeg", data: screenshot }]
            : []),
        ],
      });
    }
    interaction = await agent.api(endpoint, {
      operation: "continue",
      head: pr.head.sha,
      base,
      interactionId: interaction.id,
      input,
    });
  }
  throw Error(
    "Gemini reached the verification time limit. The change is saved.",
  );
}
