#!/bin/sh
# Polls origin/main and rebuilds if it moved. Installed to /usr/local/bin/kan-deploy
# by bootstrap.sh and driven by kan-deploy.timer.
#
# Deliberately a *copy* outside the repo: the deploy does `git reset --hard`, and
# a running shell script whose file is rewritten under it will misparse.
set -eu

REPO=${KAN_REPO:-/srv/kan}
ENV_FILE=${KAN_ENV_FILE:-/srv/kan.env}
BRANCH=${KAN_BRANCH:-main}
LOCK=${KAN_LOCK:-/srv/kan.deploy.lock}
SERVICE=${KAN_SERVICE:-server}

# flock has to wrap the whole run, not guard a single line, so re-exec under it.
# -E 75 distinguishes "lock held" from the script's own exit codes.
if [ -z "${KAN_LOCKED:-}" ]; then
  KAN_LOCKED=1; export KAN_LOCKED
  flock -n -E 75 "$LOCK" "$0" "$@" && exit 0
  rc=$?
  [ "$rc" -eq 75 ] && { echo "deploy already running, skipping"; exit 0; }
  exit "$rc"
fi

cd "$REPO"
git fetch --quiet origin "$BRANCH"

have=$(git rev-parse HEAD)
want=$(git rev-parse "origin/$BRANCH")

# `ps -q` lists running containers only, so an empty result means the stack is
# down. Checking it as well as the sha covers two cases the sha alone misses:
# the very first run after a clone (already at origin/main, nothing built yet),
# and a stack that died since the last tick.
running=$(docker compose --env-file "$ENV_FILE" ps -q "$SERVICE" 2>/dev/null || true)

if [ "$have" = "$want" ] && [ -n "$running" ] && [ -z "${KAN_FORCE:-}" ]; then
  exit 0
fi

if [ "$have" = "$want" ]; then
  echo "--> $(git rev-parse --short "$have") (no new commit; stack down or forced)"
else
  echo "--> $(git rev-parse --short "$have") -> $(git rev-parse --short "$want")"
fi
git reset --hard --quiet "origin/$BRANCH"

# Refresh our own installed copy for the next tick, from the new checkout.
if [ -f deploy/kan-deploy.sh ] && [ -w /usr/local/bin/kan-deploy ]; then
  cp deploy/kan-deploy.sh /usr/local/bin/kan-deploy
  chmod +x /usr/local/bin/kan-deploy
fi

echo "--> build"
docker compose --env-file "$ENV_FILE" up -d --build --remove-orphans

echo "--> health"
cid=$(docker compose --env-file "$ENV_FILE" ps -q "$SERVICE")
i=0
while [ "$i" -lt 30 ]; do
  case "$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null)" in
    healthy)   echo "--> ok $(git rev-parse --short HEAD)"; exit 0 ;;
    unhealthy) break ;;
  esac
  i=$((i + 1))
  sleep 2
done

echo "!!! $SERVICE never became healthy" >&2
docker compose --env-file "$ENV_FILE" logs --tail 50 "$SERVICE" >&2
exit 1
