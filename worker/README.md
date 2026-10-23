# Computer Connector Worker

A worker is a private execution node behind the Computer Connector controller. It runs the existing `agent.mjs` and Desktop Commander; it does not expose OAuth or Funnel endpoints. Workers can connect over a private LAN or Tailscale. No hosted relay is used.

A same-machine worker connects to the local hub at `127.0.0.1:18101` and is registered with `local: true`. A worker on another machine connects to the remote hub on port `18100`, which exists only when the controller starts with `WC_WORKER_REMOTE_HOST=<controller-private-ip>`. Remote entries use `local: false`, a unique 32–512 character `token`, and `allowedIps` containing the worker's expected LAN and/or Tailscale source IPs. Keep worker tokens only in local environment files; never commit them.

## Requirements

- Node.js 22.12 or newer for native workers (required by Desktop Commander 0.3.1)
- A matching controller `config/devices.json` entry with a unique token
- For remote workers: the worker source LAN/Tailscale IP in `allowedIps`, and the controller remote hub bound to a private interface
- Tailscale is optional; use it when the hosts are not on the same trusted LAN
- Docker deployment (optional): Docker Desktop

## macOS LaunchAgent

The LaunchAgent template at `worker/services/com.computer-connector.worker.plist` runs `worker/agent.mjs` as the logged-in user. It does not need Docker, root, OAuth, or a public Funnel. Install Desktop Commander dependencies in the repository's `worker` directory first (`npm ci --omit=dev`), then create a private environment file and customize the template placeholders for your machine:

```sh
mkdir -p "$HOME/.config/computer-connector" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$HOME/.config/computer-connector/worker.env" <<'EOF'
WC_DEVICE_ID=mac-worker
WC_DEVICE_NAME=My Mac
WC_CONTROLLER_HOST=100.64.0.1
WC_CONTROLLER_PORT=18100
WC_WORKER_TOKEN=replace-with-the-same-32-plus-character-token-from-devices-json
WC_DC_SCRIPT=/absolute/path/to/computer-connector/worker/node_modules/@wonderwhy-er/desktop-commander/dist/index.js
WC_RECONNECT_MS=3000
EOF
chmod 600 "$HOME/.config/computer-connector/worker.env"
```

`WC_WORKER_TOKEN` is mandatory and must exactly match that worker's token in the controller registry. Keep the environment file user-owned and mode `600`. For a worker running on the same controller Mac, use `WC_CONTROLLER_HOST=127.0.0.1`, `WC_CONTROLLER_PORT=18101`, and register it as `local: true`. Copy the plist template to `~/Library/LaunchAgents/com.computer-connector.worker.plist` after replacing `__NODE_BINARY__` with the absolute path to Node, `__REPO_ROOT__` with the absolute repository path, `__WORKER_ENV__` with the environment file path, and `__HOME__` with the user's absolute home path. Then load the agent:

```sh
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.computer-connector.worker.plist"
launchctl enable "gui/$(id -u)/com.computer-connector.worker"
launchctl kickstart -k "gui/$(id -u)/com.computer-connector.worker"
launchctl print "gui/$(id -u)/com.computer-connector.worker"
```

To stop and remove it, run `launchctl bootout "gui/$(id -u)/com.computer-connector.worker"` and remove the copied plist. Logs are written under `~/Library/Logs/`. For multiple workers on one Mac, make separate plist copies with unique labels and environment files.

## Linux systemd user service

The systemd template at `worker/services/computer-connector-worker@.service` runs as a user service. It needs no root service, Docker, or elevated capabilities. Install dependencies in `worker` (`npm ci --omit=dev`), create a user-owned configuration directory and one environment file per worker instance, and restrict the file to its owner:

```sh
mkdir -p "$HOME/.config/systemd/user" "$HOME/.config/computer-connector"
cat > "$HOME/.config/computer-connector/linux-worker.env" <<'EOF'
WC_DEVICE_ID=linux-worker
WC_DEVICE_NAME=My Linux host
WC_CONTROLLER_HOST=100.64.0.1
WC_CONTROLLER_PORT=18100
WC_WORKER_TOKEN=replace-with-the-same-32-plus-character-token-from-devices-json
WC_DC_SCRIPT=/absolute/path/to/computer-connector/worker/node_modules/@wonderwhy-er/desktop-commander/dist/index.js
WC_RECONNECT_MS=3000
EOF
chmod 600 "$HOME/.config/computer-connector/linux-worker.env"
```

