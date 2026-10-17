---
name: e2e
description: Launch and drive the Kan web app in a real Chrome with agent-browser to prove a change actually works. Use before claiming any UI, frontend or server-visible feature is done, when asked to run/start/screenshot the app, to reproduce a bug, or to verify sync and auth behaviour end to end.
---

# Verifying a change in Kan

**A feature is not done until it has been exercised end to end in a running app.**
`tsc --noEmit`, `vite build` and the server test suite passing are not evidence
that anything works — they only prove the code compiles and the backend answers
in isolation.

This rule exists because it has already failed here: the tldraw integration
type-checked and built cleanly while the dev server crashed on startup with 53
unresolved-asset errors, and panel styling compiled fine and rendered wrong.
Only a running app and a screenshot caught them.

## The stack

| Process | Command | Port | Ready when |
| --- | --- | --- | --- |
| Server (Hono + ws, PGlite) | `npm run dev:server` | 8787 | `curl -s localhost:8787/healthz` → `{"ok":true}` |
| Web app (Vite, proxies `/api` and `/sync` to 8787) | `npm run dev:web` | 1430 (`strictPort`) | `curl -s -o /dev/null -w '%{http_code}' localhost:1430/` → `200` |
| Agent (eve) — optional | `npm run dev:agent` | 3100 | only needed for real agent turns; requires `AI_GATEWAY_API_KEY` |

The browser is **agent-browser** (Vercel), pinned as a root devDependency and run
through `npx agent-browser`. First time on a machine: `npx agent-browser install`
downloads Chrome for Testing (~7s). `npx agent-browser doctor --offline --quick`
should report 0 fail.

## 1. Start the stack (background) and wait for it

Always use an **absolute** `KAN_DATA_DIR`. `npm run dev:server` runs inside
`apps/server/`, so a relative `data/e2e` lands in `apps/server/data/e2e`, which is
**not** gitignored and will show up in `git status`. The repo-root `/data/` is.

```bash
# from the repo root
KAN_DATA_DIR="$PWD/data/e2e" npm run dev:server > /tmp/kan-e2e-server.log 2>&1 &
npm run dev:web > /tmp/kan-e2e-web.log 2>&1 &
```

If `:8787` or `:1430` is already taken, something of the user's is running —
check with `lsof -nP -iTCP:8787 -sTCP:LISTEN` and **ask before killing it**.
Reusing an already-running stack is fine; just don't assume it has your code.

Block until both answer — **do not assume they booted**:

```bash
for i in $(seq 1 60); do
  [ "$(curl -s localhost:8787/healthz)" = '{"ok":true}' ] &&
  [ "$(curl -s -o /dev/null -w '%{http_code}' localhost:1430/)" = 200 ] && { echo READY; break; }
  grep -qiE "error|EADDRINUSE" /tmp/kan-e2e-server.log && { echo BOOT_ERROR; break; }
  grep -q "EADDRINUSE" /tmp/kan-e2e-web.log && { echo BOOT_ERROR; break; }
  sleep 1
done
tail -20 /tmp/kan-e2e-server.log /tmp/kan-e2e-web.log
```

