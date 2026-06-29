## Kevlar-4u MCP 初始化阶段审计报告

审计日期：2026-06-28 | SDK 版本：@modelcontextprotocol/sdk ^1.29.0 | 角色：MCP Server

---

### 一、初始化流程顺序

| # | 检查项 | 结论 | 说明 |
|---|--------|------|------|
| 1.1 | 初始化是 client 与 server 的第一次交互 | **符合** | `server.connect(transport)` 后，SDK 等待 client 发出 `initialize` 请求作为第一条消息 |
| 1.2 | 流程严格按 initialize → response → notifications/initialized | **符合** | SDK 内部强制此顺序：`_oninitialize()` 处理请求并返回响应，client 侧 `connect()` 在收到响应后发送 `notifications/initialized` |
| 1.3 | client 在 server 响应 initialize 前不发非 ping 请求 | **符合** | SDK Client `connect()` 方法串行执行：先 `await this.request({method:'initialize',...})`，完成后才处理其他请求。Kevlar 不自行发送额外请求 |
| 1.4 | server 在收到 initialized 前不发非 ping/logging 请求 | **符合** | `announceHandshakeToClient()` 仅在截获 `notifications/initialized` 后才触发，且只调用 `sendLoggingMessage()`（logging 通知属豁免范围） |

**实现机制**：`index.ts` L30-44 通过 monkey-patch `transport.onmessage` 拦截原始消息，在 SDK 处理链之前捕获 `initialize` 参数、在 `notifications/initialized` 到达时触发 `announceHandshakeToClient()`。SDK 的 `Protocol.connect()` 会保存并链式调用预设的 `onmessage`，保证不破坏协议顺序。

**结论**：完全符合。流程顺序由 SDK 保证，Kevlar 的拦截层正确地保持了链路。

---

### 二、Client initialize 请求字段审计

> Kevlar 在生产环境中是 MCP Server，不发送 initialize 请求。以下审计基于 SDK Client（E2E 测试中使用）和 Kevlar 作为 Server 接收到的请求。

| # | 检查项 | 结论 | 说明 |
|---|--------|------|------|
| 2.1 | `params.protocolVersion` 存在且为字符串 | **符合** | SDK Client `connect()` 硬编码发送 `LATEST_PROTOCOL_VERSION`（"2025-11-25"） |
| 2.2 | `params.capabilities` 存在且为对象 | **符合** | SDK Client 构造时接受 capabilities 参数，E2E 测试传 `{}`（空对象） |
| 2.3 | `params.clientInfo.name` 必填 | **符合** | E2E 测试传 `{ name: "kevlar-e2e-test", version: "1.0.0" }` |
| 2.4 | `params.clientInfo.version` 必填 | **符合** | 同上 |
| 2.5 | 无过度声明能力 | **符合** | E2E 测试传 `capabilities: {}`，不声明任何能力 |
| 2.6 | 无漏声明能力 | **符合** | 测试 Client 不使用 sampling/tasks 等能力，不声明是正确的 |

**Server 侧接收处理**：`index.ts` L33-35 拦截 `initialize` 消息，将 `msg.params` 存入 `_rawInitializeParams` 并 dump 到 `skills/tmp/raw-initialize-dump.json`。SDK 的 `_oninitialize()` 同步解析 `protocolVersion`、`capabilities`、`clientInfo` 并缓存到 `_clientCapabilities` 和 `_clientVersion`。

**结论**：符合。Kevlar 不自行构造 client initialize 请求，SDK 的 Client 实现正确地包含了所有必填字段。

---

### 三、Server initialize 响应字段审计

| # | 检查项 | 结论 | 说明 |
|---|--------|------|------|
| 3.1 | `result.protocolVersion` 存在 | **符合** | SDK `_oninitialize()` 返回协商后的版本（见审计四） |
| 3.2 | `result.capabilities` 存在 | **符合** | `server.ts` L310-325 声明了 capabilities 对象 |
| 3.3 | `result.serverInfo.name` 必填 | **符合** | `server.ts` L306: `name: "kevlar-4u"` |
| 3.4 | `result.serverInfo.version` 必填 | **符合** | `server.ts` L307: `version: _serverVersion`（从 package.json 读取） |
| 3.5 | `result.instructions` 可选 | **符合** | `server.ts` L326: `instructions: SERVER_INSTRUCTIONS`，内容为角色定义和行为约束 |

**能力声明逐项审查**：

| 能力键 | 声明 | 实际实现 | 结论 |
|--------|------|----------|------|
| `tools` | `{ listChanged: true }` | `setupListToolsHandler()` + `setupCallToolHandler()` 已注册 | **符合** |
| `logging` | `{}` | `sendLoggingMessage()` 在 `announceHandshakeToClient()` 和 `sendProgress` 中调用 | **符合** |
| `tasks` | `{ requests: { tools: { call: {} } } }` | Server 声明可向 Client 发起 task 工具调用请求。但实际代码中 Server 使用的是 `sampling/createMessage` 而非 task 级工具调用 | **需确认**（见下方建议） |
| `experimental` | `{ "kevlar.host.execution/v1": {...} }` | 用于 Kevlar 自定义的 Host 执行能力协商，`client.ts` 中 `getHostExecutionCapability()` 读取 | **符合**（实验性能力，不受标准约束） |
| `prompts` | 未声明 | 未注册 `ListPromptsRequestSchema` 或 `GetPromptRequestSchema` handler | **符合**（未实现则不声明） |
| `resources` | 未声明 | 未注册 `ListResourcesRequestSchema` handler | **符合**（未实现则不声明） |
| `completions` | 未声明 | 未注册 `CompleteRequestSchema` handler | **符合**（未实现则不声明） |

