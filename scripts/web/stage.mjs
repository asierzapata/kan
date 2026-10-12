import { cp, mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
const target = "/tmp/kan-web-staging-source";
await mkdir(target, { recursive: true, mode: 0o700 });
for (const name of ["web", "desktop"])
  await cp(`apps/${name}/src`, `${target}/apps/${name}/src`, {
    recursive: true,
  });
await cp("apps/web/vite.config.ts", `${target}/apps/web/vite.config.ts`);
await cp("apps/web/package.json", `${target}/apps/web/package.json`);
await cp("packages/web-core", `${target}/packages/web-core`, {
  recursive: true,
});
await cp("packages/nodes", `${target}/packages/nodes`, { recursive: true });
await cp("packages/protocol", `${target}/packages/protocol`, {
  recursive: true,
});
await cp("apps/web-agent/agent", `${target}/agent`, { recursive: true });
// Stage a root eve agent; its source import paths still point at the maintained
// desktop contracts through a deterministic rewrite in this packaging boundary.
for (const name of [
  "addMermaidDiagram",
  "getCanvas",
  "readMeetingContext",
  "addNode",
  "updateNode",
  "removeNodes",
  "connectNodes",
  "arrange",
  "groupNodes",
  "focusNodes",
]) {
  const file = `${target}/agent/tools/${name}.ts`;
  await writeFile(
    file,
    (await readFile(file, "utf8")).replace(
      "../../../desktop/src",
      "../../apps/desktop/src",
    ).replace("../../../web/src", "../../apps/web/src"),
  );
}
const root = JSON.parse(await readFile("package.json", "utf8")),
  web = JSON.parse(await readFile("apps/web/package.json", "utf8"));
const dependencies = {
  ...web.dependencies,
  ...web.devDependencies,
  ...root.devDependencies,
};
for (const name of Object.keys(dependencies)) {
  if (name.startsWith("@kan/")) dependencies[name] = "*";
  else
    try {
      dependencies[name] = JSON.parse(
        await readFile(`node_modules/${name}/package.json`, "utf8"),
      ).version;
    } catch {}
}
await writeFile(
  `${target}/package.json`,
  JSON.stringify(
    {
      name: "kan-web-staging",
      private: true,
      type: "module",
      engines: { node: ">=24" },
      workspaces: ["apps/web", "packages/*"],
      dependencies,
    },
    null,
    2,
  ),
);
await writeFile(
  `${target}/vercel.ts`,
  `import {withEve} from 'eve/vercel';\nexport default await withEve({regions:['lhr1'],services:{web:{root:'apps/web',framework:'tanstack-start',buildCommand:'node ../../node_modules/vite/bin/vite.js build',bindings:[{type:'service',service:'eve',format:'url',env:'EVE_INTERNAL_URL'}]}},routes:[{src:'^(.*)$',destination:{type:'service',service:'web'}}]});\n`,
);
await writeFile(
  `${target}/.vercelignore`,
  ".env*\nnode_modules\n.eve\napps/web/.output\napps/web/.vercel\npackages/*/test\n",
);
try {
  await symlink(path.resolve("node_modules"), `${target}/node_modules`, "dir");
} catch (error) {
  if (error.code !== "EEXIST") throw error;
}
console.log(
  "Prepared isolated maintained-web staging source. Link only kan-staging.",
);
