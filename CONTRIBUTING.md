# Contributing to OpenHammer

Thanks for your interest in contributing! This guide covers the basics.

## Development Setup

Requirements:

- **Node.js ≥ 20**
- **npm** (a `package-lock.json` is committed; please use npm)

```bash
git clone https://github.com/harry-hathorn/openhammer.git
cd openhammer
npm ci
npm run build
```

## Useful Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Run the server with tsx watch |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the built server |
| `npm run lint` | Lint with Biome |
| `npm run format` | Auto-format with Biome |
| `npm run typecheck` | Type-check src + tests without emitting |
| `npm test` | Run the vitest unit/integration suite |

The Docker/tunnel suites (`npm run test:compose`, `test:tunnel`, etc.) are
heavier, gated flows — they are **not** required for routine contributions.

## Pull Request Workflow

1. **Fork** the repo and create a branch from `main`.
2. **Make your change**, keeping commits focused.
3. **Verify locally** — all of these must pass (CI enforces the same):
   ```bash
   npm run lint
   npm run typecheck
   npm run build
   npm test
   ```
4. **Open a pull request** against `main` and fill in the PR template.
5. **CI must be green** before merge. Address any review feedback.

## Style

- Formatting and linting are enforced by **Biome** (`npm run format`).
- Match the surrounding code's style, naming, and comment density.
- Prefer small, well-scoped commits with clear messages (Conventional Commits
  style is used here, e.g. `feat:`, `fix:`, `docs:`, `chore:`).

## Security

Found a security issue? Please report it **privately** — see
[SECURITY.md](./SECURITY.md). Do not open a public issue.

## Code of Conduct

Participation in this project is governed by the
[Code of Conduct](./CODE_OF_CONDUCT.md). Please be excellent to each other.
