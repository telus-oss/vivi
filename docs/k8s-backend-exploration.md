# Kubernetes backend — exploration

Status: design exploration, no code yet. Branch: `explore/k8s-backend`.

## Goal

Let Vivi launch sandbox sessions against a Kubernetes cluster instead of a local
Docker/Podman daemon, and use that capability to run multiple users on one
shared cluster.

Two questions, answered separately:

1. **Can we plug k8s in as a backend?** Yes, with one new abstraction layer
   and a handful of changes to how Vivi currently shells out to `docker`.
2. **Can multiple users share one cluster?** Yes, by giving each user a
   namespace and either (a) running one Vivi control plane per user, or (b)
   making the existing single-tenant server multi-tenant. (a) is the smaller
   diff; (b) is the long-term answer.

## What currently ties Vivi to Docker

Vivi's container surface is concentrated in `server/container.ts`, plus a
handful of helpers that shell out to `docker`/`podman` directly. Every
docker call site (50+ found via grep, summarised below) is a candidate
replacement target.

| Concern | Where today | What it does |
|---|---|---|
| Runtime detection | `server/runtime.ts` | `docker --version` / `podman --version`, exports a `runtime.bin` |
| Session lifecycle | `server/container.ts` | `docker run -d` with bind mounts, env, network, labels |
| Proxy + DinD lifecycle | `server/container.ts` (`ensureProxy`) | `docker compose up -d proxy dind` |
| Bundle delivery | `server/container.ts` | bind-mount `STAGING_DIR/<id>` as `/staging:ro` |
| Workspace storage | `server/container.ts` | named volume `vivi-workspace-<id>` |
| Profile mount | `server/container.ts` | bind-mount profile dir to `/claude-profile:ro` |
| Proxy CA cert | `server/container.ts` | named volume `vivi_proxy-ca` |
| Internal network | `docker-compose.yml` | `sandbox` network with `internal: true` |
| `docker exec` PTY | `server/pty.ts` | `docker exec -it claude` (terminal stream) |
| Port forwarding | `server/ports.ts` | `docker exec ... socat` per TCP connection |
| Secret injection | `server/secrets.ts` | `docker exec -i cat > /etc/sandbox-secrets` |
| Profile save | `server/profiles.ts` | `docker exec tar cf -` piped to host |
| Per-session DinD ACL | `server/docker-namespace-proxy.ts` | Unix-socket HTTP proxy in front of dind, injects `vivi.session=<id>` label |
| DinD container listing | `server/docker-namespace-proxy.ts` | `docker -H tcp://...:2375 ps --filter label=` |
| DinD event stream | `server/docker-events.ts` | `docker events --format json` |
| PR bundle extract | `server/pr.ts` | `docker exec git bundle create` then `cat` |
| Live diff / file read | `server/index.ts` | `docker exec git diff`, `docker exec git show` |
| Image build | `server/container.ts` | `docker build -t vivi-sandbox` on first run |

The `runtime` module already abstracts Docker vs Podman, but only at the
syntactic level — every caller still composes a shell command and assumes
the local-daemon model. Adding k8s means replacing that shape, not just
adding a third `bin`.

## What Kubernetes maps to

Side-by-side of every concept Vivi uses today:

| Docker today | k8s equivalent | Notes |
|---|---|---|
| `docker run -d` | `Pod` (created via `CoreV1Api.createNamespacedPod`) | One Pod per session. No Deployment — sessions are pets, not cattle. |
| `--name vivi-sandbox-<id>` | `metadata.name: vivi-sandbox-<id>` | Same identifier. |
| `--network sandbox (internal)` | Default-deny `NetworkPolicy` + selective egress allow to proxy `Service` | Pod-level firewall is per-namespace; this is *better* than Docker's network isolation. |
| Named volume `vivi-workspace-<id>` | `PersistentVolumeClaim` per session | Storage class is cluster-dependent (local-path, EBS, Longhorn, etc.). |
| Bind-mount `/staging:ro` (git bundle) | `initContainer` that fetches the bundle from a `Secret`, S3, the API server, or a sidecar volume + emits it onto an `emptyDir` | Bind mounts are the *one thing* that doesn't translate cleanly — the cluster has no shared filesystem with the Vivi server. See "Bundle delivery" below. |
| Bind-mount `/claude-profile:ro` | `configMap` (small profiles) or `PVC` with `ReadOnlyMany` (large) | Profiles are user-specific so a per-user PVC is the natural fit. |
| Named volume `proxy-ca` | `Secret` mounted to `/proxy-ca` | CA cert is small and rotation-friendly as a Secret. |
| `-e KEY=value` | `env:` on the Pod spec, or `envFrom: secretRef:` | API key placeholders go in a `Secret` per session. |
| `docker exec` (PTY) | `CoreV1Api.connectGetNamespacedPodExec` over SPDY/WebSocket | Returns a duplex stream — drop-in for the Bun PTY bridge. |
| `docker exec ... socat` (port forward) | `CoreV1Api.connectGetNamespacedPodPortforward` | Built-in, no socat sidecar needed. Maps a local TCP listener to a Pod port. |
| `docker exec -i cat > file` (secret push) | `kubectl cp` equivalent via `connectPodExec` with `tar` | Same trick as today, just over the k8s exec API. |
| `docker logs --tail N` | `CoreV1Api.readNamespacedPodLog({follow:true, tailLines:N})` | Native streaming. |
| `docker events` | `Watch` on `Pod` resources in the namespace, filtered by labels | More efficient — informers do this server-side. |
| Compose `proxy` + `dind` services | `Deployment` (proxy) + `Service`, `StatefulSet` (DinD) + headless `Service` | One per user-namespace (see Multi-tenancy). |
| `docker build` | Out-of-band image build (CI), or in-cluster `Kaniko` / `BuildKit` Job | Vivi server itself shouldn't be building images in cluster mode — bake the sandbox image and reference it. |
| Per-session DinD ACL proxy | NetworkPolicy + per-namespace DinD, or per-Pod ephemeral DinD sidecar | k8s isolation is at the namespace level; the label-injection hack goes away. See "DinD on k8s" below. |

