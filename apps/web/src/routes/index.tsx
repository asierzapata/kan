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
  MessageScrollerButton,
} from "@/components/ui/message-scroller";
import { KanBrand } from "@/components/KanBrand";
import { Spinner } from "@/components/ui/spinner";
import { AgentMarkdown } from "@/components/thread/AgentMarkdown";
import { WebCatalog } from "../components/WebCatalog";
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
function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
}
export function WebApp() {
  const { user, loading, signOut } = useAuth();
  const narrow = useMediaQuery("(max-width: 720px)");
  const [mounted, setMounted] = useState(false),
    [catalog, setCatalog] = useState<any>({ workspaces: [], canvases: [] }),
    [catalogLoading, setCatalogLoading] = useState(true),
    [workspace, setWorkspace] = useState(""),
    [canvas, setCanvas] = useState("");
  const [error, setError] = useState("");
  const [history, setHistory] = useState<any>({
      messages: [],
      runs: [],
      threads: [],
    }),
    [thread, setThread] = useState(""),
    [message, setMessage] = useState(""),
    [anchors, setAnchors] = useState<string[]>([]),
    [chatOpen, setChatOpen] = useState(true),
    [meeting, setMeeting] = useState<any>(emptyMeeting),
    [meetingOpen, setMeetingOpen] = useState(false),
    [notice, setNotice] = useState(""),
    [live, setLive] = useState(""),
    [toolState, setToolState] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittedOperation = useRef<{ key: string; id: string } | null>(null);
  const act = async (fn: () => Promise<any>) => {
    setError("");
    try {
      return await fn();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Something went wrong. Try again.",
      );
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
    setWorkspace((old) =>
      data.workspaces.some((w: any) => w.id === old)
        ? old
        : data.workspaces[0]?.id || "",
    );
  }
  useEffect(() => {
    setMounted(true);
  }, []);
  useEffect(() => {
    const navigate = () => {
      const id = new URL(window.location.href).searchParams.get("canvas");
      const target = catalog.canvases.find((c: any) => c.id === id);
      setCanvas(target?.id || "");
      if (target) setWorkspace(target.workspace);
    };
    window.addEventListener("popstate", navigate);
    return () => window.removeEventListener("popstate", navigate);
  }, [catalog]);
  useEffect(() => {
    if (user)
      void act(async () => {
        try {
          await reload();
        } finally {
          setCatalogLoading(false);
        }
      });
  }, [user?.id]);
  useEffect(() => {
    if (!canvas || !user) return;
    let stopped = false;
    let first = true;
    setHistory({ messages: [], runs: [], threads: [] });
    setMeeting(emptyMeeting);
    setNotice("");
    setMeetingOpen(
      sessionStorage.getItem(`kan-meeting-open:${user.id}:${canvas}`) === "1",
    );
    setThread("");
    setAnchors([]);
    const tick = async () => {
      try {
        const [data, meetingData] = await Promise.all([
          api(`history?canvas=${canvas}`),
          api(`meeting?canvas=${canvas}`),
        ]);
        if (stopped) return;
        if (first) {
          first = false;
          const saved = sessionStorage.getItem(
            `kan-thread:${user.id}:${canvas}`,
          );
          setThread(
            saved === ""
              ? ""
              : data.threads.find((t: any) => t.id === saved)?.id ||
                  data.threads.at(-1)?.id ||
                  "",
          );
        }
        setHistory(data);
        setMeeting(meetingData);
      } catch (e) {
        if (!stopped)
          setError(
            e instanceof Error ? e.message : "Something went wrong. Try again.",
          );
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
        if (!abort.signal.aborted)
          setError(
            e instanceof Error ? e.message : "Something went wrong. Try again.",
          );
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
  const revealSegments = (session: string, from: number, to = from) => {
    setMeetingOpen(true);
    if (user)
      sessionStorage.setItem(`kan-meeting-open:${user.id}:${canvas}`, "1");
    requestAnimationFrame(() => {
      document
        .getElementById(`segment-${session}-${from}`)
        ?.scrollIntoView({ block: "center" });
      const marked: Element[] = [];
      for (let seq = from; seq <= to; seq++) {
        const item = document.getElementById(`segment-${session}-${seq}`);
        if (item) {
          item.classList.add("web-highlight");
          marked.push(item);
        }
      }
      setTimeout(
        () => marked.forEach((item) => item.classList.remove("web-highlight")),
        2000,
      );
    });
  };
  const activeMeeting =
    meeting.session && meeting.session.status !== "ended"
      ? meeting.session
      : null;
  const selected = catalog.canvases.find((c: any) => c.id === canvas),
    writable = selected?.role !== "viewer";
  if (loading)
    return (
      <main className="web-session" aria-label="Checking session">
        <Spinner />
        <p>Opening your workspace…</p>
      </main>
    );
  if (!user)
    return (
      <main className="web-welcome">
        <header className="web-header">
          <KanBrand />
          <a href="https://getkan.dev">About Kan ↗</a>
        </header>
        <section className="web-welcome-content">
          <div>
            <p className="web-eyebrow">A shared space to think</p>
            <h1>
              Good ideas need
              <br />
              room to grow.
            </h1>
            <p className="web-lede">
              Bring your ideas, conversations, and Kan together on one living
              canvas.
            </p>
            <Button
              render={
                <a
                  href={
                    mounted && new URL(location.href).searchParams.has("invite")
                      ? `/api/auth/sign-in?invite=${encodeURIComponent(new URL(location.href).searchParams.get("invite")!)}`
                      : "/api/auth/sign-in"
                  }
                />
              }
            >
              Sign in to Kan
            </Button>
          </div>
          <div className="web-welcome-preview" aria-hidden="true">
            <span className="web-preview-note">A thought worth exploring</span>
            <span className="web-preview-link">↘</span>
            <span className="web-preview-agent">
              Kan
              <br />
              <small>
                Make connections.
                <br />
                Find your next direction.
              </small>
            </span>
            <span className="web-preview-note web-preview-note--last">
              Something new takes shape.
            </span>
          </div>
        </section>
      </main>
    );
  const canvasView = (
    <Suspense
      fallback={
        <div className="web-session">
          <Spinner />
          <p>Loading canvas…</p>
        </div>
      }
    >
      <Canvas
        key={canvas}
        canvas={canvas}
        readonly={!writable}
        onSelection={(ids) => {
          setAnchors(ids);
          setChatOpen(true);
        }}
        onAccessLost={() => {
          setCanvas("");
          setError(
            "Canvas access expired. Sign in or contact your workspace owner.",
          );
        }}
      />
    </Suspense>
  );
  const chat = (
    <section className="web-chat" aria-label="Chat">
      <div className="web-row">
        <h2>Ask Kan</h2>
        <select
          aria-label="Thread"
          value={thread}
          onChange={(e) => {
            setThread(e.target.value);
            sessionStorage.setItem(
              `kan-thread:${user.id}:${canvas}`,
              e.target.value,
            );
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
      <MeetingPanel
        meeting={meeting}
        writable={writable}
        open={meetingOpen}
        onOpenChange={(open: boolean) => {
          setMeetingOpen(open);
          sessionStorage.setItem(
            `kan-meeting-open:${user.id}:${canvas}`,
            open ? "1" : "0",
          );
        }}
        canvas={canvas}
        act={act}
        onRefresh={async () =>
          setMeeting(await api(`meeting?canvas=${canvas}`))
        }
        onStarted={(started: any) => {
          setThread(started.thread);
          sessionStorage.setItem(
            `kan-thread:${user.id}:${canvas}`,
            started.thread,
          );
        }}
      />
      <MessageScrollerProvider>
        <MessageScroller>
          <MessageScrollerViewport>
            <MessageScrollerContent role="log">
              {!history.messages.some((m: any) => m.thread === thread) &&
                !live && (
                  <div className="web-chat-empty">
                    <p className="web-eyebrow">Think together</p>
                    <h3>Where should we start?</h3>
                    <p>
                      Ask a question, explore an idea, or select something on
                      the canvas to give Kan context.
                    </p>
                  </div>
                )}
              {history.messages
                .filter((m: any) => m.thread === thread)
                .map((m: any) =>
                  m.role === "context" ? (
                    <MessageScrollerItem key={m.id} messageId={m.id}>
                      <p className="web-context-note" role="note">
                        Meeting context {m.evidence?.[0]?.from}–
                        {m.evidence?.[0]?.to}{" "}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            m.evidence?.[0] &&
                            revealSegments(
                              m.evidence[0].session,
                              m.evidence[0].from,
                              m.evidence[0].to,
                            )
                          }
                        >
                          Show transcript
                        </Button>
                      </p>
                    </MessageScrollerItem>
                  ) : (
                    <MessageScrollerItem
                      key={m.id}
                      messageId={m.id}
                      scrollAnchor={m.role === "user"}
                    >
                      <Message align={m.role === "user" ? "end" : "start"}>
                        <MessageContent>
                          <MessageHeader>
                            {m.role === "user" ? "You" : "Kan"}
                          </MessageHeader>
                          <Bubble
                            variant={m.role === "user" ? "tinted" : "agent"}
                          >
                            <BubbleContent>
                              <AgentMarkdown>{m.content}</AgentMarkdown>
                              {m.anchors?.map((id: string) => (
                                <Button
                                  key={id}
                                  variant="ghost"
                                  onClick={() => {
                                    const editor = (window as any).__kanWeb
                                      ?.editor;
                                    if (editor?.getShape(id)) {
                                      setChatOpen(!narrow);
                                      editor.select(id);
                                      editor.zoomToSelection();
                                    }
                                  }}
                                >
                                  Show on canvas
                                </Button>
                              ))}
                            </BubbleContent>
                          </Bubble>
                          {m.evidence?.[0] && (
                            <Button
                              variant="ghost"
                              onClick={() =>
                                revealSegments(
                                  m.evidence[0].session,
                                  m.evidence[0].from,
                                  m.evidence[0].to,
                                )
                              }
                            >
                              Based on transcript {m.evidence[0].from}–
                              {m.evidence[0].to}
                            </Button>
                          )}
                        </MessageContent>
                      </Message>
                    </MessageScrollerItem>
                  ),
                )}
              {live && (
                <MessageScrollerItem messageId="streaming">
                  <Message>
                    <MessageContent>
                      <Bubble variant="agent">
                        <BubbleContent>
                          <AgentMarkdown>{live}</AgentMarkdown>
                        </BubbleContent>
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
                  <MessageScrollerItem key={r.id} messageId={r.id + "-status"}>
                    <div className="web-row">
                      {r.kind === "context" && (
                        <Badge variant="secondary">auto</Badge>
                      )}
                      <Badge
                        variant={
                          r.status === "failed" || r.status === "denied"
                            ? "destructive"
                            : "secondary"
                        }
                      >
                        {(
                          {
                            queued: "Queued",
                            dispatching: "Starting…",
                            running: "Working…",
                            cancelling: "Stopping…",
                            complete: "Completed",
                            failed: "Failed",
                            denied: "Not permitted",
                            cancelled: "Cancelled",
                          } as Record<string, string>
                        )[r.status] || r.status}
                      </Badge>
                      {r.reverted_at && (
                        <Badge variant="secondary">reverted</Badge>
                      )}
                      {["complete", "failed", "cancelled"].includes(r.status) &&
                        writable &&
                        !r.reverted_at && (
                          <Button
                            variant="ghost"
                            onClick={() =>
                              void act(async () => {
                                const result = await api("run/revert", {
                                  canvas,
                                  run: r.id,
                                });
                                setNotice(
                                  `Undo: removed ${result.removed.length}, kept ${result.kept.length} human-edited`,
                                );
                              })
                            }
                          >
                            Undo
                          </Button>
                        )}
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
                      {["queued", "running", "dispatching"].includes(
                        r.status,
                      ) &&
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
          <MessageScrollerButton aria-label="Jump to latest message" />
        </MessageScroller>
      </MessageScrollerProvider>
      {notice && <p role="status">{notice}</p>}
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
              sessionStorage.setItem(
                `kan-thread:${user.id}:${canvas}`,
                result.thread,
              );
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
            Message {anchors.length ? `· ${anchors.length} anchored nodes` : ""}
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
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                (event.metaKey || event.ctrlKey) &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                if (writable && message.trim() && !submitting)
                  event.currentTarget.form?.requestSubmit();
              }
            }}
            maxLength={4000}
            placeholder={
              writable
                ? "Ask Kan about an idea or this canvas…"
                : "You have view-only access to this canvas"
            }
            disabled={!writable}
          />
        </Field>
        <Button
          disabled={submitting || !writable || !message.trim()}
          type="submit"
        >
          {submitting ? "Sending…" : "Send"}
        </Button>
      </form>
    </section>
  );
  return (
    <main className="web-shell">
      <header className="web-header">
        <KanBrand />
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
            {selected?.role === "viewer" && (
              <Badge variant="secondary">View only</Badge>
            )}
            {activeMeeting && <Badge>Meeting · {activeMeeting.status}</Badge>}
            <Button
              variant="outline"
              aria-pressed={chatOpen}
              onClick={() => setChatOpen(!chatOpen)}
            >
              {narrow && chatOpen
                ? "Show canvas"
                : chatOpen
                  ? "Hide chat"
                  : "Show chat"}
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
              setThread("");
              window.history.replaceState(null, "", window.location.pathname);
              void act(reload);
            }}
          >
            Return to catalog
          </Button>
        </div>
      )}
      {!canvas ? (
        catalogLoading ? (
          <div className="web-session">
            <Spinner />
            <p>Loading your canvases…</p>
          </div>
        ) : (
          <WebCatalog
            catalog={catalog}
            workspace={workspace}
            onWorkspaceChange={setWorkspace}
            onRefresh={reload}
            onOpen={(c) => {
              setCanvas(c.id);
              setThread("");
              setAnchors([]);
              setChatOpen(!narrow);
              window.history.pushState(null, "", `?canvas=${c.id}`);
              setHistory({ messages: [], runs: [], threads: [] });
            }}
          />
        )
      ) : (
        <div className={narrow ? "web-body web-body--narrow" : "web-body"}>
          {mounted &&
            (narrow ? (
              <>
                <div hidden={chatOpen}>{canvasView}</div>
                <div hidden={!chatOpen}>{chat}</div>
              </>
            ) : (
              <WorkspacePanels
                chatOpen={chatOpen}
                canvas={canvasView}
                chat={chat}
              />
            ))}
        </div>
      )}
    </main>
  );
}
const emptyMeeting = { session: null, segments: [], contextRuns: [] };
function MeetingPanel({
  meeting,
  writable,
  open,
  onOpenChange,
  canvas,
  act,
  onRefresh,
  onStarted,
}: any) {
  const { session, segments, contextRuns } = meeting;
  const active = session && session.status !== "ended" ? session : null;
  const [label, setLabel] = useState("Meeting notes"),
    [speaker, setSpeaker] = useState("Speaker 1"),
    [text, setText] = useState(""),
    [result, setResult] = useState(""),
    [lastPartial, setLastPartial] = useState<any>(null);
  const list = useRef<HTMLOListElement>(null),
    atBottom = useRef(true);
  const ordered = [...segments].sort((a: any, b: any) => a.seq - b.seq);
  useEffect(() => {
    const node = list.current;
    if (node && atBottom.current) node.scrollTop = node.scrollHeight;
  }, [segments]);
  const post = (final: boolean, partial?: any) =>
    act(async () => {
      const sourceId = partial?.sourceId ?? crypto.randomUUID(),
        startedAtMs =
          partial?.startedAtMs ??
          Math.max(0, Date.now() - Date.parse(session.created_at));
      const data = await api("meeting/segments", {
        canvas,
        session: session.id,
        segments: [{ sourceId, speaker, text, startedAtMs, final }],
      });
      const outcome = data.outcomes[0];
      setResult(
        outcome.outcome === "inserted" || outcome.outcome === "replaced"
          ? `${outcome.outcome} #${outcome.seq}`
          : outcome.outcome,
      );
      setLastPartial(final ? null : { sourceId, startedAtMs });
      if (final) setText("");
      await onRefresh();
    });
  const setStatus = (status: string) =>
    act(async () => {
      await api("meeting/status", { canvas, session: session.id, status });
      await onRefresh();
    });
  return (
    <details
      className="web-meeting"
      open={open}
      onToggle={(event) => {
        const next = (event.currentTarget as HTMLDetailsElement).open;
        if (next !== open) onOpenChange(next);
      }}
    >
      <summary>
        Meeting notes{" "}
        <Badge variant="secondary">
          {active ? active.status : session ? session.status : "Manual"}
        </Badge>
      </summary>
      <p className="web-help">
        Add meeting notes manually to give Kan context. Live audio capture is
        not connected.
      </p>
      {!active && writable && (
        <div className="web-row">
          <Input
            aria-label="Meeting label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={120}
          />
          <Button
            disabled={!label.trim()}
            onClick={() =>
              void act(async () =>
                onStarted(await api("meeting/start", { canvas, label })),
              )
            }
          >
            Start meeting notes
          </Button>
        </div>
      )}
      {active && (
        <>
          <div className="web-row">
            <span>{active.label}</span>
            {writable && active.status === "listening" && (
              <Button
                variant="outline"
                onClick={() => void setStatus("paused")}
              >
                Pause
              </Button>
            )}
            {writable && active.status === "paused" && (
              <Button
                variant="outline"
                onClick={() => void setStatus("listening")}
              >
                Resume
              </Button>
            )}
            {writable && (
              <Button
                variant="destructive"
                onClick={() => {
                  if (window.confirm("End this meeting? It cannot be resumed."))
                    void setStatus("ended");
                }}
              >
                End
              </Button>
            )}
            {active.pause_reason === "budget" && (
              <small>Paused: run budget reached</small>
            )}
          </div>
          <p>
            Automatic runs: {active.context_runs ?? contextRuns.length} ·
            pending segments: {active.pending_cursor - active.processed_cursor}
          </p>
        </>
      )}
      {session && (
        <ol
          className="web-transcript"
          aria-label="Transcript"
          ref={list}
          onScroll={(event) => {
            const node = event.currentTarget;
            atBottom.current =
              node.scrollTop + node.clientHeight >= node.scrollHeight - 4;
          }}
        >
          {ordered.map((segment: any) => (
            <li
              key={segment.seq}
              id={`segment-${session.id}-${segment.seq}`}
              data-final={segment.final}
              className={segment.final ? undefined : "web-partial"}
            >
              <span className="web-seq">#{segment.seq}</span>{" "}
              <strong>{segment.speaker}</strong>: {segment.text}
              {segment.final ? "" : "…"}
            </li>
          ))}
        </ol>
      )}
      {active && writable && (
        <div className="web-meeting-feed">
          <Field>
            <FieldLabel htmlFor="meeting-speaker">Speaker</FieldLabel>
            <Input
              id="meeting-speaker"
              value={speaker}
              onChange={(e) => setSpeaker(e.target.value)}
              maxLength={80}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="meeting-text">Transcript text</FieldLabel>
            <Textarea
              id="meeting-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={2000}
            />
          </Field>
          <div className="web-row">
            <Button
              disabled={!text.trim() || !speaker.trim()}
              onClick={() => void post(true)}
            >
              Add to transcript
            </Button>
            <Button
              variant="outline"
              disabled={!text.trim() || !speaker.trim()}
              onClick={() => void post(false)}
            >
              Add draft
            </Button>
            <Button
              variant="outline"
              disabled={!lastPartial || !text.trim() || !speaker.trim()}
              onClick={() => void post(true, lastPartial)}
            >
              Publish draft
            </Button>
          </div>
          {result && <p role="status">{result}</p>}
        </div>
      )}
    </details>
  );
}
function historyReplace() {
  window.history.replaceState(null, "", window.location.pathname);
}
