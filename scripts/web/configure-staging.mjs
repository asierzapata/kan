import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
const target = "/tmp/kan-web-staging-source";
const project = JSON.parse(
  await readFile(`${target}/.vercel/project.json`, "utf8"),
);
if (project.projectId !== "prj_0Lyk84unyBsbBIdBoc9f26MZ2FyM")
  throw Error("Wrong deployment project");
const cli = process.env.VERCEL_BIN;
if (!cli) throw Error("Set VERCEL_BIN to the installed CLI entrypoint");
for (const [name, value] of Object.entries({
  KAN_ENV: "staging",
  WEB_API_URL: "https://staging.getkan.dev/api/web",
})) {
  const child = spawn(
    process.execPath,
    [
      cli,
      "env",
      "add",
      name,
      "production,preview",
      "--force",
      "--yes",
      "--cwd",
      target,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stdout.resume();
  child.stderr.resume();
  child.stdin.end(value);
  if ((await new Promise((resolve) => child.on("exit", resolve))) !== 0)
    throw Error(`Could not configure ${name}`);
  console.log(`Configured staging ${name}`);
}