The good news is most of these are *cleaner* in k8s — port-forward, exec,
log streaming, and event watch are first-class APIs, not shell-command hacks.

## The hard part: bundle delivery

Today, Vivi creates `STAGING_DIR/<id>/repo.bundle` on the host filesystem
and bind-mounts it into the container. In k8s there's no shared host
filesystem (the cluster is somewhere else). Three viable options:

1. **`kubectl cp`-style upload before Pod starts.** Create the Pod with an
   empty `emptyDir` volume, wait for it to be `Pending`+`Init:0/1`, exec a
   `tar` extract into the init container. Pro: no extra infra. Con:
   awkward sequencing.
2. **S3-style object store + init container.** Server uploads the bundle
   to a small object store (MinIO sidecar, or the cluster's existing one);
   init container `curl`s it. Pro: clean, scales. Con: extra dependency.
3. **Bundle in a Secret/ConfigMap.** Base64 the bundle, mount it as a file,
   init container copies to workspace. Pro: zero extra infra, uses
   etcd ACLs. Con: etcd hard-limits values to 1 MiB — fine for tiny
   repos, breaks for anything substantial.

**Recommended: option 1 for v1** (init container + exec-tar), with option 2
as the fallback for large bundles. The `kubectl cp` pattern is well-known
and the only network hop is server → Kubernetes API server, which is
already a trust path Vivi needs anyway.

## The other hard part: DinD on Kubernetes

The current model relies on `docker:dind` running `--privileged` because
sandboxes can launch their own containers (dev servers, test databases).
Inside a k8s cluster, that's a hard sell — most clusters reject privileged
pods under `PodSecurity: restricted`. Four options, ranked by safety:

| Option | Isolation | Cluster prerequisite | Verdict |
|---|---|---|---|
| **Sysbox runtime (`io.kubernetes.cri.runtime-handler: sysbox`)** | Real (user-namespaced) | Cluster admin installs Sysbox CRI handler on nodes | Best. Designed for exactly this. Pod can run Docker without `--privileged`. |
| **Rootless Podman-in-Pod** | Real | None — works on stock kubelets | Good. Slower than Docker, but no special cluster config. |
| **Per-pod privileged DinD sidecar** | Pod-level only | Privileged pods must be allowed | Matches current behaviour. Acceptable on a private cluster; rejected by most managed ones. |
| **KubeVirt VM per session** | Hardware-level | KubeVirt installed | Heaviest. Overkill unless you're targeting hostile multi-tenancy. |

**Recommended:** detect at startup which is available and pick the safest
that works. Default config assumes rootless Podman (zero infra
requirement); a documented opt-in switches to Sysbox for users who
installed it. Privileged DinD stays as a `--insecure-dind` escape hatch.

Today's per-session DinD ACL proxy (`docker-namespace-proxy.ts`) goes
away entirely in k8s mode — namespace-level isolation makes the
label-injection trick redundant.

## Backend abstraction shape

The smallest viable change to the codebase is introducing a `Backend`
interface and turning `server/runtime.ts` into a backend selector.

```ts
// server/backend.ts (proposed)

export interface Backend {
  readonly name: "docker" | "podman" | "k8s";

  // Lifecycle
  ensureInfra(): Promise<void>;                       // proxy + DinD
  createSession(opts: CreateSessionOpts): Promise<SessionHandle>;
  destroySession(id: string): Promise<void>;

  // I/O into a running session
  exec(id: string, argv: string[], opts?: ExecOpts): Promise<ExecResult>;
  execPty(id: string, argv: string[], opts: PtyOpts): PtyHandle;
  readFile(id: string, path: string, maxBytes?: number): Promise<Buffer>;
  writeFile(id: string, path: string, data: Buffer): Promise<void>;

  // Streaming
  streamLogs(id: string, opts: LogOpts): NodeJS.ReadableStream;
  watchSessionContainers(id: string, cb: (snapshot) => void): () => void;
  portForward(id: string, port: number, hostBind?: string): PortHandle;
}
```

Existing implementations:

- `DockerBackend` (wraps current `runtime.bin = "docker"` paths)
- `PodmanBackend` (wraps current `runtime.bin = "podman"` paths)
- `KubernetesBackend` (new — uses `@kubernetes/client-node`)

`@kubernetes/client-node` covers everything we need: typed APIs for
Pod/Service/PVC, `Watch` for events, `Exec.exec()` returns a duplex
stream that bridges directly to the existing PTY plumbing, and
`PortForward.portForward()` returns a duplex stream that drops into
`server/ports.ts` in place of the socat-over-`docker exec` trick.

Backend choice is by env var: `VIVI_BACKEND=k8s` plus the standard
in-cluster config or `KUBECONFIG`. Falls back to today's behaviour
when unset.

## Multi-tenant model

Two layers, separable:

### Layer 1 — namespace per user (mandatory for k8s mode)

```
cluster
├── vivi-system            # control plane resources
│   ├── ServiceAccount: vivi-router (cluster-wide list-namespaces)
│   ├── Ingress: vivi.example.com -> per-user routing
│   └── Secret: oidc-config
├── vivi-user-alice        # one namespace per user
│   ├── ResourceQuota
│   ├── LimitRange
│   ├── NetworkPolicy: default-deny + allow-proxy-egress
│   ├── Deployment: vivi-server      (Alice's control plane)
│   ├── Deployment: proxy
│   ├── StatefulSet: dind (or sysbox-enabled)
│   ├── Pod: vivi-sandbox-abc        (Alice's session)
│   ├── PVC: vivi-workspace-abc
│   ├── PVC: vivi-data               (Alice's SQLite, profiles)
│   └── Secret: vivi-secrets         (Alice's API keys)
└── vivi-user-bob
    └── ...
```

Each user gets their own copy of the Vivi server. Inside the namespace
nothing changes — the server still thinks it's the only tenant, still
manages its SQLite DB, still creates one Pod per session. The
"multi-tenancy" is enforced by k8s primitives, not by Vivi:

- `Namespace` isolates the API surface.
- `ResourceQuota` caps CPU/memory/storage/Pod count per user.
- `LimitRange` sets default request/limit on every Pod.
- `NetworkPolicy` blocks pod-to-pod across namespaces (Alice's session
  cannot reach Bob's proxy).
- `RBAC`: per-user `ServiceAccount` with `Role` scoped to the user's
  namespace. Vivi's server uses this SA, so a compromised Vivi server
  cannot touch another user.
- `PodSecurity: restricted` admission profile prevents privileged
  escape (forbids hostPath, hostNetwork, runAsRoot, hostPID).

API key isolation is already strong because each user's MITM proxy
runs in their namespace with their own `Secret` — the same model Vivi
uses today, just replicated per tenant.

Routing: an ingress controller (Traefik, nginx-ingress) maps a
hostname or path to the user's Vivi `Service`. Auth is OIDC at the
ingress layer (oauth2-proxy in front, or native ingress OIDC). The
Vivi server itself stays single-user and ignores auth — the ingress
guarantees only the right user reaches it.

This is the **minimum diff multi-tenancy**. It's wasteful (one server
process per user) but operationally simple and inherits the existing
codebase unchanged.

### Layer 2 — one shared Vivi server (optional, future)

If wasting one Vivi process per user becomes a problem, the next step
is collapsing them into one shared Vivi control plane that knows about
users:

- Add `users` table to the DB (or move DB to Postgres).
- Add auth middleware that maps the request's OIDC subject → user_id.
- Every existing `sessions` / `secrets` / `profiles` / `port_forwards`
  query gains a `WHERE user_id = ?` clause.
- The k8s backend learns to look up the user's namespace from the
  `user_id` and creates resources there.
- Per-user `ServiceAccount` tokens issued by the Vivi server, scoped
  via Kubernetes `TokenRequest` API; Vivi acts as a credential broker.

This is a real refactor — every place that holds in-memory state per
session (`sessions` Map, `monitors` Map, `portForwards` Map, the
persistent Claude PTY map in `pty.ts`) needs a user dimension. Worth
doing *only* if Layer 1 hits resource pain.

## Security surface that changes

| Today | Under k8s |
|---|---|
| `--privileged` DinD on host | DinD via Sysbox (no `--privileged`) or rootless Podman |
| Docker socket bind-mount into sandbox | DOCKER_HOST env pointing at namespace-local Service |
| Per-session Docker socket proxy with label injection | Replaced by namespace-level NetworkPolicy + RBAC |
| Bundle on host filesystem, bind-mounted | Bundle uploaded to Pod's emptyDir via exec-tar |
| Single host, single trust boundary | Per-namespace trust boundaries enforced by kube-apiserver |
| Network allowlist enforced at MITM proxy | Same — proxy still does TLS interception |

Net: the security posture is *strictly stronger* in k8s mode, but the
attack surface shifts. The new things to worry about:

- A compromised Vivi server SA could enumerate/manage *its own
  namespace*. Make sure the Role is namespace-scoped, not cluster-wide.
- DinD sidecars still need careful PodSecurity — Sysbox is opt-in, so
  the default-allow `--insecure-dind` mode must be obviously dangerous.
- The MITM proxy CA private key lives in a k8s `Secret`, not a Docker
  volume. Encryption at rest (KMS-backed Secrets) becomes a real
  question, especially on managed clusters.

## Phased implementation plan

Each phase is independently shippable and reversible.

### Phase 1 — backend abstraction, no behaviour change
1. Introduce `server/backend.ts` with the interface above.
2. Refactor `server/container.ts`, `server/pty.ts`, `server/ports.ts`,
   `server/docker-namespace-proxy.ts`, `server/pr.ts`,
   `server/secrets.ts`, `server/profiles.ts`, `server/docker-events.ts`,
   `server/index.ts` to call the backend instead of `execSync(runtime.bin ...)`.
3. Provide `DockerBackend` and `PodmanBackend` that produce identical
   behaviour to today.
4. Tests pass unchanged. No new infrastructure.

### Phase 2 — k8s backend, single user
5. Add `KubernetesBackend` using `@kubernetes/client-node`.
6. Implement: `ensureInfra` (apply proxy Deployment + Service +
   NetworkPolicy + DinD StatefulSet from embedded YAML), `createSession`
   (Pod + PVC + initContainer + bundle upload via exec-tar),
   `exec`/`execPty`, `streamLogs`, `watchSessionContainers`,
   `portForward`, `destroySession`.
7. Ship a `vivi-sandbox` image to GHCR so cluster mode never needs
   `docker build`.
8. Add `VIVI_BACKEND=k8s` and a minimal `kustomize`/Helm chart for
   bootstrapping a single user's namespace.
9. Test against `k3d` / `kind` locally.

### Phase 3 — namespace-per-user multi-tenancy
10. Ship a Helm chart that takes a list of users and creates a
    namespace + Vivi Deployment + RBAC for each.
11. Document the OIDC ingress wiring (oauth2-proxy in front of
    `vivi-user-*.svc`).
12. Add a `VIVI_TENANT` env var so the Vivi server's UI/data display
    the right tenant name.

### Phase 4 — Sysbox/rootless-Podman selection
13. Detect cluster capability at server startup (probe for Sysbox
    runtime class).
14. Default to rootless Podman, opt-in Sysbox, gated `--insecure-dind`.

### Phase 5 (optional) — shared multi-tenant control plane
15. As described in "Layer 2" above. Only worth doing if Phase 3
    proves too expensive.

## Open questions

- **Bundle size.** What's the 99th-percentile repo size Vivi handles
  today? If it's < 100 MB, exec-tar upload is fine. If we routinely see
  multi-GB repos, we need an object-store path day one.
- **Persistent Claude PTY semantics across Vivi restarts.** Today the
  PTY is a Bun child process; if the Vivi server restarts, the PTY
  dies. In k8s mode the *sandbox Pod* survives a Vivi restart, but
  the PTY exec stream does not. Do we care? Reconnection logic might
  need to re-attach via a new `Exec.exec()` call instead of a fresh
  spawn — minor refactor.
- **Storage class assumptions.** PVC creation needs a default
  `StorageClass`. Document this; ship a config knob.
- **Cost model for shared clusters.** Even with quotas, a runaway
  sandbox can blow a per-user CPU/memory cap and crash-loop. Need
  reasonable defaults and a UI signal.
- **Image registry.** Custom sandbox images today (`sandbox-images.ts`)
  assume the local Docker daemon. In k8s mode they must live in a
  reachable registry. Either add a registry credential model or
  restrict cluster mode to images the cluster nodes can pull.

## Recommendation

Do Phase 1 first as a standalone refactor — it's a code-quality win
even if k8s never ships, because it forces every "shell out to
docker" call site into one typed surface that's easy to mock in tests.

After that, Phase 2 + Phase 3 together are the smallest path to a
real multi-user Vivi-on-k8s. Layer-2 shared multi-tenancy and
operator-mode (Phase 5) are good to design *for* but not necessary
to ship.
