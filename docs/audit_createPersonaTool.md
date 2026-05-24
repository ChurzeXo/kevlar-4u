# 审计任务：createPersonaTool.ts 模块评估与临时记忆功能建议

## 背景说明

`createPersonaTool.ts` 是一个 MCP Tool 模块，负责创建评审员人设（Persona）并将其持久化为 `.md` 文件。

近期对该模块的 `system_prompt` 字段进行了重大更新：

1. **新增阶段式对话流程**：AI 不再一次性接收所有输入，而是逐步引导用户完成四个字段的收集（年龄段 → 兴趣方向 → 性格特质 → 分发渠道）
2. **新增标签提炼机制**：用户自由描述后，AI 负责将内容结构化为标签
3. **新增用户逐步确认机制**：每个字段确认后才进入下一步
4. **新增中途修改机制**：允许用户回退修改已确认字段
5. **新增模型自动推断项**：文化背景、与作者的关系、立场、盲区由模型根据已收集信息自动推断
6. **新增临时记忆文档机制**：每步确认后写入临时记忆，最终创建完成后删除

---

## 审计任务一：现有代码与新版系统提示词的兼容性评估

### 1-A. `system_prompt` 字段的定位是否正确？

**现状**：`system_prompt` 被定义为 `inputSchema` 中的一个输入字段，意味着调用方需要将完整的系统提示词作为参数传入。

**审计问题**：

- 新版 `system_prompt` 已经是一段固定的角色构建引擎指令，不应该由调用方传入，而应该是模块内部的常量。
- 请判断：是否需要将 `system_prompt` 从 `inputSchema` 的 `properties` 中移除，改为模块内部的 `const SYSTEM_PROMPT` 常量？
- 如果保留在 `inputSchema` 中，调用方传入的值会覆盖还是忽略内部逻辑？

**结论**：必须将 `system_prompt` 从 `inputSchema` 中移除，改为模块内部 `const SYSTEM_PROMPT` 常量。保留在 `inputSchema` 中的风险是调用方传入的值会直接覆盖内部逻辑，行为不可预测。

---

### 1-B. `required` 字段是否需要更新？

**现状**：`required: ["id", "name", "system_prompt", "description"]`

**审计问题**：

- 新版流程中，`id` 和 `description` 是由 AI 在收集完用户信息后自动生成的，还是仍需调用方传入？
- 如果 `id` 改为由模块根据 `name` 自动生成（例如 pinyin slug），是否需要从 `required` 中移除？
- `description` 是否可以由模型自动从性格特质中提炼一句话，而不需要调用方显式传入？

**结论**：

- `id` 应由模块根据 `name` 自动生成（pinyin slug 或 uuid），从 `required` 移除
- `description` 由模型从性格特质自动提炼一句话，从 `required` 移除
- `system_prompt` 已改为内部常量，从 `required` 移除
- 最终 `required` 只保留 `["name"]`，其余全部内部生成或推断

---

### 1-C. `handleCreatePersona` 函数是否需要拆分？

**现状**：`handleCreatePersona` 是一个单一函数，负责校验 + 写入文件。

**审计问题**：

- 新版流程引入了多轮对话和临时记忆，`handleCreatePersona` 只处理最终写入步骤，还是需要处理中间状态？
- 请判断是否需要将函数拆分为：
  - `handleCollectPersonaInput`：负责阶段式收集和临时记忆写入
  - `handleCreatePersona`：负责读取临时记忆并最终写入人设文件

**结论**：需要拆分，但函数命名需调整。MCP Tool 本身是无状态的单次调用，`handleCollectPersonaInput` 暗示它处理多轮对话状态，命名有误导性。更准确的拆分为：

- `handleSaveDraft`：保存单步用户确认的临时记忆（由 `update_persona_draft` Tool 触发）
- `handleCreatePersona`：读取临时记忆 + 执行推断 + 最终写入人设文件

---

### 1-D. `writePersonaFile` 工具函数是否需要修改？

**现状**：`writePersonaFile(skillsDir, meta, input.system_prompt)` 直接写入完整的 system_prompt。

**审计问题**：

- 新版中 system_prompt 是固定的引擎指令，而角色描述（年龄段、兴趣方向、性格特质等）是动态生成的内容。
- 请判断写入文件时，应该写入什么内容：固定的引擎指令、动态生成的角色描述，还是两者合并？
- `PersonaMeta` 结构是否需要新增字段来存储推断结果（文化背景、立场、盲区等）？

**结论**：

- 写入文件时应写入动态生成的角色描述，而非固定的引擎指令。引擎指令是运行时行为，不是角色数据。
- `PersonaMeta` 需要扩展，新增以下推断结果字段：`culturalContext`（文化背景）、`authorRelation`（与作者的关系）、`stance`（立场）、`blindSpot`（认知盲区）

---

## 审计任务二：临时记忆功能的实现建议

### 2-A. 临时记忆的存储位置

请评估以下三种方案：

**方案一：文件系统临时文件**

