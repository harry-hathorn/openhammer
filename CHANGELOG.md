# Changelog

All notable changes to OpenHammer are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
