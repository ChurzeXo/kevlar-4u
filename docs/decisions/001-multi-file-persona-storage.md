# ADR 001: Multi-file Persona Storage

**Date**: 2026-05-28  
**Status**: Accepted  

## Context

The original plan (`Kevlar-4u_需求文档_v1.0.md` §2.3.2) specified a single `skills/personas.json` file. During Phase 1 implementation we identified a better decomposition: separating system auditors from user-created reviewer personas by platform.

## Decision

Split into multiple files by role and platform:

- `skills/auditors.json` — 5 system auditors (defensive pre-screening), tagged `"system_auditor"`
- `skills/xiaohongshu.json`, `skills/zhihu.json`, `skills/wechat_official.json` — user-created personas grouped by target platform
- `skills/fallback.json` — catch-all for unknown/unrecognised platform tags

## Consequences

- **Positive**: Each file is smaller and independently readable; platform-specific tooling (create-persona wizard) directly opens the right file without scanning/tag-filtering
- **Positive**: Git diffs are scoped to a single platform file when adding/removing a persona
- **Positive**: Adding a new platform requires only adding its JSON to `skills/` — `discoverPersonaFiles()` auto-detects it via content sniffing
- **Trade-off**: Deletion requires scanning all persona files (handled by `deletePersonaFromJson`). For 11 personas across 4 files this is negligible.
- **Trade-off**: The single-file spec in the requirements document is outdated. This ADR supersedes §2.3.2 of the requirements doc.
