# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [1.6.19] - 2026-07-08

### Fixed

- **Pre-audit aggregation: receipt `level` authoritative over computed level**. Before this fix, `getFindingsLevel` was used in 4 critical pipeline points (`mergeLocalFindingsIntoAudits`, `deduplicateDimensionFindings`, `crossValidateRiskyDimensions`) — directly computing risk level from findings while ignoring the Host AI's explicit `level` declaration on the receipt. When Host AI flagged 🔴 on a structural concern but `findings` was empty, the pipeline silently downgraded to 🟢. All 4 points now use `resolveDimensionLevel`, which takes `max(receipt level, findings-based level)`.
- **Receipt templates**: Added authoritative guidance clarifying that `dimensions[].level` is treated as authoritative judgment (backend takes max with findings-based level). Host AI now has clear instructions when filling receipts.
- **Session TTL**: Expired-session message corrected from "10 分钟无活动" to "30 分钟无活动" to match the actual TTL value.

### Added

- **TTL tests**: Session expiration and continuation timeout rollback are now covered by unit tests in `reviewContentWizard.test.ts`.
- **Defensive test coverage**: `deduplicateDimensionFindings` now tested for receipt-level preservation; `crossValidateRiskyDimensions` tested for post-validation level integrity; `normalizePreAuditDimensions` tested for the exact bug scenario (receipt 🔴 + empty findings).

---

## [1.5.0] - 2026-06-21

### Added

- **Pro Code Extraction**: All proprietary Pro code (`credential/`, `strategyBundle`, `bundleStrategyProvider`, `credentialCli`) moved to private Git submodule at `src/pro/` (ChurzeXo/kevlar-pro-runtime). Public CI/CD never sees Pro source.
- **Dynamic Pro Loading**: `DynamicImportProRuntimeLoader` attempts `import("@kevlar/pro-runtime")` at runtime. Pro installed → enhanced audit pipeline (11 steps). Not installed → auto-degrade to Free mode (transparent to users).
- **`npm run commit:pro`**: One-click script that commits Pro submodule changes AND updates the parent repo pointer — no manual Git submodule gymnastics.
- **Pro CI Workflow** (`.github/workflows/pro-ci.yml`): Triggers on submodule pointer changes. Requires SSH deploy key for private repo access. Runs Pro's 35 tests and verifies no Pro code leaked into `dist/`.
- **Pre-publish Leak Check**: CI step that verifies `dist/pro/` and `dist/credential/` directories don't exist before releasing. Double-protection with `.npmignore` and `files` whitelist.
- **OpenCode Commands**: 6 custom commands (`/commit`, `/commit-pro`, `/deploy-free`, `/deploy-pro`, `/deploy-all`, `/new-release`) for AI-assisted deployment workflows.
- **`KEVLAR_SKIP_PRO_IMPORT`**: Env var (`= "1"`) to disable Pro runtime loading for tests and CI.

### Changed

- **Free/Pro Code Separation**: All Pro imports now use bare `@kevlar/pro-runtime` specifiers. Free code self-references via `kevlar-4u/*` subpath exports.
- **TypeScript Config**: `tsconfig.json` paths map `@kevlar/pro-runtime` → `./src/pro/src` and `kevlar-4u/*` → `./src/*` for zero-config dev. `tsconfig.src.json` excludes `src/pro/`.
- **AGENTS.md Refactored**: Split into Free/Pro sections with architecture diagrams, environment variables, and deploy checklist for AI agents.
- **docs/ Cleanup**: 30 obsolete files archived to `.学习/归档/` (local only, gitignored). 7 core docs retained (DEPLOY.md, preaudit-pipeline.md, PRD, i18n READMEs, ADR).
- **Packaging Safety**: `files` whitelist refined to specific files only. `.npmignore` excludes Pro bundle cache (`skills/strategy-bundle-cache.enc`), Pro rules (`rules_pro/sensitive/lowbrow.json`), and session temp files.
- **README.md**: Added Free/Pro tier comparison table, Pro activation section, architecture diagram with Pro subgraph, tier-annotated features.

### Fixed

- **Backend v1 API Alignment**: `verifyBundleIntegrity` uses `canonicalJSONDeep` (recursive sort) with original `strategyHash` for HMAC verification — matching production server behavior at `kevlar4u.xyz`.
- **Credential Check**: `isPro()` credential store check made dynamic (lazy import), preventing `src/pro/` dependency when Pro is absent.
- **E2E Test Isolation**: Tests use temp `skills/` dirs and `KEVLAR_SKIP_PRO_IMPORT` to prevent real Pro credentials from interfering.

### Removed

- **`src/credential/`**: Extracted to private submodule.
- **`src/execution/strategyBundle.ts`, `bundleStrategyProvider.ts`**: Extracted to private submodule.
- **`scripts/credentialCli.ts`**: Extracted to private submodule.
- **`src/pro/` direct files**: Replaced by Git submodule.

---

## [1.4.0] - 2026-06-18

### Added

- **Precedents (Similar Incident Lookup)**: Pre-audit pipeline now searches for real-world similar incidents and injects them as reviewer context to strengthen risk detection
- **Cross-lingual Distortion Auditor**: New 6th system auditor (`cross_lingual_distortion`) detects malicious mistranslation, Chinglish puns, and cultural misfit risks across languages
- **MECP Compliance Optimizations (P1-P3)**: Circuit breaker for LLM calls, structured JSON parser with fallback, request sanitization, distributed tracing with traceId/spanId, and automatic rollback on failure
- **Auto-install Mode**: `--auto` flag enables silent, non-interactive installation designed for AI-invoked setup (`npx -y kevlar-4u --auto`)
- **ESC to Cancel**: Press ESC during the interactive installer to cancel at any time
- **Tier/Subscription Decoupling**: SaaS-fetched `PromptSegments` and unified `isPro()` logic for future cloud features
- **Web Search Integration**: Step 0b+ now uses host AI's own web search tool for blacklist atom verification instead of DuckDuckGo dependency

