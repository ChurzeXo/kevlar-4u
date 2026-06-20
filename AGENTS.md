# Kevlar-4u — Agent Instructions

## What this is

An MCP stdio server that stress-tests content by simulating reader reactions through configurable "personas." The entrypoint is `src/index.ts` → `src/server.ts` (tool registration, DI). All tools are built from `src/tools/index.ts` modules.

This repo contains both **Free** (open source, AGPL-3.0) and **Pro** (proprietary, subscription-required) code. Pro code is gated at runtime and inert without a valid license.

## Quick commands

| Command | Tier | What |
|---|---|---|
| `npm run dev` | Free | Run server via `tsx src/index.ts` (no build) |
| `npm run kevlar-4u` | Free | Interactive install CLI via `tsx` (no build) |
| `npm run auto-install` | Free | Silent auto-install via `tsx` (no build) |
| `npm run build` | Free | Full build: `src/` + `scripts/` → `dist/` |
| `npm run build:scripts` | Free | Quick: build only `scripts/` → `dist/scripts/` |
| `npm start` | Free | Run compiled `dist/index.js` |
| `npm test` | Free | `tsx --test src/__tests__/*.test.ts` |
| `npm run test:watch` | Free | `tsx --test --watch src/__tests__/*.test.ts` |
| `npm run setup` | Free | Zero-config auto-setup (Claude only) |
| `npx .` | Free | Run compiled bin (simulates published package) |
| `npx . --sync` | Pro | Sync strategy bundle from server |
| `npx . --status` | Pro | Show Free/Pro status |
| `npx . --doctor` | Pro | Run diagnostics |
| `npx . --activate --code <code>` | Pro | Activate Pro license |
| `npx . --auto` | Free | Run compiled bin in silent mode |

**Single test file**: `npx tsx --test src/__tests__/<name>.test.ts`

## Development workflow

All local testing uses `tsx` directly — no build needed:

1. Edit code (`src/` or `scripts/`)
2. Test with the `npm run dev` / `npm run kevlar-4u` / `npm run auto-install` commands
3. Pass tests with `npm test`
4. Final verification: `npm run build:scripts` (or `npm run build` for full build), then restart your AI client

> `npm run build:scripts` recompiles `scripts/cli.ts` → `dist/scripts/cli.js` in <1s.
> Run this when you want to test the actual compiled bin (via `npx .`) or rebuild after a code change so installed clients pick up the new version.

## Testing

- Uses Node.js built-in `node:test` + `node:assert/strict`. No Jest/Vitest.
- Every test creates a temp dir (`fs.mkdtempSync`) and cleans up in `afterEach`.
- Tests requiring `KEVLAR_SKILLS_DIR` must set it to a temp dir before importing modules (see existing tests for pattern).
- E2E tests use `InMemoryTransport` from `@modelcontextprotocol/sdk` — no server binary required.

---

# Free — Open Source

## Free Architecture

- **Execution modes** (`src/execution/index.ts`): `orchestration` (priority 30, always available), `direct_api` (20), `mcp_sampling` (10). Auto-resolved: config → `KEVLAR_MODE` env → capability detection.
- **Non-orchestration modes** use a review lock with 5min TTL (`src/execution/lock.ts`) to prevent concurrent runs. Orchestration is exempt.
- **Two-stage pipeline**: System pre-audit (9-step pipeline) → RST review (user personas with Focus Topic transformation).
- **State machine wizards** (`src/tools/`): `review_content_wizard`, `create_persona_wizard`, `configure_wizard`, `delete_persona_wizard`. All persist state to `skills/tmp/`. Stale drafts (>24h) are cleaned on server startup.

### Pre-audit pipeline (9 steps)

The pre-audit is orchestrated from `src/tools/reviewContentWizardTool.ts`. Detailed reference: `docs/preaudit-pipeline.md`.

