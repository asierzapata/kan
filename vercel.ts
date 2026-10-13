import path from "node:path";

// Both Vercel projects use this repository root. Select by project identity,
// never by branch: a preview of kan-web must still deploy the web application.
const webProjectIds = new Set([
  "prj_duGsOn7h4StAHdG5M5YMPp1qlbWS", // kan-web
  "prj_0Lyk84unyBsbBIdBoc9f26MZ2FyM", // kan-staging
]);

async function deploymentConfig() {
  if (!webProjectIds.has(process.env.VERCEL_PROJECT_ID ?? "")) {
    return {
      buildCommand: "npx turbo run build --filter=@kan/site",
      installCommand: "npm install",
      outputDirectory: "apps/site/dist",
      framework: null,
    };
  }

  const { withEve } = await import("eve/vercel");
  const agentRoot = path.resolve(process.cwd(), "apps/web-agent");
  const composed = await withEve(
    {
      regions: ["lhr1"],
      services: {
        web: {
          root: "apps/web",
          framework: "tanstack-start",
          buildCommand: "node ../../node_modules/vite/bin/vite.js build",
          bindings: [
            { type: "service", service: "eve", format: "url", env: "EVE_INTERNAL_URL" },
          ],
        },
      },
      routes: [
        { src: "^(.*)$", destination: { type: "service", service: "web" } },
      ],
    },
    { root: agentRoot },
  );
  // withEve emits roots relative to its agent project; Vercel evaluates this
  // configuration at the repository root. Commands remain service-relative.
  return {
    ...composed,
    services: {
      ...composed.services,
      eve: {
        ...composed.services.eve,
        root: path.posix.join("apps/web-agent", composed.services.eve.root!),
      },
    },
  };
}

export default await deploymentConfig();
