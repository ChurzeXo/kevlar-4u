# Kevlar 上线前审计需求文档

> 目的：让本地 AI 对 Kevlar 当前重构后的代码库做上线前独立审计。审计输出应以风险、证据和修复建议为主，不做泛泛总结。

---

## 一、审计角色

你是 Kevlar 项目的上线前审计员。你的任务不是继续重构，而是审查当前实现是否符合新架构目标，找出会导致上线风险的问题。

审计时必须：

- 以代码事实为准，不以 README 或旧审计文档为唯一依据。
- 对每个问题给出文件路径、函数或关键行附近位置、风险等级、复现方式或推理依据。
- 区分“必须修复”“建议修复”“可接受残余风险”。
- 不要修改代码，除非另有明确要求。

---

## 二、项目背景

Kevlar 是一个本地优先的 MCP Server，用于内容压力测试和评审员人设管理。

本轮重构后的核心架构：

1. MCP Tools 是主流程入口。
2. 多轮流程由服务端状态机 wizard 维护，不依赖宿主 AI 记住完整提示词。
3. MCP Sampling 只用于字段提炼、推荐或多评审员执行；客户端不支持 Sampling 时必须可降级。
4. Prompts 仅作为旧客户端兼容和动态上下文提示，不应成为关键业务状态的唯一来源。
5. 高风险写操作必须先绑定目标或预览变更，再通过完整确认语执行。

---

## 三、重点审计范围

### 3.1 MCP Server 注册与协议边界

检查文件：

- `src/server.ts`
- `src/tools/index.ts`
- `src/index.ts`

检查项：

- 所有工具是否正确注册、导出、分发。
- `create_persona_wizard`、`review_content_wizard` 是否在支持 Sampling 的客户端中注入 `MultiTurnSamplingFunction`。
- `review_content` 是否只在 Sampling 支持时注入 `SamplingFunction`。
- `ListPromptsRequestSchema` 和 `GetPromptRequestSchema` 是否只作为兼容层，不误导宿主跳过工具状态机。
- `GetPromptRequestSchema` 返回的 create persona 动态提示是否与当前“最终确认一次”流程一致。
- 错误处理是否统一走 `formatErrorResponse`，是否有泄漏堆栈、API Key 或敏感路径的风险。

### 3.2 人设创建状态机

检查文件：

- `src/tools/createPersonaWizardTool.ts`
- `src/tools/createPersonaTool.ts`
- `src/__tests__/createPersonaWizard.test.ts`

检查项：

- 状态顺序是否为 `ageRange -> interests -> traits -> platform -> finalConfirm -> completed`。
- 中间字段是否记录后直接进入下一步，不再要求单字段确认。
- 最终确认阶段是否支持修改年龄段、兴趣方向、性格特质、平台，并在修改后重新展示最终确认。
- Sampling 提炼返回的 `assistantMessage` 是否不会重新引入“确认没问题吗”等中间确认话术。
- `sessionId` 校验、状态文件路径、草稿文件路径是否防目录穿越。
- 草稿不完整时 `create_persona` 是否阻断。
- 自动推断字段 `culturalContext`、`authorRelation`、`stance`、`blindSpot` 是否有稳定 fallback。
- 旧的 `SYSTEM_PROMPT` 和 `WIZARD_SYSTEM_PROMPT` 是否仍可能诱导宿主绕过 wizard 或每步确认。

### 3.3 内容评审状态机

检查文件：

- `src/tools/reviewContentWizardTool.ts`
- `src/tools/reviewTool.ts`
- `src/prompts/reviewDispatcherPrompt.ts`
- `src/__tests__/reviewContentWizard.test.ts`

检查项：

- 首次调用是否可靠暂存用户待评测内容。
- 人设数量为 0、1-2、3+ 时分支是否符合预期。
- Sampling 推荐失败时是否有可解释的启发式 fallback。
- 用户明确选择评审员 ID 或名称后，是否绑定选择并再次要求确认执行。
- 未确认时是否不会调用 `review_content`。
- `review_content` 输入长度、context 长度、persona 数量上限是否仍有效。
- 报告是否正确标注执行模式和部分失败。

### 3.4 删除、重置、配置写入向导

检查文件：

- `src/tools/deletePersonaWizardTool.ts`
- `src/tools/resetPersonasWizardTool.ts`
- `src/tools/configureWizardTool.ts`
- `src/tools/deletePersonaTool.ts`
- `src/tools/resetPersonasTool.ts`
- `src/tools/configureTool.ts`
- 对应 `src/__tests__/*.test.ts`

检查项：

