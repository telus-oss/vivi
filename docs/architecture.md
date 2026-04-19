# Architecture

## Overview

```
You (browser) ──── REST + WebSocket ────► Vivi server (Express, port 7700)
                                              │
                                              │ docker run / exec
                                              ▼
                                   ┌─── Docker network (internal) ───┐
                                   │                                  │
                                   │  Sandbox container(s)            │
                                   │  • Claude Code (no permissions)  │
                                   │  • git + gh + Docker CLI         │
                                   │  • git daemon for push/pull      │
                                   │                                  │
                                   │  MITM Proxy ◄──── all traffic    │
                                   │  • injects API keys              │
                                   │  • intercepts git push           │
                                   │  • enforces allowlist            │
                                   │                                  │
                                   │  DinD daemon (shared)            │
                                   │  • per-session socket proxies    │
                                   └──────────────────────────────────┘
```

## Components

### Vivi server (`server/`)

Express + WebSocket server running on the host. Manages container lifecycle, bridges terminals, handles PR approval, and serves the React UI.

| Module | Role |
|--------|------|
| `index.ts` | REST + WebSocket routes, rate limiting, graceful shutdown |
| `container.ts` | Multi-session lifecycle — `docker run`, git bundle, session restore |
| `pty.ts` | WebSocket PTY bridge, persistent Claude sessions that survive tab switches |
| `pr.ts` | PR interception, approval workflow, git bundle extraction |
| `ports.ts` | TCP port forwarding via `docker exec` + socat |
| `secrets.ts` | Secret store (SQLite) + proxy config sync |
| `allowlist.ts` | Network allowlist management |
| `docker-namespace-proxy.ts` | Per-session Docker socket proxy (prevents namespace escape) |
| `docker-events.ts` | Event-driven container state tracking (replaces polling) |
| `monitor.ts` | Activity monitor for agent health tracking |
| `profiles.ts` | Named Claude profile management (`~/.claude` persistence) |
| `github-issues.ts` | GitHub Issues integration |
| `sandbox-images.ts` | Sandbox image registry (CRUD + validation) |
| `updater.ts` | Git-based auto-update detection |
| `auth.ts` | OAuth token capture |
| `db.ts` | SQLite setup |
| `migrate.ts` | Migration runner |

### Frontend (`src/`)

React + Vite SPA with a multi-tab session interface.

| Component | Role |
|-----------|------|
| `App.tsx` | Session management, tab routing, panel layout |
| `Terminal.tsx` | ghostty-web WASM terminal emulator |
| `Approvals.tsx` | Branch approval sidebar (pull local / create PR) |
| `PortForwards.tsx` | Port forwarding panel |
| `SecretManager.tsx` | API key management + OAuth |
| `SandboxLogs.tsx` | Container log viewer |
| `Allowlist.tsx` | Network rules editor |
| `DockerContainers.tsx` | DinD container listing with live logs and inspect |
| `LiveDiffView.tsx` | Real-time working tree diff |
| `DiffView.tsx` | Branch diff viewer |
| `SandboxImages.tsx` | Sandbox image management |
| `ProfileManager.tsx` | Profile CRUD |
| `GitHubIssues.tsx` | Issue-to-session launcher |

### Docker infrastructure (`docker/`)

| File | Role |
|------|------|
| `proxy.ts` | MITM proxy — key injection, push interception, credential proxying |
| `Dockerfile.sandbox` | Sandbox image (Claude Code + git + gh + socat + Docker CLI) |
| `Dockerfile.proxy` | Proxy image |
| `entrypoint.sh` | Sandbox init (bundle clone, git config, CLAUDE.md, git daemon) |
| `open-port.sh` | Port forwarding request script |
| `open-git.sh` | Git server management |

### Orchestration

| File | Role |
|------|------|
| `docker-compose.yml` | Proxy + DinD daemon |
| `docker-compose.full.yml` | Full stack (app + proxy + DinD) for containerized deployment |

## Request flow

### Session start

1. User enters repo path + task description in UI
2. Server creates a git bundle of tracked files (`.env` and gitignored files excluded)
3. Server ensures proxy + DinD are running via docker-compose
4. Server starts a per-session Docker socket proxy
5. Server runs `docker run` with the sandbox image, mounting the bundle and proxy CA
6. Sandbox entrypoint clones from the bundle, configures git, starts git daemon
7. Server waits for readiness signal, then connects the browser terminal via WebSocket PTY

### API key injection

1. User adds a secret in the UI (e.g., Anthropic API key)
2. Server stores the real key and generates a placeholder (`sk-sandbox-{id}`)
3. Placeholder is injected into the sandbox as an env var
4. When the sandbox makes an API request, the MITM proxy swaps the placeholder for the real key
5. The sandbox never sees or logs the real credential

### Git push / PR approval

1. Agent runs `git push origin my-branch` inside the sandbox
2. MITM proxy intercepts the GitHub API call
3. Proxy sends the branch metadata to the Vivi server
4. Server surfaces it in the UI as a pending approval
5. User reviews the diff and chooses: pull locally or create a GitHub PR
6. Server extracts changes via git bundle and executes the chosen action on the host

## Security model

| Layer | Enforcement |
|-------|-------------|
| Git bundle | Only tracked files enter the sandbox |
| Internal Docker network | Sandbox has no direct internet access |
| MITM proxy | All HTTPS traffic inspected; allowlist enforced |
| Credential proxy | Real keys exist only in the proxy process |
| Docker namespace proxy | Per-session socket prevents container escape |
| Rate limiting | `express-rate-limit` on expensive endpoints |
| Shell injection prevention | `execFileSync` with argument arrays, no shell interpolation |
| Path traversal prevention | `path.resolve()` + prefix validation on all file access |
