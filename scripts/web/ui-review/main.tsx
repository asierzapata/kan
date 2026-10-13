// Local-only browser fixture. This entry is not part of the Start route tree.
import React from "react";
import { createRoot } from "react-dom/client";
import { WebApp } from "../../../apps/web/src/routes/index";
const workspaces = [{ id: "qa-workspace", name: "Studio", role: "owner" }];
let canvases = [
  {
    id: "qa-canvas",
    workspace: "qa-workspace",
    name: "A new direction",
    role: "owner",
  },
];
if (new URL(location.href).searchParams.has("empty")) canvases = [];
const calls: { path: string; input: any }[] = [];
(window as any).__uiReview = { calls };
window.fetch = async (resource, options) => {
  const path = String(resource).split("/api/web/")[1];
  const input = JSON.parse(String(options?.body || "{}"));
  calls.push({ path, input });
  let data: any = {};
  if (path === "catalog")
    data = { workspaces: [...workspaces], canvases: [...canvases] };
  else if (path === "workspace/create") {
    data = { id: crypto.randomUUID() };
    workspaces.push({ ...data, name: input.name, role: "owner" });
  } else if (path === "canvas/create") {
    data = { id: crypto.randomUUID() };
    canvases.push({
      ...data,
      workspace: input.workspace,
      name: input.name,
      role: "owner",
    });
  } else if (path === "canvas/rename")
    canvases = canvases.map((c) =>
      c.id === input.canvas ? { ...c, name: input.name } : c,
    );
  else if (path === "canvas/delete")
    canvases = canvases.filter((c) => c.id !== input.canvas);
  else if (path?.startsWith("members?"))
    data = {
      members: [
        { user_id: "qa-user", email: "qa@example.test", role: "owner" },
        { user_id: "qa-viewer", email: "viewer@example.test", role: "viewer" },
      ],
    };
  else if (path === "invitation/create")
    data = { url: "http://localhost:1431/?invite=qa-disposable-token" };
  else if (path?.startsWith("history?"))
    data = {
      messages: [
        {
          id: "qa-msg",
          role: "assistant",
          thread: "qa-thread",
          content:
            "## Let's explore\n\nA **shared canvas** makes room for ideas.\n\n- Connect thoughts\n- Find a direction",
        },
      ],
      runs: [],
      threads: [{ id: "qa-thread", title: "A new direction" }],
    };
  else if (path?.startsWith("meeting?"))
    data = { session: null, segments: [], contextRuns: [] };
  else if (path?.startsWith("room?"))
    return Response.json(
      { error: "This isolated UI fixture has no realtime backend." },
      { status: 503 },
    );
  return Response.json(data);
};
createRoot(document.getElementById("root")!).render(<WebApp />);
