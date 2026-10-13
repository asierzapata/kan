#!/bin/sh
# One-shot setup for the box that runs the kan server. Idempotent: safe to re-run.
#
#   curl -fsSL https://raw.githubusercontent.com/asierzapata/kan/main/deploy/bootstrap.sh | sh
#
# Run it on the VM, not the Proxmox host. Docker inside LXC needs nesting=1 and
# keyctl=1 and fails in confusing ways; a small Debian VM just works.
set -eu

REPO_URL=${KAN_REPO_URL:-https://github.com/asierzapata/kan.git}
REPO=${KAN_REPO:-/srv/kan}
ENV_FILE=${KAN_ENV_FILE:-/srv/kan.env}
BRANCH=${KAN_BRANCH:-main}

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }

echo "--> packages"
command -v git >/dev/null || { apt-get update -qq && apt-get install -y -qq git; }
command -v flock >/dev/null || apt-get install -y -qq util-linux
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || { echo "docker compose plugin missing" >&2; exit 1; }

echo "--> repo"
if [ -d "$REPO/.git" ]; then
  git -C "$REPO" remote set-url origin "$REPO_URL"
  git -C "$REPO" fetch --quiet origin "$BRANCH"
  git -C "$REPO" reset --hard --quiet "origin/$BRANCH"
else
  mkdir -p "$(dirname "$REPO")"
  git clone --quiet --branch "$BRANCH" "$REPO_URL" "$REPO"
fi

echo "--> env file"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<'TEMPLATE'
# Fill these in, then: systemctl start kan-deploy.service
# Lives outside the repo on purpose, so a checkout can never clobber it.
CF_TUNNEL_TOKEN=
AI_GATEWAY_API_KEY=
VONAGE_APPLICATION_ID=
VONAGE_PRIVATE_KEY=
TEMPLATE
  chmod 600 "$ENV_FILE"
  echo "    created $ENV_FILE (empty, fill it in)"
else
  echo "    $ENV_FILE exists, left alone"
fi

echo "--> deploy script + timer"
install -m 755 "$REPO/deploy/kan-deploy.sh" /usr/local/bin/kan-deploy
install -m 644 "$REPO/deploy/kan-deploy.service" /etc/systemd/system/kan-deploy.service
install -m 644 "$REPO/deploy/kan-deploy.timer" /etc/systemd/system/kan-deploy.timer
systemctl daemon-reload
systemctl enable --now kan-deploy.timer

echo
echo "done. next:"
echo "  1. fill in $ENV_FILE"
echo "  2. systemctl start kan-deploy.service   # first deploy, or wait 60s"
echo "  3. journalctl -u kan-deploy -f"
