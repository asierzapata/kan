// Runs the web server, the web app and the eve agent together, with prefixed output.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const services = [
  ["server", "dev:server"],
  ["web", "dev:web"],
  ["agent", "dev:agent"],
];
const children = [];
let code = 0;

function stop() {
  for (const child of children) if (child.exitCode === null) child.kill("SIGINT");
}

for (const [name, script] of services) {
  const child = spawn("npm", ["run", script], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  children.push(child);
  for (const stream of [child.stdout, child.stderr])
    createInterface({ input: stream }).on("line", (line) => console.log(`[${name}] ${line}`));
  child.on("exit", (status, signal) => {
    console.log(`[${name}] exited (${signal ?? status})`);
    if (!code) code = status || (signal ? 1 : 0) || 1;
    stop();
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);
process.on("exit", stop);
