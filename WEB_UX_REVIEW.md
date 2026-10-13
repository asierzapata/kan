# Desktop → web flow review

Reviewed 13 October 2026 against the desktop catalog, canvas/chat shell, shared
thread primitives, and the marketing page in `apps/site`. This is a local change;
no web deployment was made. Existing backend migration work was preserved.

## Design direction

Keep the compact desktop editor and its shared components. Entry and catalog
surfaces use the landing page's warm paper, cobalt actions, dotted canvas, and
quiet typography. Workspace administration belongs in a focused dialog, while
canvases remain the main catalog content. Card previews are explicitly monograms,
not generated thumbnails of a document.

Mobbin was requested but no callable Mobbin tool or discoverable plugin was
available in this session. No Mobbin references were used.

## Flow inventory

| Flow | Migration issue / change | Verification |
| --- | --- | --- |
| Signed-out entry | Bare unstyled heading and sign-in anchor → branded entry with product context and a canvas illustration | Real local Start app inspected in browser |
| Sign-in | Saved server-only test credentials locally; added authorized localhost callback while retaining existing redirects | Real WorkOS sign-in form reached; account sign-in awaits user |
| Catalog loading | Welcome/empty form shown before catalog finished → explicit loading state | Typechecked; authenticated live catalog awaits backend configuration |
| First workspace | Shared Name field → named creation dialog with validation and busy state | Actual component with synthetic HTTP responses; new workspace selected |
| Workspace switching | Named selector, role display, search reset | Synthetic browser flow |
| Canvas catalog | Action-heavy horizontal rows → responsive desktop-style card grid and search | Desktop and 390 px browser inspection; no horizontal overflow |
| Empty/search state | No explanation or next action → shared Empty component with specific copy and next action | Synthetic browser inspection |
| Canvas creation | Workspace name reused for canvas name → separate dialog; successful creation opens canvas | Synthetic browser mutation and route state |
| Rename | Global Name field affected every row → prefilled dialog scoped to selected canvas | Rename saved and updated catalog in synthetic browser |
| Delete | Immediate deletion → confirmation names canvas and explains workspace-wide effect; busy state prevents closing during request | Confirmation and cancellation exercised; live deletion not performed |
| Invitations | Always-visible accept action → invite-only callout; dedicated email/role form and share/copy link result | Synthetic invitation creation inspected; recipient authorization remains backend behavior |
| Members | Admin controls crowded catalog → owner-only member dialog with role controls | Synthetic member list inspected; live permission mutation not performed |
| Canvas/editor | Viewers could see editable tldraw → set isReadonly; human-readable connection state; selection action hidden for zero selections | Typechecked; real realtime/editor verification pending |
| Selection → chat | Selection anchored without revealing narrow chat → selection action opens chat | Code reviewed; real synced editor verification pending |
| Chat/history | Markdown rendered as plain text → desktop AgentMarkdown; empty conversation guidance; readable author labels and run statuses | Actual Markdown heading/list/bold rendered in synthetic browser |
| Chat navigation | Unclear Chat toggle → explicit Show/Hide labels; preserve mounted canvas/chat; browser popstate handled | 390 px toggle preserved draft; no horizontal overflow |
| Composer | Missing placeholder/feedback → context prompt, view-only explanation, Sending state, Cmd/Ctrl+Enter shortcut | Draft persistence exercised; shortcut and live submission pending |
| Streaming/retry/cancel/undo | Existing durable run behavior retained; statuses made readable; jump-to-latest control added | 46 web-core tests passed; live agent UI verification pending |
| Transcript/evidence | Synthetic test vocabulary surfaced as a user-facing meeting flow → manual meeting notes, clear absence of live capture | Synthetic browser inspected manual notes explanation |
| Sign-out | Existing WorkOS sign-out retained | Real authenticated sign-out pending |
| Desktop video/prejoin/provider login | Intentionally replaced/retired in web architecture | Not reintroduced: WorkOS replaces local provider login; live meeting capture remains a later integration |

## Evidence and limits

- `npm run typecheck:web` passed after the catalog/editor changes.
- `npm run build:web` passed after the main UI changes.
- `npm run test:web`: 46 passed, 0 failed, 0 skipped.
- `git diff --check` passed.
- Synthetic browser review runs the actual WebApp/WebCatalog components, replacing
  AuthKit and HTTP responses only in a separate Vite configuration. It does not
  connect to WorkOS, Neon, the realtime worker, or eve. Its canvas cannot sync.
- Real Start/AuthKit rendered the signed-out page and reached the WorkOS form
  after the localhost redirect was registered.
- Local WorkOS variables alone do not configure the database, KAN_ENV, realtime
  worker, or agent runtime. Full authenticated/live acceptance remains open.
- No Tauri verification was run; edits are restricted to the web workspace and
  the isolated web review fixture.

## Reproduce the isolated browser review

From the repository root:

```sh
npx vite --config scripts/web/ui-review/vite.config.ts
```

Open `http://localhost:1431/scripts/web/ui-review/index.html`. `?empty` selects
an empty catalog and `?signed-out` selects the entry page. Data is in-memory and
resets on reload. The fixture is outside the production Start route tree.

Real local development uses `npm run dev:web`. WorkOS test configuration is
stored in gitignored `apps/web/.env.local`, with mode 0600. Existing deployment
variables take precedence. No server secret has a VITE_ prefix.
