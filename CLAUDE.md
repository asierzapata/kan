@AGENTS.md

## Before you say it works

Compiling is not working. **Run the app and drive it** before calling any UI or
frontend change done — use the `e2e` skill (`.agents/skills/e2e/`), which has
the commands and the traps. Start the web stack (`dev:server` with an absolute
`KAN_DATA_DIR`, `dev:web`) and drive `http://localhost:1430` with
`npx agent-browser`.

If you skipped a check, say so instead of implying you ran it.

## Deploying a new alpha version

The landing site's release artifact is **`apps/site/public/kan-alpha.dmg`**.
Always replace this file with the fresh macOS Apple Silicon alpha; the site's
stable download URL is **`/kan-alpha.dmg`**.

From the repo root:

1. Commit the app changes.
2. Run `node scripts/build-alpha.mjs` on an Apple Silicon Mac. This freshly builds
   and verifies the alpha, then stages the DMG at the path above. It requires a
   production tldraw license in the build environment/root `.env.local` and uses
   the checked-in native icon catalog. Never commit the env file.
3. Launch and exercise the packaged `Kan Alpha.app`, including a canvas open for
   more than five seconds. Do not count compilation alone as a passing release.
4. Run `npm run build -w @kan/site`, preview the site, and verify that
   `/kan-alpha.dmg` returns the DMG with the same SHA-256 as the staged file.
5. Commit the new DMG and release changes, then deploy the Vercel site when asked.
   Do not push automatically. Local staging is not a hosted deployment.

Keep WebDriver off in release bundles. The download is Apple Silicon-only and
ad-hoc signed, not notarized. See `AGENTS.md` for the full release procedure.