| Step | Executor | What |
|------|----------|------|
| 0a | Code | Local rule engine — `buildLocalRuleFindings()`: n-gram sliding window, L2 structural patterns, multi-hop matching against `skills/rules_free.json` |
| 0b+搜索 | Host AI | `src/prompts/reviewWizard.ts` `buildOrchestrationStep0Prompt()`: ① language boundary detection + wild translation extraction ② black atom extraction ③ emotional reframing ④ web search (host AI's own tool on blackAtoms). Outputs `step0Result` + `webContextMap`. |
| 1 | Code | Decontextualization — `src/utils/stripContext.ts` `stripContext()`: splits into original/bare/replacements |
| 2 | LLM | Bare-text audit — 3 dimensions: `context_distortion`, `network_culture_risk`, `cross_lingual_distortion` (injects `webContextMap`) |
| 3 | LLM | Full-text audit — **6 system auditors** (see below, injects `webContextMap`) |
| 4 | Code | Delta analysis — inline in `executeLlmSystemAudit()`: bareOnly / fullOnly / stable risks |
| 5 | Code | Merge — `mergeLocalFindingsIntoAudits()`: local rule findings → `network_culture_risk` dimension |
| 6 | LLM | Cross-validation — `crossValidateRiskyDimensions()`: 6 directed/bidirectional checks between dimensions |
| 7 | Code | Synergy weighting — `src/execution/synergyCalculator.ts` `calculateSynergy()`: cross-dimension escalation (🟡→🔴) |
| 8 | LLM | Final arbitration — `finalizePreAuditReport()`: deduplicate, chain amplification, supply `worstCaseNarrative`, apply `levelUpgrades` |
| 9 | Code | Display results to user |

### System auditors (6 defensive dimensions)

Defined in `src/execution/dimensions.ts` and stored in `skills/auditors.json`:

| ID | Role |
|---|---|
| `legal_compliance` | 合规哨兵 — ad law, false claims, political red lines |
| `social_risk` | 社伦判官 — discrimination, stereotyping, backfire effect |
| `context_distortion` | 语境猎手 — out-of-context screenshot vulnerability |
| `network_culture_risk` | 暗语破译 — slang collisions, hidden vulgar meanings |
| `factual_integrity` | 事实判官 — factual errors, logical fallacies |
| `cross_lingual_distortion` | 跨界判官 — malicious mistranslation, Chinglish puns, cultural misfit |

## Persona storage

Multi-file JSON in `skills/`:
- `auditors.json` — 6 system auditors (tagged `system_auditor`)
- Platform files (`xiaohongshu.json`, `zhihu.json`, `wechat_official.json`) — user personas by platform
- `fallback.json` (auto-created) — catch-all for unrecognized platform tags

New files are auto-discovered via content sniffing (presence of a `personas` key). Do NOT hardcode file lists.

## Free conventions

- **Confirm before executing**: Any modification (file writes, deletes, config changes, etc.) must be proposed to and approved by the user before execution. Never act unilaterally.
- **All mutation goes through wizards**: No tool directly writes/deletes without `_wizard` confirmation. The `delete_persona` tool exists but requires `confirm: true` and should be used only when the caller explicitly asks for direct mode.
- **API keys never written to config files**: Only env vars (`KEVLAR_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`). Config in `skills/kevlar-config.json` is for preferences only.
- **sessionId** must match `[a-z0-9-]+` only.
- **Persona files** are written to `skills/` — path validation enforces this. No files outside `skills/` may be written.
- **Rule files**: `rules_free.json` (shipped, active), `rules_pro.json`/`rules_sensitive.json`/`rules_lowbrow.json` (backend in development / placeholder). `rules_free.json` covers the active rule set.
- **i18n**: `src/i18n/` powers bilingual output (zh-CN / en-US). The `set_language` MCP tool switches at runtime.

## Free environment variables

| Variable | Purpose |
|---|---|
| `KEVLAR_MODE` | `auto`, `orchestration`, `mcp_sampling`, `direct_api` |
| `KEVLAR_MAX_CONCURRENT` | Max concurrent reviewers (1-10) |
| `KEVLAR_API_KEY` | Preferred direct API key |
| `ANTHROPIC_API_KEY` | Anthropic fallback API key |
| `OPENAI_API_KEY` | OpenAI fallback API key |
| `KEVLAR_SKILLS_DIR` | Override default `skills/` path |
| `LOG_LEVEL` | `debug`, `info`, `warn`, `error` |

---

# Pro — Subscription-Only

Pro code lives in `src/pro/` (credential, strategy bundle, sync, CLI). These files are part of the open-source repo but are inert without a valid license from `kevlar4u.xyz`.

The plan is to extract `src/pro/` into a private `@kevlar/pro-runtime` npm package. Free code dynamically imports Pro via `src/execution/proRuntime.ts` `DynamicImportProRuntimeLoader` which calls `await import("@kevlar/pro-runtime")`.

## Pro architecture

- **Entry point**: `src/pro/index.ts` — barrel exports + `createProStrategyProvider()` (called by Free's `DynamicImportProRuntimeLoader`).
- **Strategy bundle**: Server-signed JSON (prompts, pro rule sets, config) downloaded via `npx . --sync`. Bundle integrity verified by:
  - **Primary**: HMAC-SHA256 with server secret, using `canonicalJSONDeep` (recursive sort) and original `strategyHash`.
  - **Fallback**: Ed25519 with embedded public key, trying 4 combinations (array-replacer/deep-canonical × original/zeroed strategyHash).
- **Credential storage**: AES-256-GCM (PBKDF2, 100k iterations) via `src/pro/credential/index.ts`. Old XOR format auto-detected on read for backward compat.
- **Sync flow**: Download → verify HMAC/Ed25519 → check revocation list → cache with AES-256-GCM.
- **Tier resolution**: `src/subscription/tier.ts` resolves Free vs Pro via `isPro()` — env vars, config, and dynamic credential check.
- **Prompt fidelity**: Pro tier unlocks full server-side prompt instructions (SaaS commands); Free tier emits locked/placeholder prompt segments.

## Directory structure (`src/pro/`)

```
src/pro/
├── index.ts                   # Barrel + createProStrategyProvider()
├── strategyBundle.ts          # Bundle format, HMAC/Ed25519 verification
├── bundleStrategyProvider.ts  # Bundle → StrategyProvider adapter
├── credentialCli.ts           # CLI: activate, status, logout, sync, doctor
└── credential/
    ├── index.ts               # AES-256-GCM obfuscate/deobfuscate
    ├── store.ts               # FileCredentialStore
    ├── activate.ts            # activateWithCode
    ├── activationClient.ts    # ActivationClient (HTTP)
    ├── bundleCache.ts         # Bundle cache read/write/status
    └── syncClient.ts          # syncStrategyBundle
```

## Pro conventions

- **Do not expose or log signing keys**: `KEVLAR_SIGNING_KEY` is for server-side use only.
- **Activation codes are single-use with 10-30min expiry**: Must obtain fresh code per `activate` call.
- **All Pro tests must mock the backend**: No test should call `kevlar4u.xyz` directly. Use `hmacSignBundle` helper for bundle tests.

## Pro environment variables

| Variable | Purpose |
|---|---|
| `KEVLAR_SIGNING_KEY` | Ed25519 private key PEM for server-side bundle signing |
| `KEVLAR_BUNDLE_SIGNING_SECRET` | HMAC-SHA256 secret for dev bundle signing |

---

# Release

- Tags trigger `v*.*.*` → `.github/workflows/release.yml`: builds, packages tarball/zip, creates GitHub Release, publishes to npm.
- `npm run prepublishOnly` blocks direct publish outside CI.
- CHANGELOG.md entries are extracted automatically for release notes.