Usually ready in ~3s. **Read the server log before continuing** — a crash shows
up there and nowhere else. `ExperimentalWarning: SQLite is an experimental
feature` on startup is noise, and so are `[vite] http proxy error …
ECONNREFUSED` lines in the web log from before the server was up (that is why
the loop doesn't grep the web log for `error`). Logs are overwritten with `>`
on each start; if you restart only the server, stale lines stay in the old log.
`/api/health` is 404 and `/health` returns the SPA; `/healthz` is the probe.

`data/e2e` is a throwaway: accounts, workspaces and canvases accumulate there.
`rm -rf data/e2e` (with the server stopped) resets it. Never point e2e runs at
`data/server`, the user's dev data.

## 2. Drive it

```bash
A="npx agent-browser"
$A open http://localhost:1430          # launches Chrome, prints the page title
$A wait "#signin-email"
$A snapshot -i                         # interactive elements only, with @refs
```

`snapshot -i` prints the accessibility tree:

```
- textbox "Email" [required, ref=e6]
- textbox "Password" [required, ref=e7]
- button "Sign in" [ref=e4]
- button "Create account" [ref=e5]
```

Core commands (every action prints `✓ Done`):

```bash
$A click @e5                            # by ref from the last snapshot
$A click 'button[type=submit]'          # by CSS
$A find role button click --name "Create canvas"   # by role + accessible name (most robust)
$A fill "#action-name" "Smoke"          # clears + sets; React state updates, no `type` needed
$A press Enter
$A wait "#action-name"                  # selector
$A wait --text "New canvas"             # visible text
$A wait --url "**canvas=*"              # URL glob
$A wait --fn "document.querySelector('.canvas-sync')?.textContent.includes('Connected')"
$A get text ".canvas-sync"              # → Connected
$A get url
$A eval "JSON.stringify(window.__kanWeb.tools.getCanvas())"
$A screenshot /tmp/kan-e2e.png          # then Read the file
$A console                              # browser console
$A errors                               # uncaught page errors
$A network requests --type xhr,fetch --status 400-599
$A reload
$A close                                # closes the default session's browser
```

Default `wait` timeout is 25s. `--json` gives structured output on most commands.

### Golden path (sign up → workspace → canvas → node)

The app is one route (`/`); auth state decides what renders. Element contract
(`apps/web/src/components/SignIn.tsx`, `WebCatalog.tsx`, `routes/index.tsx`):

| Screen | Elements |
| --- | --- |
| Signed out | `#signin-email`, `#signin-password`, submit "Sign in"; ghost "Create account" toggles sign-up (adds `#signin-name`, submit becomes "Create account"). Password ≥ 8 chars. |
| Catalog | "New workspace" / "Create workspace" (empty state), "New canvas" / "Create canvas", `select#workspace`, "Members & invites", "Sign out" |
| Dialog | `#action-name`, submit "Create workspace" / "Create canvas" / "Save name" / "Delete canvas" — **disabled until the field is non-empty** |
| Canvas | URL `?canvas=<uuid>`, `.canvas-sync[role=status]` reads "Connected", `window.__kanWeb = { editor, tools }`, chat `textarea#prompt`, button "Send", `select[aria-label=Thread]` |

```bash
A="npx agent-browser"; EMAIL="e2e+$(date +%s)@example.test"
$A open http://localhost:1430 && $A wait "#signin-email"
$A find role button click --name "Create account"
$A fill "#signin-name" "E2E User"
$A fill "#signin-email" "$EMAIL"
$A fill "#signin-password" password123
$A click 'button[type=submit]'
$A wait --text "New workspace"
$A find role button click --name "New workspace"
$A wait "#action-name" && $A fill "#action-name" E2E
$A find role button click --name "Create workspace"
$A wait --text "New canvas"
$A find role button click --name "New canvas"
$A wait "#action-name" && $A fill "#action-name" Smoke
$A find role button click --name "Create canvas"
$A wait --url "**canvas=*"
$A wait --fn "document.querySelector('.canvas-sync')?.textContent.includes('Connected')"
$A eval "JSON.stringify(window.__kanWeb.tools.addNode({draft:{type:'markdown',title:'Hello',body:'# Hi'}}))"
$A eval "JSON.stringify(window.__kanWeb.tools.getCanvas().counts)"   # {"byType":{"markdown":1}}
$A screenshot /tmp/kan-e2e-canvas.png
```

Use a fresh email per run; sign-up fails on a duplicate. To test an existing
account, sign in with the same email/password instead.

### Tool layer from the browser

`window.__kanWeb.tools` is `createCanvasTools(editor)` — `addNode`, `updateNode`,
`removeNodes`, `connectNodes`, `arrange`, `focusNodes`, `groupNodes`,
`getCanvas`. Inputs are zod-parsed; the `addNode` input is
`{ draft: { type, ... }, near?, at? }` — the draft is **nested**, a top-level
`{type:'markdown'}` fails validation. `eval` returns values JSON-quoted, so wrap
objects in `JSON.stringify(...)` or you get `[object Object]`.

### Two users / sync

Each `--session <name>` has its own cookies and browser:

```bash
$A --session two open "http://localhost:1430/?canvas=<id>"   # lands on sign-in
# sign in there, then:
$A --session two wait --fn "window.__kanWeb.tools.getCanvas().nodes.length===2"
$A session list
$A --session two close
```

Edits made in one session must appear in the other without a reload — that is
the sync assertion. The first `open` of a new session launches another Chrome
(~10s).

### Chat without the agent

With no eve on `:3100`, sending a prompt leaves the message at **Queued** and the
server log fills with `server.dispatch_failed { name: 'TypeError' }` on retry —
the dispatch fetch to `EVE_URL` is refused. That is the expected shape of "agent
not running", not a bug in your change. Real agent turns need `npm run dev:agent`
with `AI_GATEWAY_API_KEY` set in `.env.local`; say explicitly when a check ran
without it.

## 3. Stop when done

```bash
npx agent-browser close --all
pkill -f "tsx watch src/main.ts"; kill $(lsof -tiTCP:1430 -sTCP:LISTEN)   # only if you started them
```

Killing only the `:8787` listener leaves the `tsx watch` parent alive, which
is why the server is stopped by name.

The agent-browser daemon exits by itself after an hour idle and drops cookies
and tabs with it; a signed-in session will not survive that.

## Gotchas that have already bitten

- **Refs go stale across dialogs.** `@e16` from a snapshot before a dialog opened
  may point elsewhere after. Re-`snapshot -i` after any navigation or dialog
  change, or use `find role button click --name` which doesn't depend on refs.
- **`:has-text()` is not a selector here.** `button:has-text("Create")` →
  `✗ Element not found`. Use `find role … --name` or a ref.
- **`wait --load networkidle` never resolves.** The canvas page polls
  `history` and `meeting` every 2s and holds a WebSocket. Wait on a selector,
  text, URL or `--fn` instead.
- **`network requests` is noisy** for the same reason; filter with `--type
  xhr,fetch`, `--status 400-599`, `--filter <substr>`, or `--clear` first.
- **`snapshot -i` on the canvas is ~100 lines** of tldraw toolbar. Scope it:
  `snapshot -i -s "section.web-chat"`.
- **A relative `KAN_DATA_DIR` pollutes `git status`** (see §1). Always `$PWD/…`.
- **A screenshot can lie mid-transition.** Controls have `transition-all`; a
  shot right after a click can show a half-faded state. Confirm with
  `eval getComputedStyle(...)` before reporting a contrast bug.
- **`npm run dev:web` uses `strictPort`.** If 1430 is taken it fails rather
  than picking another port — check the log, don't wait on the port.
- **A backend edit strands the open canvas.** `tsx watch` restarts the server
  (back on `/healthz` in ~3s, data intact), but the room socket does not
  reconnect through the Vite proxy: `.canvas-sync` sits on "Reconnecting…"
  for 75s+ in every open session. `npx agent-browser reload` and wait for
  "Connected" again. Frontend edits hot-reload into the open tab fine.
- **Don't re-run the app to "check" a passing edit.** Re-verify only what the
  change could plausibly have broken.

## Report honestly

State what you actually observed, with the commands and their output. If a step
was skipped or a check didn't run (no agent, no second user, no screenshot), say
so plainly instead of implying full coverage. If something failed, show the
output and the relevant lines from `/tmp/kan-e2e-server.log`.
