#!/bin/sh
# Works out which workspaces a list of paths touches.
#
# Reads NUL-free paths on stdin, sets: CHECK_DESKTOP, CHECK_WEB (0 or 1).
# Web covers apps/web, apps/web-agent, apps/server and packages/web-core.
# Root config (package.json, turbo.json, the lockfile) touches everything.

CHECK_WEB=0
CHECK_DESKTOP=0

while IFS= read -r path; do
  [ -n "$path" ] || continue
  case "$path" in
    apps/web/*|apps/web-agent/*|apps/server/*|packages/web-core/*)
      CHECK_WEB=1 ;;
    apps/desktop/*)
      CHECK_DESKTOP=1; CHECK_WEB=1 ;;
    packages/*)
      # Shared by both sides, so a change here has to satisfy both.
      CHECK_DESKTOP=1; CHECK_WEB=1 ;;
    package.json|package-lock.json|turbo.json)
      CHECK_DESKTOP=1; CHECK_WEB=1 ;;
  esac
done

export CHECK_DESKTOP CHECK_WEB
