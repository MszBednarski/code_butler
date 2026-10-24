// Called only by controller-owned git subprocesses. Coding/build subprocesses
// do not inherit WORKER_SECRET and cannot retrieve provider credentials.
if (process.argv[2] === "get" && process.env.WORKER_SECRET) {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const fields = Object.fromEntries(
    input
      .trim()
      .split("\n")
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
  const platform = new URL(process.env.PLATFORM_URL);
  if (fields.host === platform.host)
    process.stdout.write(
      `username=butler\npassword=${process.env.WORKER_SECRET}\n\n`,
    );
}
