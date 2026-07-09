# Changelog

All notable changes to OpenHammer are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.1] - 2026-07-09

### Fixed
- **Installed binary silently no-op'd on every command.** npm installs the `openhammer` bin as a symlink, so `process.argv[1]` was the symlink path while `import.meta.url` resolved to the real file — the entrypoint guard never matched, dispatch never ran, and `openhammer`, `openhammer doctor`, and `openhammer --help` all printed nothing and exited 0. The guard now resolves the symlink (`realpathSync`) before comparing; `npx openhammer@latest` and `npm install -g openhammer` run as intended.

## [1.1.0] - 2026-07-04

### Added
- **Dynamic Client Registration for the authorization-code flow (RFC 7591).** `/register` now reads the client's `token_endpoint_auth_method` and `grant_types` and mints a `client_secret` only for confidential (`client_secret_post`) clients; public clients (`none` — the MCP norm: Claude, Cursor) get a `client_id` and no secret. The operator never provisions a client id or secret — the client registers itself.
- **Operator login, in the dashboard.** The login that authorizes connecting MCP clients at `/authorize` can now be set from the **Clients & login** screen ("Set operator login…"), not just the `auth set-login` CLI. Its state shows in the screen header and the menu summary.
- **Deferred dynamic registration.** A dynamically-registered client is held in memory and persisted only when the operator's login succeeds — failed or abandoned registrations leave no "ghost" client in the registry.
- `@ngrok/ngrok` as a runtime dependency, so the `ngrok` channel needs no separately-installed binary — an authtoken is the only configuration.

### Changed
- The `ngrok` channel is now driven by the native `@ngrok/ngrok` SDK (an in-process agent) instead of the `ngrok` system CLI. The agent ships as an npm dependency with per-platform binaries (Linux x64/arm64/armhf, glibc and musl, plus macOS, Windows, FreeBSD, Android), so the operator no longer installs or pins a separate binary: `npx openhammer` brings it. The public URL comes straight from `forward()` — no spawned process, no `:4040` inspector polling, no stdout scraping. A connect timeout bounds the SDK's HTTP/2 control session so a blocked network degrades to localhost-only instead of hanging boot.
- **Authorization-code clients are public by default.** The interactive `add-client` wizard is machine (`client_credentials`) only; login (authorization-code) clients connect dynamically and authenticate against the operator login. The `--type authorization_code` flag remains as an escape hatch.
- **`/oauth/token` now requires + verifies a confidential client's secret** (omitting it is rejected, not bypassed); public clients authenticate with PKCE alone. `client_credentials` rejects public clients.
- The `/oauth/authorize` login page is restyled to match the marketing site (the "Durin-door" look): `--night`/`--ithil` palette, Bricolage / IBM Plex / JetBrains Mono, rune-mark header, glowing card.
- Adding, switching, or removing the default channel now restarts the owned server child so the new tunnel raises live — no manual quit-and-relaunch.

### Fixed
- **1.0.0 launch crash.** `npx openhammer@latest` failed with `ERR_MODULE_NOT_FOUND: Cannot find package '@earendil-works/pi-tui'`: the package was a devDependency but `dist/` imports it on the default CLI path. It is now a runtime `dependency`, and `release.yml` runs a clean-room `npm pack` → install → import smoke gate so a missing runtime dep blocks publish.
- A `/oauth/authorize` request that no login can authenticate now renders a clear "No login configured" notice instead of looping on "Invalid username or password".

## [1.0.1] - 2026-07-04

### Fixed
- Fixed a packaging bug that made the published 1.0.0 crash on launch with `ERR_MODULE_NOT_FOUND: @earendil-works/pi-tui`. The TUI runtime dependency was misclassified as dev-only, so it was omitted from the installed package; it is now declared as a runtime dependency. `npx openhammer@latest` now starts.

### Changed
- The npm publish job now runs a clean-room smoke test against the packed tarball (pack, install into an empty dir, then import the CLI entry, which pulls the full runtime dependency graph). A missing runtime dependency now blocks the release instead of shipping a broken artifact.

## [1.0.0] - 2026-07-03

First stable release. OpenHammer is a server that turns any computer into a secure, MCP-controlled
surface — run it on a laptop, or deploy it on a server (or a fleet) to give any authenticated MCP
client controlled filesystem and shell access over a single HTTP endpoint.

### Added
- Installable from npm: `npx openhammer@latest` or `npm install -g openhammer`.
- Single stateless `/mcp` endpoint speaking Streamable HTTP.
- Eight tools: `guide`, `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`.
- Three authentication paths at the `/mcp` gate, accepted in fall-through order: raw bearer token, OAuth client-credentials, and OAuth authorization-code + PKCE (with RFC 7591 `/register` dynamic registration, RFC 8414/9728 metadata).
- Channel providers for remote access: `ngrok`, `cloudflare` (cloudflared quick-tunnel), and `static` / `nginx`.
- TUI control center (dashboard): status, channels, clients & JWT, monitor, settings, doctor.
- Bounded output: per-tool truncation plus a universal `MAX_RESPONSE_BYTES` (512 KB) backstop that emits a structured `response_too_large` block.
- `MCP_ROOT_DIR` workspace scoping; `MCP_PUBLIC_URL` for OAuth discovery behind a tunnel.
- Live tool-call monitoring over a local-only Unix socket (`~/.openhammer/openhammer.sock`).
- Headless / server deployment via environment variables (zero dotfile state) or provisioned dotfiles (Docker / systemd / k8s).
- Project home page at <https://openhammer.dev>.

### Security
- Every connection authenticated; secrets stored mode `0600`; OAuth client secrets kept only as SHA-256 hashes.
- `bash` is not jailed — scope with `MCP_ROOT_DIR`, authenticate every connection, and run in a container for isolation.

[1.0.0]: https://github.com/harry-hathorn/openhammer/releases/tag/v1.0.0