### Changed

- **Three-tier Instruction Decoupling**: Separated `SERVER_INSTRUCTIONS`, `TOOL_DESCRIPTION`, and dynamic prompt composition into independent layers for cleaner maintenance
- **Two-stage Orchestration Pipeline**: Turn 1 performs global decode (black atom extraction + emotional reframing), Turn 2 performs per-dimension system audit — replacing single-pass scanning
- **DuckDuckGo Removed**: Web search responsibility shifted to host AI in orchestration mode, eliminating external dependency
- **CLI MCP Entry Path Fix**: Local installation now points to compiled `dist/scripts/cli.js` instead of TypeScript source, ensuring AI clients can spawn the MCP server correctly
- **tsconfig Restructured**: Project references (`tsconfig.src.json` + `tsconfig.scripts.json`) resolve `rootDir` conflict between `src/` and `scripts/`
- **Auditor Prompt Hardening**: System auditor prompts refined with adversarial "black-fan" perspective and compact chain-of-thought per dimension
- **Review Wizard UI**: Cleaner persona selection with numbered listing and compact CoT rendering

### Fixed

- **MCP Entry Path for Local Runs**: `npm run kevlar-4u` now generates correct `node dist/scripts/cli.js` entries instead of pointing at `.ts` source files that Node.js cannot execute
- **MECP Audit 5 Fixes**: Circuit breaker reset, JSON parser edge cases, input sanitization, trace context propagation, and rollback on partial failure
- **Precedents Rendering**: Similar incidents now render in both orchestration and direct API output paths
- **Delta Risks**: `buildEmptyDeltaRisks` function restored and applied across all review paths

---

## [1.3.0] - 2026-05-30

### Changed

- **License changed from MIT to AGPLv3**
  - Core local features remain open-source under AGPLv3
  - Cloud-based risk word cloud services, paid rule synchronization, and advanced features are proprietary commercial services
- **Documentation restructured**
  - Added License section to all README files (English, Chinese, Japanese, Korean)
  - Moved multi-language READMEs from root to `docs/` directory
  - Updated `package.json` license field to `AGPL-3.0-or-later`
  - Disabled npmjs language switcher (only English README in root)

---

## [1.2.0] - 2026-05-27

### Added

- **评测后更换评审员**：一轮评测完成后，新增 `postReview` 步骤，询问用户是否需要更换评审员再次评测。
  - 确认更换 → 回到选人步骤，列出全部评审员供重新选择
  - 不需要 → 清理会话状态，结束评测流程
- **会话超时自动清理**：会话超过 10 分钟未活动，自动清理旧状态文件并用原始待评测文案重建新会话，防止状态文件堆积。

### Changed

- **工具描述文案优化**：精简 `list_personas`、`create_persona_wizard`、`review_content_wizard` 三个核心工具的 `description` 和参数描述，使用箭头符号和列表结构让 AI 更容易理解分支行为。
  - `list_personas`：参数行为分为「不传 → 概览」「传平台名 → 列表」「传全部 → 全部列出」三条，清晰直观
  - `create_persona_wizard`：`userMessage` 描述从「后续步骤传入用户对工具提问的回复」简化为「后续调用传入用户对上一步提问的答复」
  - `review_content_wizard`：推荐器 systemPrompt 精简，评审员选择交互改为编号制
- **评审员选择交互优化**：确认阶段评审员列表改为编号展示（`1. 名称 · 描述`），提示改为「请回复对应编号选择评审员」
- **无匹配平台提示优化**：指定平台无评审员时，提示改为「回复编号 → 查看详情 / 回复编号+文案 → 直接评审」两步指引
- **移除「通用」平台支持**：从 `PLATFORM_TO_EN` 映射中移除，平台列表示例不再包含「通用」

---

## [1.1.0] - 2025-05-25

### Added

- **评审员立场多选**：创建评审员时，新增「立场」步骤，提供 10 个预设立场选项供用户多选，让评论视角更锋利、更刁钻。
  - 支持数字编号输入（如 `1,3,5`）和关键词匹配（如 `理性分析视角`）
  - 选择「自定义」后，AI 会追问并让用户描述评审员的立场视角
  - 多个立场以「同时具备」语义叠加，在评审中综合体现
  - 10 个预设立场选项：
    1. 关注传统文化表达、本土品牌与文化认同感的用户视角
    2. 关注职场沟通体验、表达方式与实际使用场景的职场用户视角
    3. 关注措辞细节、情绪表达与社会议题感受的都市女性视角
    4. 关注逻辑结构、信息准确度与技术细节的理性分析视角
    5. 容易受到公共讨论氛围与评论区情绪影响的大众用户视角
    6. 强调个体表达、价值一致性与真实感受的独立思考视角
    7. 关注商业表达、营销语言与消费真实性的商业观察视角
    8. 关注家庭观念、代际关系与传统价值表达的传统文化视角
    9. 熟悉垂直社区文化、关注圈层表达习惯与社区氛围的核心玩家视角
    10. 自定义

### Changed

- 立场字段从 AI 自动推断改为用户显式选择，评审员立场不再由 AI 猜测，而是由用户精确定义
- `create_persona_wizard` 流程新增第 7 步「立场选择」（原第 7 步「最终确认」顺延为第 8 步）