- 在 `skillsDir` 同级目录下创建 `tmp/` 文件夹
- 临时记忆以 `{sessionId}_draft.json` 命名
- 优点：持久化，进程重启后可恢复
- 缺点：需要管理文件生命周期，存在未清理的孤儿文件风险

**方案二：内存 Map（进程级）**

- 在模块顶层维护一个 `Map<sessionId, DraftPersona>` 对象
- 优点：零 I/O，实现简单
- 缺点：进程重启后丢失，多进程环境下不共享

**方案三：在 MCP 上下文中通过对话历史隐式维护**

- 不新增存储，依赖 LLM 的上下文窗口记住已确认内容
- 优点：无需额外代码
- 缺点：无法精确控制「写入」和「删除」的时机，token 消耗随对话增长

**结论：推荐方案一（文件系统临时文件）**

MCP 是本地进程，文件系统是最自然的持久化方式。方案二在 MCP 重启后丢失，用户体验差。方案三无法精确控制删除时机，存在 token 泄露风险，且写入行为依赖 LLM 自行判断，执行不可保证。

孤儿文件风险通过以下机制解决：MCP 启动时自动清理 `tmp/` 目录下超过 24 小时的 draft 文件。

---

### 2-B. 临时记忆的数据结构

请建议 `DraftPersona` 的 TypeScript 类型定义，需要包含：

- 已收集的用户确认字段（年龄段、兴趣方向、性格特质、分发渠道）
- 当前收集进度（第几步）
- 会话标识符
- 创建时间戳（用于孤儿文件清理）

```typescript
interface DraftPersona {
  sessionId: string; // 会话唯一标识，格式：[a-z0-9-]
  createdAt: number; // Unix 时间戳，用于孤儿文件清理
  step: 1 | 2 | 3 | 4; // 当前收集进度
  fields: {
    ageRange?: string; // 年龄段
    interests?: string[]; // 兴趣方向标签（≤3个）
    traits?: string[]; // 性格特质标签（≤4条，「特质 → 行为」格式）
    platform?: string; // 分发渠道
  };
}
```

---

### 2-C. 临时记忆的写入时机

**审计问题**：

- 「用户确认后写入」这个动作，是在 MCP Tool 层面触发，还是由 LLM 在对话中自行判断？
- 如果是 Tool 层面触发，需要新增一个 `update_persona_draft` Tool，供 LLM 在每步确认后调用。
- 请判断是否需要新增以下 Tool：
  - `update_persona_draft(sessionId, field, value)`：更新某个字段的临时记忆
  - `delete_persona_draft(sessionId)`：删除临时记忆（在角色创建成功后调用）

**结论：必须在 MCP Tool 层面触发，必须新增两个独立 Tool**

不能依赖 LLM 自行判断写入时机——LLM 的执行不可保证，写入时机会漂移，导致临时记忆状态不可靠。

以下两个 Tool 是整个临时记忆机制能否落地的关键，不可省略：

- `update_persona_draft(sessionId, field, value)`：每步用户确认后由 LLM 调用，更新对应字段
- `delete_persona_draft(sessionId)`：角色创建成功后由 LLM 调用，删除临时记忆文件

---

### 2-D. 临时记忆的删除安全性

新版系统提示词明确要求：「删除时只删除本次创建流程生成的临时记忆文档，不得删除其他任何内容。」

请建议以下安全机制的实现方式：

- 如何通过路径校验确保只删除 `tmp/` 目录下的文件？
- 如何防止 `sessionId` 被构造为路径穿越攻击（例如 `../../personas/xxx`）？
- 是否需要在删除前校验文件的创建者或会话归属？

**实现建议**：

- 路径校验：使用 `path.resolve(filePath).startsWith(path.resolve(tmpDir))` 确保文件在 `tmp/` 目录内
- sessionId 校验：正则限制为 `/^[a-z0-9-]+$/`，拒绝任何包含 `/`、`..`、`.` 的值，在写入和删除时均校验
- 会话归属校验：在 draft 文件内写入 `sessionId` 字段，删除前读取文件内容比对，防止跨会话误删

---

## 审计任务三：整体架构建议

在完成以上两个审计任务后，请给出整体架构的修改建议，包括：

1. 需要新增的文件或模块
2. 需要修改的现有函数签名
3. 需要新增的 MCP Tool 定义
4. `utils/parser.ts` 中 `PersonaMeta` 和 `writePersonaFile` 是否需要扩展

**优先级排序改动清单（最小改动、最高安全性原则）**：