**修改建议**：

- **`tasks` 能力**：当前声明 `tasks.requests.tools.call` 意味着 Server 可能要求 Client 代为调用工具。实际代码中 Server 通过 `createMessage()` 走的是 sampling 路径，而非 task 级工具委托。建议确认此声明是否反映真实意图。若仅用于声明未来兼容性预留，可保留但添加注释说明；若确实不使用，应移除以避免过度声明。

**结论**：基本符合。`tasks` 能力声明的意图需澄清。

---

### 四、版本协商逻辑审计

| # | 检查项 | 结论 | 说明 |
|---|--------|------|------|
| 4.1 | Client 发送其支持的最新协议版本 | **符合** | SDK Client 硬编码 `LATEST_PROTOCOL_VERSION`（"2025-11-25"），即当前 SDK 支持的最新稳定版 |
| 4.2 | Server 支持则原样返回，不支持则返回自身最新版本 | **符合** | SDK Server `_oninitialize()` L274: `SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion) ? requestedVersion : LATEST_PROTOCOL_VERSION` — 支持列表为 `["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"]` |
| 4.3 | Client 收到不支持的版本时主动断开 | **部分符合** | SDK Client L304: `!SUPPORTED_PROTOCOL_VERSIONS.includes(result.protocolVersion)` 时 throw Error。但这是 JS 异常而非"主动断开连接"——依赖调用方 catch 并关闭 transport。Kevlar 的 `main().catch()` 会 `process.exit(1)`，间接实现了断开 |
| 4.4 | HTTP 传输后续请求携带 MCP-Protocol-Version 头 | **不适用** | Kevlar 仅使用 stdio 传输（`StdioServerTransport`），无 HTTP/SSE 传输。SDK Client 侧确实调用了 `transport.setProtocolVersion()` 但仅对 HTTP 传输生效 |

**潜在问题**：Server 在收到不支持的版本时不返回错误码，而是降级返回自身最新版本。这在 MCP 规范中是允许的（Server 应返回自己支持的版本），但 Client 端如果也不支持 Server 返回的版本则会 throw。整个协商逻辑完全委托给 SDK，Kevlar 无自定义版本控制。

**结论**：符合。版本协商由 SDK 完整实现，Kevlar 不需要额外处理。

---

### 五、initialized 通知审计

| # | 检查项 | 结论 | 说明 |
|---|--------|------|------|
| 5.1 | Client 收到 initialize 响应后发送 notifications/initialized | **符合** | SDK Client `connect()` L316: `await this.notification({ method: 'notifications/initialized' })`，在获得 initialize 结果后立即发送 |
| 5.2 | method 字段为 "notifications/initialized" | **符合** | SDK 源码明确使用 `method: 'notifications/initialized'` |
| 5.3 | 通知不含 params | **符合** | SDK `notification()` 调用仅传 `{ method: 'notifications/initialized' }`，无 params 字段 |

**Server 侧验证**：`index.ts` L41-43 通过拦截器检测 `msg?.method === "notifications/initialized"`，触发 `announceHandshakeToClient()`。SDK 内部的 `InitializedNotificationSchema` handler 也同步标记初始化完成，此后才允许其他请求。

**结论**：完全符合。

---

### 六、能力声明与日志输出审计

| # | 检查项 | 结论 | 说明 |
|---|--------|------|------|
| 6.1 | 握手后日志输出协商能力集合 | **部分符合** | `announceHandshakeToClient()` L201-210 输出 `client_handshake` debug 日志，包含 client 能力键列表和布尔标志。但仅记录了 **Client 能力**，未记录 Server 自身声明的能力 |
| 6.2 | 日志区分 client/server capabilities | **不符合** | 当前日志只有 `client_handshake` 事件（记录 client 能力），无对应的 `server_handshake` 或 `server_capabilities` 日志。Server 能力仅在 `createKevlarServer()` 构造时硬编码，未在运行时日志输出 |
| 6.3 | 运行时未调用未声明能力 | **基本符合** | Server 使用的能力（tools、logging、sampling/createMessage）均在初始化中声明。`tasks` 能力声明的 `requests.tools.call` 在运行时未被实际调用（见审计三建议），属于声明但未使用 |

**具体日志覆盖情况**：

