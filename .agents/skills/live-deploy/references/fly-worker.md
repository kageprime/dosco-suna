# Fly.io background worker

The scheduled-job worker runs as one always-on Fly Machine in the `dosco-worker`
app. The Heroku API (`web.1`) stays where it is; the Heroku worker dyno remains
scaled to zero (`worker=0:Standard-1X`) as the rollback lever.

## Why this is safe

`apps/api/src/worker.ts` joins a DB lease election (`kortix.worker_leader_lease`,
60 s TTL). Only the lease holder runs jobs. The Fly worker is the only process
with `KORTIX_WORKERS_ENABLED=true` while the Heroku worker is at zero, so there
is no double-firing. `kill_timeout = 120` in `fly.toml` lets it release the
lease on SIGTERM before a forced shutdown.

## One-time setup

`fly.toml` at the repo root owns the build and process command:

- `[build] dockerfile = "Dockerfile.heroku"` with repo-root context.
- `[processes] worker = "/app/apps/api/start-worker.sh"`.
- No public `services`; the worker only binds a health listener on port 8008.
- `[checks.worker_ready]` GETs `/health/ready` every 30 s.

```powershell
$fly = 'C:\Users\kage\AppData\Local\Microsoft\WinGet\Packages\Fly-io.flyctl_Microsoft.Winget.Source_8wekyb3d8bbwe\flyctl.exe'
& $fly auth whoami                        # must succeed before anything below
& $fly apps create dosco-worker   # personal org is selected automatically
```

Copy the 61 Heroku config vars into Fly secrets. This pipeline keeps values in
memory; it never prints them and never writes them to a file:

```powershell
$cfg = heroku config -a dosco --json | ConvertFrom-Json
$skip = @('PORT','DYNO','KORTIX_WORKERS_ENABLED','WORKER_DB_POOL_MAX','FLY_APP_NAME')
$lines = @($cfg.PSObject.Properties | Where-Object { $skip -notcontains $_.Name } | ForEach-Object { "$($_.Name)=$($_.Value)" })
$lines -join "`n" | & $fly secrets import --app dosco-worker
```

`PORT` and the worker flags come from `[env]` in `fly.toml`. `KORTIX_TRIGGER_SCHEDULER_ENABLED=false`
is copied from Heroku on purpose: it was disabled after a connection leak.

## Deploy

```powershell
& $fly deploy --app dosco-worker --wait-timeout 10m
& $fly scale count 1 --process-group worker --app dosco-worker
& $fly scale vm shared-cpu-1x --memory 1024 --process-group worker --app dosco-worker
```

## Verify

```powershell
& $fly logs --app dosco-worker            # expect "[worker] ready: joined the leader election"
& $fly ssh console --app dosco-worker --command 'curl -s http://127.0.0.1:8008/health/ready'
# expect {"status":"ok","role":"worker"}
heroku ps -a dosco                         # must still show web.1 up, worker=0
curl.exe -s -o NUL -w "%{http_code}\n" https://api.dosco.live/health
```

## Rollback

```powershell
& $fly scale count 0 --process-group worker --app dosco-worker
heroku ps:scale worker=1 -a dosco          # only if jobs must run during the rollback window
```
