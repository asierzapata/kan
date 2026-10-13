# Deploying the kan server

One box, one container, pulling from `origin/main`. There is no CI and no PaaS:
a systemd timer on the box polls GitHub every 60s and rebuilds when `main` moves.

The server is a **single stateful process**. Rooms, sessions and pending edits
live in memory (`apps/server/src/rooms.ts`, with SQLite and Postgres behind it), so there is no second replica
and every deploy drops open `/sync` sockets. Turn the timer off
before a demo: `systemctl stop kan-deploy.timer`.

## Box setup

A small Debian VM on Proxmox, not an LXC container. Docker in LXC needs
`nesting=1` and `keyctl=1` and fails in ways that are not worth debugging.

```sh
curl -fsSL https://raw.githubusercontent.com/asierzapata/kan/main/deploy/bootstrap.sh | sh
```

Then fill in `/srv/kan.env` and either wait a minute or run
`systemctl start kan-deploy.service`. Watch it with `journalctl -u kan-deploy -f`.

`/srv/kan.env` lives outside the work tree deliberately. The deploy does
`git reset --hard`, and secrets sitting inside `/srv/kan` would be one
`git clean` away from gone.

## Deploying

`git push origin main`. That is the whole workflow. The box notices within 60s.

To force a rebuild without a new commit: `KAN_FORCE=1 kan-deploy`.

## Layout on the box

| Path | What |
| --- | --- |
| `/srv/kan` | the checkout, reset hard on every deploy |
| `/srv/kan.env` | secrets, `chmod 600`, never touched by a deploy |
| `/usr/local/bin/kan-deploy` | a **copy** of `deploy/kan-deploy.sh` |
| `/srv/kan.deploy.lock` | flock, so overlapping ticks cannot build over each other |

The deploy script is copied out of the repo rather than run from it. A running
shell script whose file is rewritten underneath it will misparse, and
`git reset --hard` rewrites it.

## Exposure

`cloudflared` runs as a sidecar in the compose file and needs `CF_TUNNEL_TOKEN`.
Point a public hostname at `server:8787` and set `KAN_PUBLIC_URL` to that
origin. Browsers connect over `wss://`, which the tunnel proxies fine. The server
variables are listed in `apps/web/README.md`.

## What happens when a deploy fails

The unit goes red and the old containers keep running, because
`docker compose up` only swaps them once the build succeeds. Nothing tells you,
though. `systemctl status kan-deploy` is the only signal, so check it if the app
starts behaving like an older build.