`WC_WORKER_TOKEN` is mandatory and must exactly match the controller registry. Copy the unit template to `~/.config/systemd/user/computer-connector-worker@.service`; edit `ExecStart` if your repository or Node binary is outside its default path (`%h/computer-connector` and `/usr/bin/node`). The instance name selects its env file, so `computer-connector-worker@linux-worker.service` reads `~/.config/computer-connector/linux-worker.env`:

```sh
systemctl --user daemon-reload
systemctl --user enable --now computer-connector-worker@linux-worker.service
systemctl --user status computer-connector-worker@linux-worker.service
journalctl --user -u computer-connector-worker@linux-worker.service
```

`UMask=0077` and normal user ownership protect files created by the service. Keep the service under the account that should have Desktop Commander access; do not run it as root or enable systemd lingering unless unattended operation after logout is explicitly desired. Use the service's filesystem and network access only with paths and private addresses appropriate for that account. Stop/remove an instance with `systemctl --user disable --now computer-connector-worker@linux-worker.service`.

## Native Windows worker

The native deployment runs the same `agent.mjs` used by the Controller host. The installer performs the pinned `npm ci`, writes a local-only Windows `worker.env`, registers a per-device hidden Scheduled Task, and starts `native-worker-supervisor.ps1`. The supervisor keeps exactly one matching agent alive and restarts it after failure.

Install:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\path\to\computer-connector\worker\install-native-worker.ps1 `
  -DeviceId remote-worker `
  -ControllerHost 100.64.0.1 `
  -WorkerToken '<same-token-as-controller-registry>'
```

Check local task/process/log state:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\path\to\computer-connector\worker\status-native-worker.ps1 `
  -DeviceId remote-worker
```

Uninstall the native task and its generated local state:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\path\to\computer-connector\worker\uninstall-native-worker.ps1 `
  -DeviceId remote-worker
```

Generated configuration is stored under `config/worker-native-<deviceId>.env`; PID/launcher state is under `.state/`, and runtime logs are under `logs/`. These paths are excluded from Git.

For a native worker, Controller-side `pathMappings` must reflect native Windows paths. Do not retain Docker mappings such as `C:\ -> /host`. Because the Router loads `config/devices.json` at startup, changing path mappings requires a controlled Router restart.

Do not start a native worker while another worker with the same `deviceId` is connected. Cut over by stopping the old worker first, starting the native task, and verifying that the Controller reports exactly one online device.

## Docker worker

The Docker deployment remains available when host filesystem isolation is desired:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\path\to\computer-connector\worker\install-docker-worker.ps1 `
  -DeviceId remote-worker `
  -ControllerHost 100.64.0.1 `
  -WorkerToken '<same-token-as-controller-registry>'
```

The Docker installer creates a dedicated `computer-connector-worker` container with `restart=unless-stopped`. Its default mounts are `C:\ -> /host` read-only, the configured workspace root -> `/workspace` read-write, and the worker directory -> `/app` read-write.

Remove that container with:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\path\to\computer-connector\worker\uninstall-docker-worker.ps1
```

## Media and response stability guards

All native worker deployments use the pinned Desktop Commander 0.3.1 package and apply `patches/desktop-commander-image-guard.mjs` during dependency installation. The patch is version/layout-gated and preserves 0.3.1 SVG behavior while adding image decode/pixel bounds and stdout JSON-RPC size guards.

The patch validates image decoding and pixel bounds before returning inline image content. Invalid image-like files fall back to binary-file handling. Large valid images are converted to bounded WebP previews. The default raw inline-image budget is 64 KiB and can be overridden with `DESKTOP_COMMANDER_MAX_INLINE_IMAGE_BYTES`.

Desktop Commander stdout is guarded before JSON-RPC leaves the child process. Complete guarded responses larger than 512 KiB are replaced with a compact `-32099` error; `DESKTOP_COMMANDER_MAX_STDOUT_JSON_BYTES` and `WC_MAX_DC_RESPONSE_BYTES` control the two response limits.

Run focused worker regression checks from an independent terminal:

```powershell
Set-Location -LiteralPath C:\path\to\computer-connector\worker
npm.cmd run test:stability
```

Do not run disruptive live gateway tests through the same WCM connection that is carrying the current session.
