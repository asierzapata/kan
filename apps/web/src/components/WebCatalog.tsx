import { useState } from "react";
import { RiAddLine, RiTeamLine, RiSearchLine } from "@remixicon/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyMedia,
} from "@/components/ui/empty";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

type Workspace = { id: string; name: string; role: string };
type Canvas = {
  id: string;
  name: string;
  workspace: string;
  role: string;
  created_at?: string;
};
type Action = {
  kind: "workspace" | "canvas" | "rename" | "delete" | "members";
  target?: Canvas;
};
async function request(path: string, input?: object) {
  const response = await fetch(
    `/api/web/${path}`,
    input
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }
      : undefined,
  );
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || "Something went wrong. Try again.");
  return data;
}
export function WebCatalog({
  catalog,
  workspace,
  onWorkspaceChange,
  onRefresh,
  onOpen,
}: {
  catalog: { workspaces: Workspace[]; canvases: Canvas[] };
  workspace: string;
  onWorkspaceChange: (id: string) => void;
  onRefresh: () => Promise<void>;
  onOpen: (canvas: Canvas) => void;
}) {
  const [action, setAction] = useState<Action | null>(null);
  const [name, setName] = useState(""),
    [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [email, setEmail] = useState(""),
    [role, setRole] = useState("editor"),
    [inviteUrl, setInviteUrl] = useState("");
  const [members, setMembers] = useState<
    { user_id: string; email: string; role: string }[]
  >([]);
  const current = catalog.workspaces.find((w) => w.id === workspace);
  const canvases = catalog.canvases.filter((c) => c.workspace === workspace);
  const visible = canvases.filter((c) =>
    c.name.toLowerCase().includes(query.toLowerCase()),
  );
  const execute = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Something went wrong. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  const begin = (next: Action) => {
    setName(next.target?.name || "");
    setError("");
    setInviteUrl("");
    setMembers([]);
    setEmail("");
    setAction(next);
    if (next.kind === "members")
      void execute(async () =>
        setMembers((await request(`members?workspace=${workspace}`)).members),
      );
  };
  const save = () =>
    execute(async () => {
      if (!action) return;
      if (action.kind === "workspace") {
        const data = await request("workspace/create", { name: name.trim() });
        onWorkspaceChange(data.id);
      } else if (action.kind === "canvas") {
        const data = await request("canvas/create", {
          workspace,
          name: name.trim(),
        });
        await onRefresh();
        setAction(null);
        onOpen({
          id: data.id,
          name: name.trim(),
          workspace,
          role: current?.role || "editor",
        });
        return;
      } else if (action.kind === "rename")
        await request("canvas/rename", {
          canvas: action.target!.id,
          name: name.trim(),
        });
      else if (action.kind === "delete")
        await request("canvas/delete", { canvas: action.target!.id });
      await onRefresh();
      setAction(null);
    });
  const invitation =
    typeof window !== "undefined" &&
    new URL(window.location.href).searchParams.has("invite");
  return (
    <section className="web-catalog">
      <div className="web-catalog-heading">
        <div>
          <p className="web-eyebrow">Your shared workspace</p>
          <h1>{catalog.workspaces.length ? "Canvases" : "Welcome to Kan"}</h1>
          <p className="web-lede">A little space for your next big idea.</p>
        </div>
        <div className="web-row">
          <Button
            variant="outline"
            onClick={() => begin({ kind: "workspace" })}
          >
            New workspace
          </Button>
          {current && current.role !== "viewer" && (
            <Button onClick={() => begin({ kind: "canvas" })}>
              <RiAddLine data-icon="inline-start" />
              New canvas
            </Button>
          )}
        </div>
      </div>
      {invitation && (
        <div className="web-invitation">
          <div>
            <strong>You’ve been invited</strong>
            <p>Accept this invitation to join a shared workspace.</p>
          </div>
          <Button
            disabled={busy}
            onClick={() =>
              void execute(async () => {
                await request("invitation/accept", {
                  token: new URL(location.href).searchParams.get("invite"),
                });
                window.history.replaceState(null, "", location.pathname);
                await onRefresh();
              })
            }
          >
            Accept invitation
          </Button>
        </div>
      )}
      {error && !action && (
        <p role="alert" className="web-form-error">
          {error}
        </p>
      )}
      {current && (
        <div className="web-catalog-toolbar">
          <Field className="web-workspace-field">
            <FieldLabel htmlFor="workspace">Workspace</FieldLabel>
            <select
              id="workspace"
              value={workspace}
              onChange={(e) => {
                onWorkspaceChange(e.target.value);
                setQuery("");
              }}
            >
              {catalog.workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </Field>
          <Badge variant="secondary">
            {current.role === "viewer" ? "View only" : current.role}
          </Badge>
          <div className="web-search">
            <RiSearchLine aria-hidden="true" />
            <Input
              aria-label="Search canvases"
              placeholder="Search canvases…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {current.role === "owner" && (
            <Button
              variant="outline"
              onClick={() => begin({ kind: "members" })}
            >
              <RiTeamLine data-icon="inline-start" />
              Members & invites
            </Button>
          )}
        </div>
      )}
      {!current || !visible.length ? (
        <Empty className="web-empty">
          <EmptyMedia variant="icon">
            <RiAddLine />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>
              {!current
                ? "Make room for your ideas"
                : query
                  ? "No matching canvases"
                  : "Your first canvas starts here"}
            </EmptyTitle>
            <EmptyDescription>
              {!current
                ? "Create a workspace to keep your canvases together and invite others to collaborate."
                : query
                  ? "Try a different name or clear your search."
                  : current.role === "viewer"
                    ? "Canvases shared by your workspace will appear here."
                    : "Sketch freely, connect your thoughts, and ask Kan to help you move them forward."}
            </EmptyDescription>
          </EmptyHeader>
          {!current ? (
            <Button onClick={() => begin({ kind: "workspace" })}>
              Create workspace
            </Button>
          ) : query ? (
            <Button variant="outline" onClick={() => setQuery("")}>
              Clear search
            </Button>
          ) : (
            current.role !== "viewer" && (
              <Button onClick={() => begin({ kind: "canvas" })}>
                Create canvas
              </Button>
            )
          )}
        </Empty>
      ) : (
        <div className="web-canvas-grid">
          {visible.map((c) => (
            <article className="web-canvas-card" key={c.id}>
              <button
                className="web-canvas-preview"
                aria-label={`Open ${c.name}`}
                onClick={() => onOpen(c)}
              >
                <span>
                  {c.name
                    .trim()
                    .split(/\s+/)
                    .slice(0, 2)
                    .map((part) => part[0])
                    .join("")
                    .toUpperCase()}
                </span>
                <Badge variant="secondary">Shared canvas</Badge>
              </button>
              <div className="web-canvas-card-content">
                <button className="web-canvas-title" onClick={() => onOpen(c)}>
                  {c.name}
                </button>
                <p>
                  {c.role === "viewer"
                    ? "View only"
                    : "Ready to think together"}
                </p>
                {c.role !== "viewer" && (
                  <div className="web-card-actions">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => begin({ kind: "rename", target: c })}
                    >
                      Rename
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => begin({ kind: "delete", target: c })}
                    >
                      Delete
                    </Button>
                  </div>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      <Dialog
        open={!!action}
        onOpenChange={(open) => {
          if (!open && !busy) setAction(null);
        }}
      >
        <DialogContent className="web-catalog-dialog" showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>
              {action?.kind === "workspace"
                ? "Create a workspace"
                : action?.kind === "canvas"
                  ? "Create a canvas"
                  : action?.kind === "rename"
                    ? "Rename canvas"
                    : action?.kind === "delete"
                      ? "Delete canvas?"
                      : "Members & invitations"}
            </DialogTitle>
            <DialogDescription>
              {action?.kind === "delete"
                ? `“${action.target?.name}” will be removed for everyone in this workspace.`
                : action?.kind === "members"
                  ? `Manage who can access ${current?.name}. Editors can make changes; viewers can only read.`
                  : action?.kind === "workspace"
                    ? "A home for your canvases and the people you think with."
                    : "Give this space a name. You can change it later."}
            </DialogDescription>
          </DialogHeader>
          {action?.kind === "members" ? (
            <div className="web-member-settings">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void execute(async () =>
                    setInviteUrl(
                      (
                        await request("invitation/create", {
                          workspace,
                          email,
                          role,
                        })
                      ).url,
                    ),
                  );
                }}
              >
                <Field>
                  <FieldLabel htmlFor="invite-email">
                    Invite by email
                  </FieldLabel>
                  <Input
                    id="invite-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@example.com"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="invite-role">Access</FieldLabel>
                  <select
                    id="invite-role"
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                  >
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                  </select>
                </Field>
                <Button disabled={busy || !email.trim()} type="submit">
                  Create invitation link
                </Button>
                <p className="web-help">
                  Share the link yourself. It expires after seven days and works
                  only for this email.
                </p>
              </form>
              {inviteUrl && (
                <Field>
                  <FieldLabel htmlFor="invite-link">Invitation link</FieldLabel>
                  <Input
                    id="invite-link"
                    readOnly
                    value={inviteUrl}
                    onFocus={(e) => e.target.select()}
                  />
                  <Button
                    variant="outline"
                    onClick={() =>
                      void execute(async () => {
                        await navigator.clipboard.writeText(inviteUrl);
                      })
                    }
                  >
                    Copy link
                  </Button>
                </Field>
              )}
              <div className="web-member-list">
                {members.map((m) => (
                  <div className="web-member" key={m.user_id}>
                    <span>{m.email}</span>
                    {m.role === "owner" ? (
                      <Badge variant="secondary">Owner</Badge>
                    ) : (
                      <>
                        <select
                          aria-label={`Role for ${m.email}`}
                          disabled={busy}
                          value={m.role}
                          onChange={(e) => {
                            const next = e.target.value;
                            void execute(async () => {
                              await request("member/role", {
                                workspace,
                                user: m.user_id,
                                role: next,
                              });
                              setMembers((old) =>
                                old.map((item) =>
                                  item.user_id === m.user_id
                                    ? { ...item, role: next }
                                    : item,
                                ),
                              );
                            });
                          }}
                        >
                          <option value="editor">Editor</option>
                          <option value="viewer">Viewer</option>
                        </select>
                        <Button
                          variant="ghost"
                          disabled={busy}
                          onClick={() => {
                            if (
                              window.confirm(
                                `Remove ${m.email} from this workspace?`,
                              )
                            )
                              void execute(async () => {
                                await request("member/revoke", {
                                  workspace,
                                  user: m.user_id,
                                });
                                setMembers((old) =>
                                  old.filter(
                                    (item) => item.user_id !== m.user_id,
                                  ),
                                );
                              });
                          }}
                        >
                          Remove
                        </Button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              {action?.kind !== "delete" && (
                <Field>
                  <FieldLabel htmlFor="action-name">
                    {action?.kind === "workspace"
                      ? "Workspace name"
                      : "Canvas name"}
                  </FieldLabel>
                  <Input
                    id="action-name"
                    autoFocus
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={120}
                    placeholder={
                      action?.kind === "workspace"
                        ? "Design team"
                        : "Our next big idea"
                    }
                    required
                    disabled={busy}
                  />
                </Field>
              )}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setAction(null)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant={
                    action?.kind === "delete" ? "destructive" : "default"
                  }
                  disabled={busy || (action?.kind !== "delete" && !name.trim())}
                >
                  {busy
                    ? "Saving…"
                    : action?.kind === "delete"
                      ? "Delete canvas"
                      : action?.kind === "rename"
                        ? "Save name"
                        : action?.kind === "workspace"
                          ? "Create workspace"
                          : "Create canvas"}
                </Button>
              </DialogFooter>
            </form>
          )}
          {error && (
            <p role="alert" className="web-form-error">
              {error}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
