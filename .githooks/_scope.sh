#!/bin/sh
# Works out which workspaces a list of paths touches.
#
# Reads NUL-free paths on stdin, sets: CHECK_DESKTOP, CHECK_BACKEND, CHECK_WEB (0 or 1).
# Root config (package.json, turbo.json, the tsconfigs, the lockfile) touches
# everything, so it turns all three on.

CHECK_WEB=0
CHECK_DESKTOP=0
CHECK_BACKEND=0

while IFS= read -r path; do
  [ -n "$path" ] || continue
  case "$path" in
    apps/web/*|apps/web-agent/*|apps/realtime/*)
      CHECK_WEB=1 ;;
    apps/desktop/*)
      CHECK_DESKTOP=1 ;;
    apps/room-server/*|apps/agent-runner/*|tsconfig.backend.json)
      CHECK_BACKEND=1 ;;
    packages/*)
      # Shared by both sides, so a change here has to satisfy both.
      CHECK_DESKTOP=1; CHECK_BACKEND=1; CHECK_WEB=1 ;;
    package.json|package-lock.json|turbo.json)
      CHECK_DESKTOP=1; CHECK_BACKEND=1; CHECK_WEB=1 ;;
  esac
done

export CHECK_DESKTOP CHECK_BACKEND CHECK_WEB