- 删除人设是否先明确匹配唯一目标，再绑定到 session 状态。
- 删除确认语是否包含目标人设名，用户只回复“确认”是否不会删除。
- 删除路径是否限制在 `skills/` 内。
- 恢复默认人设是否不会删除自定义人设。
- 配置写入是否先预览，只有 `确认修改配置` 后才写入。
- 配置可修改范围是否只包括允许字段，不接受 API Key 或任意文件路径。
- 向导完成后是否清理状态文件。

### 3.5 执行层与降级逻辑

检查文件：

- `src/execution/index.ts`
- `src/execution/base.ts`
- `src/execution/client.ts`
- `src/execution/config.ts`
- `src/execution/limiter.ts`
- `src/execution/lock.ts`
- `src/execution/aggregator.ts`
- `src/execution/modes/*.ts`
- `src/__tests__/execution.test.ts`

检查项：

- `auto` 模式解析顺序是否与 README 一致：持久配置 -> 环境变量 -> 可用模式优先级。
- `mcp_sampling` 不可用时是否不会假装成功。
- `direct_api` 是否只从环境变量读取 API Key。
- API Key 是否脱敏，是否可能写入日志或错误响应。
- 非 `orchestration` 模式是否正确加锁并最终释放。
- 限流、重试、部分失败聚合是否不会吞掉所有错误。
- Token 预算检查是否在外部模型调用前发生。
- 自定义人设字段校验是否覆盖常用平台、性格特质、盲区。

### 3.6 Persona 文件与解析

检查文件：

- `skills/*.md`
- `skills/_template.md`
- `src/utils/parser.ts`
- `src/__tests__/parser.test.ts`

检查项：

- 内置人设 frontmatter 是否完整、ID 是否唯一。
- `parsePersonaFile` 是否能兼容当前 README 推荐格式。
- 解析失败的 persona 是否不会导致整个服务崩溃。
- 自定义人设与内置人设校验规则是否合理区分。
- 写入文件名是否防路径穿越、重名覆盖是否按预期处理。

### 3.7 测试与文档一致性

检查文件：

- `README.md`
- `docs/SPEC-execution-modes.md`
- `docs/PRE_RELEASE_AUDIT_REQUEST.md`
- `src/__tests__/**/*.test.ts`
- `package.json`

检查项：

- README 是否与当前工具名、流程、执行模式一致。
- 旧审计文档中是否有明显过时结论会误导上线判断。
- 是否有缺失测试：最终确认修改字段、Sampling 失败 fallback、确认语不足时不执行危险操作、模式降级。
- `npm run build` 和 `npm test` 是否通过。

---

## 四、必须执行的命令

在审计开始前执行：

```bash
git status --short
npm run build
npm test
```

如果命令失败，不要继续给“可上线”结论。先记录失败命令、关键报错和初步定位。

可选辅助命令：

```bash
rg "Confirm|确认|SYSTEM_PROMPT|orchestration|samplingFn|sessionId|validateWritePath" src docs README.md
rg "TODO|FIXME|console.log|process.env" src
```

---

## 五、风险等级

使用以下等级：

- `P0 Blocker`：会导致数据丢失、越权删除、API Key 泄漏、服务无法启动、核心流程无法完成。
- `P1 High`：会导致主要流程错误执行、错误降级、危险操作确认不足、评审结果明显不可信。
- `P2 Medium`：边界条件错误、提示词与工具不一致、测试缺失但风险可控。
- `P3 Low`：文档措辞、可维护性、日志可读性、非阻塞体验问题。

---

## 六、输出格式

请按以下格式输出审计报告：

```markdown
# Kevlar 上线前审计报告

## 结论

- 上线建议：可上线 / 暂缓上线
- 阻塞项数量：
- 高风险项数量：
- 已执行命令：

## P0 Blocker

### 1. 标题

- 文件：
- 位置：
- 现象：
- 风险：
- 复现或证据：
- 修复建议：

## P1 High

同上。

## P2 Medium

同上。

## P3 Low

同上。

## 测试缺口

- 缺口：
- 建议新增测试：

## 文档不一致

- 文件：
- 不一致内容：
- 建议修正：

## 残余风险

- 风险：
- 当前接受理由：
```

---

## 七、上线门槛

只有满足以下条件，才允许给出“可上线”结论：

- `npm run build` 通过。
- `npm test` 通过。
- 没有 P0。
- 没有未解释的 P1。
- 所有危险写操作都有明确确认防线。
- README 与当前架构无明显冲突。
- API Key 不会被写入配置、日志或工具响应。
