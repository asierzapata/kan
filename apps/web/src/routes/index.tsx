import { createFileRoute } from "@tanstack/react-router";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import { lazy, Suspense, useEffect, useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldLabel } from "@/components/ui/field";
import { Badge } from "@/components/ui/badge";
import {
  Message,
  MessageContent,
  MessageHeader,
} from "@/components/ui/message";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import {
  MessageScroller,
  MessageScrollerProvider,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
} from "@/components/ui/message-scroller";
import { WorkspacePanels } from "../../../desktop/src/components/WorkspacePanels";
import "../web.css";
const Canvas = lazy(async () => {
  try {
    return await import("../lib/canvas");
  } catch (error) {
    if (
      typeof window !== "undefined" &&
      Date.now() - Number(sessionStorage.getItem("kan-module-reload") || 0) >
        30000
    ) {
      sessionStorage.setItem("kan-module-reload", String(Date.now()));
      window.location.reload();
      return new Promise<never>(() => {});
    }
    throw error;
  }
});
export const Route = createFileRoute("/")({ component: WebApp });
async function api(path: string, input?: any) {
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
  if (!response.ok) throw Error(data.error);
  return data;
}
function WebApp() {
  const { user, loading, signOut } = useAuth();
  const [mounted, setMounted] = useState(false),
    [catalog, setCatalog] = useState<any>({ workspaces: [], canvases: [] }),
    [workspace, setWorkspace] = useState(""),
    [canvas, setCanvas] = useState("");
  const [error, setError] = useState(""),
    [name, setName] = useState(""),
    [email, setEmail] = useState(""),
    [inviteRole, setInviteRole] = useState("editor"),
    [inviteUrl, setInviteUrl] = useState("");
  const [history, setHistory] = useState<any>({
      messages: [],
      runs: [],
      threads: [],
    }),
    [thread, setThread] = useState(""),
    [message, setMessage] = useState(""),
    [anchors, setAnchors] = useState<string[]>([]),
    [chatOpen, setChatOpen] = useState(true),
    [live, setLive] = useState(""),
    [toolState, setToolState] = useState("");
  const [members, setMembers] = useState<any[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const submittedOperation = useRef<{ key: string; id: string } | null>(null);
  const act = async (fn: () => Promise<any>) => {
    setError("");
    try {
      return await fn();
    } catch (e) {
      setError(String(e));
    }
  };
  async function reload() {
    const data = await api("catalog");
    setCatalog(data);
    const requested = new URL(window.location.href).searchParams.get("canvas");
    const permitted = data.canvases.find((c: any) => c.id === requested);
    if (permitted) {
      setCanvas(permitted.id);
      setWorkspace(permitted.workspace);
    }
    setWorkspace((old) => old || data.workspaces[0]?.id || "");
  }
  useEffect(() => {
    setMounted(true);
  }, []);
  useEffect(() => {
    if (user) void act(reload);
  }, [user?.id]);
  useEffect(() => {
    if (!canvas || !user) return;
    let stopped = false;
    let first = true;
    setHistory({ messages: [], runs: [], threads: [] });
    setThread("");
    setAnchors([]);
    const tick = async () => {
      try {
        const data = await api(`history?canvas=${canvas}`);
        if (stopped) return;
        if (first) {
          first = false;
          const saved = sessionStorage.getItem(`kan-thread:${user.id}:${canvas}`);
          setThread(saved === "" ? "" : data.threads.find((t: any) => t.id === saved)?.id || data.threads.at(-1)?.id || "");
        }
        setHistory(data);
      } catch (e) {
        if (!stopped) setError(String(e));
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [canvas, user?.id]);
  const activeRun = history.runs.findLast(
    (r: any) =>
      r.thread === thread &&
      ["running", "dispatching", "cancelling"].includes(r.status) &&
      r.session_id,
  );
  useEffect(() => {
    setLive("");
    setToolState("");
    if (!canvas || !activeRun) return;
    const abort = new AbortController();
    void (async () => {
      try {
        const response = await fetch(
          `/api/web/stream?canvas=${canvas}&run=${activeRun.id}`,
          { signal: abort.signal },
        );
        if (!response.ok) throw Error("Run stream unavailable");
        const reader = response.body!.getReader(),
          decoder = new TextDecoder();
        let buffer = "",
          text = "";
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          buffer += decoder.decode(next.value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop()!;
          for (const line of lines) {
            if (!line.trim()) continue;
            const event = JSON.parse(line);
            if (event.type === "message.appended") {
              text += event.data.messageDelta;
              setLive(text);
            }
            if (event.type === "message.completed") {
              text = event.data.message || "";
              setLive(text);
            }
            if (event.type === "actions.requested")
              setToolState("Working on canvas tools");
            if (event.type === "action.result")
              setToolState("Canvas tool completed");
            if (event.type === "turn.cancelled") setToolState("Cancelled");
            if (event.type === "session.waiting") setLive("");
          }
        }
      } catch (e) {
        if (!abort.signal.aborted) setError(String(e));
      }
    })();
    return () => abort.abort();
  }, [canvas, activeRun?.id]);
  const draftKey =
    user && canvas ? `kan-draft:${user.id}:${canvas}:${thread}` : null;
  useEffect(() => {
    if (!draftKey) return;
    try {
      const draft = JSON.parse(sessionStorage.getItem(draftKey) || "null");
      if (draft) {
        setMessage(draft.message);
        setAnchors(draft.anchors || []);
        if (draft.operation)
          submittedOperation.current = {
            key: JSON.stringify({
              canvas,
              thread,
              message: draft.message,
              anchors: draft.anchors || [],
            }),
            id: draft.operation,
          };
      } else setMessage("");
    } catch {
      setMessage("");
    }
  }, [draftKey]);
  const current = catalog.workspaces.find((w: any) => w.id === workspace),
    selected = catalog.canvases.find((c: any) => c.id === canvas),
    writable = selected?.role !== "viewer";
  if (loading) return <main className="web-catalog">Checking session…</main>;
  if (!user)
    return (
      <main className="web-catalog">
        <h1>Kan</h1>
        <p>Your shared workspace for ideas and conversations.</p>
        <a
          href={
            mounted && new URL(location.href).searchParams.has("invite")
              ? `/api/auth/sign-in?invite=${encodeURIComponent(new URL(location.href).searchParams.get("invite")!)}`
              : "/api/auth/sign-in"
          }
        >
          Sign in
        </a>
      </main>
    );
  return (
    <main className="web-shell">
      <header className="web-header">
        <strong>
          Kan <Badge variant="secondary">Staging</Badge>
        </strong>
        {canvas && (
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setCanvas("");
                setThread("");
                window.history.replaceState(null, "", window.location.pathname);
              }}
            >
              Canvases
            </Button>
            <span>{selected?.name}</span>
            <Button variant="outline" onClick={() => setChatOpen(!chatOpen)}>
              Chat
            </Button>
          </>
        )}
        <Button
          variant="ghost"
          onClick={() => void signOut({ returnTo: window.location.origin })}
        >
          Sign out
        </Button>
      </header>
      {error && (
        <div role="alert" className="web-row">
          <p>{error}</p>
          <Button
            variant="ghost"
            onClick={() => {
              setCanvas("");
              void act(reload);
            }}
          >
            Return to catalog
          </Button>
        </div>
      )}
      {!canvas ? (
        <section className="web-catalog">
          <h1>
            {catalog.workspaces.length ? "Your canvases" : "Welcome to Kan"}
          </h1>
          <div className="web-row">
            <Field>
              <FieldLabel htmlFor="name">Name</FieldLabel>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
              />
            </Field>
            <Button
              disabled={!name.trim()}
              onClick={() =>
                void act(async () => {
                  const data = await api("workspace/create", { name });
                  setWorkspace(data.id);
                  setName("");
                  await reload();
                })
              }
            >
              Create workspace
            </Button>
          </div>
          {catalog.workspaces.length > 0 && (
            <>
              <Field>
                <FieldLabel htmlFor="workspace">Workspace</FieldLabel>
                <select
                  id="workspace"
                  value={workspace}
                  onChange={(e) => {
                    setWorkspace(e.target.value);
                    setMembers([]);
                    setInviteUrl("");
                  }}
                >
                  {catalog.workspaces.map((w: any) => (
                    <option key={w.id} value={w.id}>
                      {w.name} · {w.role}
                    </option>
                  ))}
                </select>
              </Field>
              {current?.role !== "viewer" && (
                <Button
                  disabled={!name.trim()}
                  onClick={() =>
                    void act(async () => {
                      await api("canvas/create", { workspace, name });
                      setName("");
                      await reload();
                    })
                  }
                >
                  Create canvas
                </Button>
              )}
              {catalog.canvases
                .filter((c: any) => c.workspace === workspace)
                .map((c: any) => (
                  <article className="web-card" key={c.id}>
                    <strong>{c.name}</strong>
                    <Button
                      onClick={() => {
                        setCanvas(c.id);
                        setThread("");
                        setAnchors([]);
                        window.history.replaceState(
                          null,
                          "",
                          `?canvas=${c.id}`,
                        );
                        setHistory({ messages: [], runs: [], threads: [] });
                      }}
                    >
                      Open
                    </Button>
                    {c.role !== "viewer" && (
                      <>
                        <Button
                          variant="outline"
                          disabled={!name.trim()}
                          onClick={() =>
                            void act(async () => {
                              await api("canvas/rename", {
                                canvas: c.id,
                                name,
                              });
                              await reload();
                            })
                          }
                        >
                          Rename using name
                        </Button>
                        <Button
                          variant="destructive"
                          onClick={() =>
                            void act(async () => {
                              await api("canvas/delete", { canvas: c.id });
                              await reload();
                            })
                          }
                        >
                          Delete
                        </Button>
                      </>
                    )}
                  </article>
                ))}
              {current?.role === "owner" && (
                <>
                  <h2>Members</h2>
                  <div className="web-row">
                    <Field>
                      <FieldLabel htmlFor="email">Invitation email</FieldLabel>
                      <Input
                        id="email"
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                      />
                    </Field>
                    <select
                      aria-label="Invitation role"
                      value={inviteRole}
                      onChange={(e) => setInviteRole(e.target.value)}
                    >
                      <option value="editor">Editor</option>
                      <option value="viewer">Viewer</option>
                    </select>
                    <Button
                      onClick={() =>
                        void act(async () => {
                          setInviteUrl(
                            (
                              await api("invitation/create", {
                                workspace,
                                email,
                                role: inviteRole,
                              })
                            ).url,
                          );
                        })
                      }
                    >
                      Create invitation link
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() =>
                        void act(async () =>
                          setMembers(
                            (await api(`members?workspace=${workspace}`))
                              .members,
                          ),
                        )
                      }
                    >
                      Show members
                    </Button>
                  </div>
                  {inviteUrl && (
                    <p>
                      Share this seven-day invitation:{" "}
                      <a href={inviteUrl}>{inviteUrl}</a>
                    </p>
                  )}
                  {members.map((m) => (
                    <div className="web-row" key={m.user_id}>
                      {m.email} · {m.role}
                      {m.role !== "owner" && (
                        <select
                          aria-label={`Role for ${m.email}`}
                          value={m.role}
                          onChange={(event) =>
                            void act(async () => {
                              const role = event.target.value;
                              await api("member/role", {
                                workspace,
                                user: m.user_id,
                                role,
                              });
                              setMembers(
                                members.map((member) =>
                                  member.user_id === m.user_id
                                    ? { ...member, role }
                                    : member,
                                ),
                              );
                            })
                          }
                        >
                          <option value="editor">Editor</option>
                          <option value="viewer">Viewer</option>
                        </select>
                      )}
                      {m.role !== "owner" && (
                        <Button
                          variant="destructive"
                          onClick={() =>
                            void act(async () => {
                              await api("member/revoke", {
                                workspace,
                                user: m.user_id,
                              });
                              setMembers(
                                members.filter((x) => x.user_id !== m.user_id),
                              );
                            })
                          }
                        >
                          Revoke
                        </Button>
                      )}
                    </div>
                  ))}
                </>
              )}
            </>
          )}
          <Button
            variant="outline"
            onClick={() =>
              void act(async () => {
                const token = new URL(location.href).searchParams.get("invite");
                if (!token) throw Error("Open an invitation link first");
                await api("invitation/accept", { token });
                historyReplace();
                await reload();
              })
            }
          >
            Accept invitation from this link
          </Button>
        </section>
      ) : (
        <div className="web-body">
          {mounted && (
            <WorkspacePanels
              chatOpen={chatOpen}
              canvas={
                <Suspense fallback={<p>Loading canvas…</p>}>
                  <Canvas
                    key={canvas}
                    canvas={canvas}
                    onSelection={setAnchors}
                    onAccessLost={() => {
                      setCanvas("");
                      setError(
                        "Canvas access expired. Sign in or contact your workspace owner.",
                      );
                    }}
                  />
                </Suspense>
              }
              chat={
                <section className="web-chat" aria-label="Chat">
                  <div className="web-row">
                    <h2>Ask Kan</h2>
                    <select
                      aria-label="Thread"
                      value={thread}
                      onChange={(e) => {
                        setThread(e.target.value);
                        sessionStorage.setItem(`kan-thread:${user.id}:${canvas}`, e.target.value);
                      }}
                    >
                      <option value="">New thread</option>
                      {history.threads.map((t: any) => (
                        <option value={t.id} key={t.id}>
                          {t.title}
                        </option>
                      ))}
                    </select>
                  </div>
                  <MessageScrollerProvider>
                    <MessageScroller>
                      <MessageScrollerViewport>
                        <MessageScrollerContent role="log">
                          {history.messages
                            .filter((m: any) => m.thread === thread)
                            .map((m: any) => (
                              <MessageScrollerItem
                                key={m.id}
                                messageId={m.id}
                                scrollAnchor={m.role === "user"}
                              >
                                <Message
                                  align={m.role === "user" ? "end" : "start"}
                                >
                                  <MessageContent>
                                    <MessageHeader>{m.role}</MessageHeader>
                                    <Bubble
                                      variant={
                                        m.role === "user" ? "tinted" : "agent"
                                      }
                                    >
                                      <BubbleContent>
                                        <p>{m.content}</p>
                                        {m.anchors?.map((id: string) => (
                                          <Button
                                            key={id}
                                            variant="ghost"
                                            onClick={() => {
                                              const editor = (window as any)
                                                .__kanWeb?.editor;
                                              if (editor?.getShape(id)) {
                                                editor.select(id);
                                                editor.zoomToSelection();
                                              }
                                            }}
                                          >
                                            Node {id.slice(0, 20)}
                                          </Button>
                                        ))}
                                      </BubbleContent>
                                    </Bubble>
                                  </MessageContent>
                                </Message>
                              </MessageScrollerItem>
                            ))}
                          {live && (
                            <MessageScrollerItem messageId="streaming">
                              <Message>
                                <MessageContent>
                                  <Bubble variant="agent">
                                    <BubbleContent>{live}</BubbleContent>
                                  </Bubble>
                                </MessageContent>
                              </Message>
                            </MessageScrollerItem>
                          )}
                          {toolState && (
                            <MessageScrollerItem messageId="tool-state">
                              <p role="status">{toolState}</p>
                            </MessageScrollerItem>
                          )}
                          {history.runs
                            .filter((r: any) => r.thread === thread)
                            .map((r: any) => (
                              <MessageScrollerItem
                                key={r.id}
                                messageId={r.id + "-status"}
                              >
                                <div className="web-row">
                                  <Badge>{r.status}</Badge>
                                  {["failed", "denied"].includes(r.status) &&
                                    r.user_id === user.id &&
                                    writable && (
                                      <Button
                                        variant="ghost"
                                        onClick={() =>
                                          void act(() =>
                                            api("retry", { canvas, run: r.id }),
                                          )
                                        }
                                      >
                                        Retry
                                      </Button>
                                    )}
                                  {[
                                    "queued",
                                    "running",
                                    "dispatching",
                                  ].includes(r.status) &&
                                    writable && (
                                      <Button
                                        variant="ghost"
                                        onClick={() =>
                                          void act(() =>
                                            api("cancel", {
                                              canvas,
                                              run: r.id,
                                            }),
                                          )
                                        }
                                      >
                                        Cancel
                                      </Button>
                                    )}
                                </div>
                              </MessageScrollerItem>
                            ))}
                        </MessageScrollerContent>
                      </MessageScrollerViewport>
                    </MessageScroller>
                  </MessageScrollerProvider>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (submitting) return;
                      const key = JSON.stringify({
                        canvas,
                        thread,
                        message,
                        anchors,
                      });
                      if (submittedOperation.current?.key !== key)
                        submittedOperation.current = {
                          key,
                          id: crypto.randomUUID(),
                        };
                      if (draftKey)
                        sessionStorage.setItem(
                          draftKey,
                          JSON.stringify({
                            message,
                            anchors,
                            operation: submittedOperation.current!.id,
                          }),
                        );
                      setSubmitting(true);
                      void act(async () => {
                        try {
                          const result = await api("chat", {
                            canvas,
                            thread: thread || undefined,
                            message,
                            anchors,
                            operation: submittedOperation.current!.id,
                          });
                          setThread(result.thread);
                          sessionStorage.setItem(`kan-thread:${user.id}:${canvas}`, result.thread);
                          setMessage("");
                          if (draftKey) sessionStorage.removeItem(draftKey);
                          submittedOperation.current = null;
                        } finally {
                          setSubmitting(false);
                        }
                      });
                    }}
                  >
                    <Field>
                      <FieldLabel htmlFor="prompt">
                        Message{" "}
                        {anchors.length
                          ? `· ${anchors.length} anchored nodes`
                          : ""}
                      </FieldLabel>
                      <Textarea
                        id="prompt"
                        value={message}
                        onChange={(e) => {
                          setMessage(e.target.value);
                          if (draftKey)
                            sessionStorage.setItem(
                              draftKey,
                              JSON.stringify({
                                message: e.target.value,
                                anchors,
                              }),
                            );
                        }}
                        maxLength={4000}
                        disabled={!writable}
                      />
                    </Field>
                    <Button
                      disabled={submitting || !writable || !message.trim()}
                      type="submit"
                    >
                      Send
                    </Button>
                  </form>
                </section>
              }
            />
          )}
        </div>
      )}
    </main>
  );
}
function historyReplace() {
  window.history.replaceState(null, "", window.location.pathname);
}