- `log.handshake.debug("Client handshake complete", {...})` — 记录 client name、version、capability keys、各能力布尔值（L201-210）
- `underlyingServer.sendLoggingMessage()` — 向 Client 发送可读摘要，包含 sampling/task-augmented/task-cancel 状态（L218-224）
- `host-exec-handshake.json` dump — 记录完整的 client capabilities 和协商结果（`client.ts` L291-335）
- **缺失**：无 Server 侧能力的结构化日志输出

**修改建议**：

在 `announceHandshakeToClient()` 中增加 Server 能力日志，例如：

```typescript
log.handshake.debug("Server capabilities declared", {
  event: "server_capabilities",
  capabilities: ["tools.listChanged", "logging", "tasks.requests.tools.call", "experimental.kevlar.host.execution/v1"],
  instructions: !!SERVER_INSTRUCTIONS,
});
```

**结论**：部分符合。Client 能力日志完善，Server 能力日志缺失。

---

### 七、错误处理审计

| # | 检查项 | 结论 | 说明 |
|---|--------|------|------|
| 7.1 | 协议版本不匹配错误处理 | **符合（由 SDK 处理）** | Server 侧：SDK 自动降级到 `LATEST_PROTOCOL_VERSION`。Client 侧（E2E 测试）：SDK 检查 `SUPPORTED_PROTOCOL_VERSIONS.includes()` 不通过时 throw Error。Kevlar 的 `main().catch()` 捕获并 `process.exit(1)` |
| 7.2 | 必要能力协商失败处理 | **不符合** | MCP 规范中无"必要能力协商"机制——Server 声明能力，Client 读取，无双向协商。但 Kevlar 也未在 `announceHandshakeToClient()` 中检查 client 是否具备运行所需的最小能力集（如 sampling）。当前仅有 name-based fallback（`client.ts` L130-143），如果 client 不声明 sampling 且 name 不匹配，则降级为 `host_orchestration` 模式，无错误通知 |
| 7.3 | initialize 请求超时 + cancellation | **不符合** | `index.ts` L46 的 `await server.connect(transport)` 无超时设置。如果 client 连接后永远不发送 `initialize` 请求，server 将无限期挂起。SDK 内部也无 initialize 超时机制。同理，client 侧的 `this.request({method:'initialize',...})` 在 E2E 测试中无超时参数 |
| 7.4 | -32602 InvalidParams 错误码使用 | **符合** | `execution/parallel.ts` L85 和 `execution/taskAugmentedSampling.ts` L302 检查 `-32602` 错误码，但这是运行时工具调用错误处理，非初始化阶段。初始化阶段 SDK 不主动发出 -32602 |

**修改建议**：

1. **initialize 超时**：在 `main()` 中添加启动超时，避免 server 永久挂起：

```typescript
const INIT_TIMEOUT_MS = 30_000;
const initTimer = setTimeout(() => {
  writeRawStderr("[Kevlar-4u] Initialize timeout — no client connected within 30s");
  process.exit(1);
}, INIT_TIMEOUT_MS);

await server.connect(transport);
clearTimeout(initTimer); // 连接成功后清除
```

2. **最小能力检查**：在 `announceHandshakeToClient()` 中添加必要能力验证日志：

```typescript
if (!effectiveClientCaps?.sampling) {
  log.handshake.warn("Client does not declare sampling capability — will use host_orchestration fallback", {
    event: "missing_sampling_capability",
    clientName: effectiveClientName,
  });
}
```

**结论**：部分符合。核心错误由 SDK 处理，但缺少初始化超时和最小能力校验。

---

### 汇总矩阵

| 审计领域 | 检查项数 | 符合 | 部分符合 | 不符合 | 不适用 |
|----------|---------|------|----------|--------|--------|
| 一、初始化流程顺序 | 4 | 4 | 0 | 0 | 0 |
| 二、Client 请求字段 | 6 | 6 | 0 | 0 | 0 |
| 三、Server 响应字段 | 5+能力审查 | 4 | 0 | 0 | 0（1 项需确认） |
| 四、版本协商逻辑 | 4 | 2 | 1 | 0 | 1 |
| 五、initialized 通知 | 3 | 3 | 0 | 0 | 0 |
| 六、能力声明与日志 | 3 | 1 | 1 | 1 | 0 |
| 七、错误处理 | 4 | 1 | 0 | 2 | 0（1 项由 SDK 处理） |
| **总计** | **29** | **21** | **3** | **3** | **2** |

### 优先级修复清单

| 优先级 | 问题 | 修改建议 |
|--------|------|----------|
| **P0** | initialize 无超时（7.3） | `main()` 中增加 30s 启动超时，超时后 `process.exit(1)` |
| **P1** | Server 能力无日志（6.2） | `announceHandshakeToClient()` 中增加 `server_capabilities` debug 日志 |
| **P1** | `tasks` 能力疑似过度声明（3.x） | 确认 `tasks.requests.tools.call` 是否为预留能力；如不使用则移除 |
| **P2** | 最小能力无校验（7.2） | `announceHandshakeToClient()` 中记录 sampling 缺失的 warn 日志 |
| **P2** | Client 版本不支持时非"主动断开"（4.3） | SDK throw 后 `main().catch()` 已 exit(1)，行为可接受但非优雅断开 |