| 优先级 | 改动项                                                                 | 说明                                         |
| ------ | ---------------------------------------------------------------------- | -------------------------------------------- |
| P0     | 新增 `update_persona_draft` Tool                                       | 临时记忆写入的唯一可靠触发点，整个机制的基础 |
| P0     | 新增 `delete_persona_draft` Tool                                       | 临时记忆删除的唯一可靠触发点，安全性关键     |
| P0     | `system_prompt` 改为模块内部 `const SYSTEM_PROMPT` 常量                | 防止调用方覆盖引擎指令，行为可预测           |
| P1     | `PersonaMeta` 扩展推断结果字段                                         | 角色描述完整性依赖这四个字段                 |
| P1     | `writePersonaFile` 改为写入动态角色描述而非引擎指令                    | 写入内容定位错误，必须纠正                   |
| P2     | `required` 精简为只保留 `["name"]`                                     | 降低调用复杂度，其余字段内部生成             |
| P2     | `handleCreatePersona` 拆分为 `handleSaveDraft` + `handleCreatePersona` | 职责分离，符合单一职责原则                   |
| P3     | 新增 `tmp/` 目录管理与孤儿文件清理（MCP 启动时执行）                   | 稳定性优化，防止临时文件堆积                 |

---

## 参考：当前文件结构摘要

```
createPersonaTool.ts
├── createPersonaToolDefinition (Tool)        // MCP Tool 定义
│   └── inputSchema.system_prompt.description // 新版系统提示词（已更新）
├── CreatePersonaInput (interface)            // 输入类型定义
└── handleCreatePersona (function)            // 校验 + 写入逻辑
    ├── ID 格式校验
    ├── 路径安全校验 (validateWritePath)
    ├── 文件重复校验
    ├── PersonaMeta 构建
    └── writePersonaFile 调用
```

## 参考：新版系统提示词核心流程

```
阶段式收集（4步）
  └── 每步：用户描述 → AI提炼标签 → 用户确认 → update_persona_draft Tool 调用
          ↓
最终确认
  └── 读取临时记忆 → 模型自动推断 → 输出角色描述 → delete_persona_draft Tool 调用
          ↓
writePersonaFile（持久化）
```

---

## 执行提示词

请将以下提示词提供给本地 AI，让其根据审计报告执行代码修改任务。

---

你是一个 TypeScript 开发工程师，负责根据以下审计报告对 `createPersonaTool.ts` 及相关模块进行改造。请严格按照优先级顺序逐项执行，每项改动完成后输出对应的代码，并说明改动内容。

**执行原则**：

- 最小改动：只修改审计报告中明确要求的部分，不引入额外改动
- 最高安全性：路径校验、sessionId 格式校验、会话归属校验必须全部实现，不得省略
- 逐项确认：每完成一个优先级的改动，等待确认后再继续下一项

**执行顺序**：

**P0 — 必须首先完成，这是后续所有改动的基础**

1. 将 `system_prompt` 从 `inputSchema.properties` 中移除，在模块顶部新增 `const SYSTEM_PROMPT` 常量，内容为当前 `system_prompt.description` 字段的值。同步从 `required` 数组中移除 `"system_prompt"`。

2. 新增 `update_persona_draft` MCP Tool，实现以下功能：
   - 接收参数：`sessionId: string`、`field: "ageRange" | "interests" | "traits" | "platform"`、`value: string | string[]`
   - 在 `tmp/` 目录下读取或创建 `{sessionId}_draft.json` 文件
   - 更新对应字段，写回文件
   - sessionId 必须通过 `/^[a-z0-9-]+$/` 正则校验，不合法则拒绝
   - 路径必须通过 `path.resolve(filePath).startsWith(path.resolve(tmpDir))` 校验

3. 新增 `delete_persona_draft` MCP Tool，实现以下功能：
   - 接收参数：`sessionId: string`
   - 读取 `{sessionId}_draft.json`，校验文件内 `sessionId` 字段与参数一致
   - 校验通过后删除文件
   - 同样执行 sessionId 格式校验与路径安全校验

**P1 — 在 P0 全部完成并确认后执行**

4. 在 `utils/parser.ts` 中扩展 `PersonaMeta` 接口，新增以下可选字段：

   ```typescript
   culturalContext?: string;   // 文化背景
   authorRelation?: string;    // 与作者的关系
   stance?: string;            // 立场
   blindSpot?: string;         // 认知盲区
   ```

5. 修改 `writePersonaFile` 函数，将第三个参数从 `system_prompt` 改为 `personaDescription: string`，写入文件时写入动态生成的角色描述内容，而非固定的引擎指令。

**P2 — 在 P1 全部完成并确认后执行**

6. 精简 `createPersonaToolDefinition` 的 `required` 数组为 `["name"]`，并更新 `CreatePersonaInput` interface，将 `id`、`description` 改为可选字段（加 `?`），由模块内部自动生成。

7. 将 `handleCreatePersona` 拆分为：
   - `handleSaveDraft(tmpDir, input)`：负责读取临时记忆文件，校验完整性
   - `handleCreatePersona(skillsDir, tmpDir, input)`：调用 `handleSaveDraft` 读取草稿，执行推断，构建 `PersonaMeta`，调用 `writePersonaFile` 写入最终文件

**P3 — 在 P2 全部完成并确认后执行**

8. 在 MCP 启动入口文件中新增 `cleanStaleDrafts(tmpDir)` 函数，在服务启动时自动执行，删除 `tmp/` 目录下 `createdAt` 超过 86400000 毫秒（24小时）的 draft 文件。

**完成所有改动后，请输出更新后的完整文件结构图。**
