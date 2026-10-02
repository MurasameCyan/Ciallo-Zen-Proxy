# Muse 模型上限、探针状态与胶囊提示实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 `subagent-driven-development`（推荐）或 `executing-plans` 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 限制 Muse 等 Responses 模型的过大输出预算，使真实成功请求更新可用状态，并在模型胶囊悬停和辅助标签中显示模型能力。

**架构：** 在 `Gateway.handleChat()` 完成协议转换后、发起上游请求前，按实测 `maxOut` 优先、models.dev `maxOutputTokens` 次之限制 `max_output_tokens`。`ModelAvailability` 增加成功状态入口，流式和缓冲成功路径都调用；`/api/status` 暴露精简能力图，前端纯函数格式化详情，再由模型胶囊使用原生 `title` 显示。

**技术栈：** Node.js 20 ESM、现有 HTTP 网关、原生浏览器 HTML/CSS/JavaScript、`assert/strict` 自检脚本；不加依赖。

---

## 文件结构

- 修改：`server/gateway.mjs` —— 对 Responses 出站预算应用模型输出上限；投影当前清单的实测输出/思考能力；在流式与缓冲成功路径更新可用状态。
- 修改：`server/model-availability.mjs` —— 增加 `markAvailable(model)`，统一写入成功状态并清除旧错误和重试时间。
- 修改：`server/index.mjs` —— 在现有 `/api/status` 增加 `modelCapabilities` 字段。
- 修改：`web/core.js` —— 增加纯函数 `modelTooltip(...)`，格式化上下文、最大输出、思考等级与探针状态。
- 修改：`web/app.js` —— 为模型胶囊生成完整 `title` / `aria-label`，并让渲染缓存键跟随能力详情变化。
- 修改：`server/preview.mjs` —— 给本地预览 `/api/status` 加一条能力完整的模型样例，实际检查已填充的 tooltip。
- 修改：`test/e2e.mjs` —— 覆盖 Anthropic Messages/原生 Responses 的真实路由预算钳制和真实成功后的可用状态。
- 修改：`test/model-availability.mjs` —— 覆盖 `markAvailable` 对旧 unknown/error 记录的转移。
- 修改：`test/server.mjs` —— 覆盖 `/api/status` 的 `modelCapabilities` 契约及取消不被标成可用。
- 修改：`test/check.mjs` —— 覆盖 tooltip 的格式化、回退和缺字段行为，以及模型渲染消费 `title`。
- 修改：`README.md` —— 说明模型悬停详情、预算上限来源和真实成功状态更新。

**工作区保护：** `server/gateway.mjs`、`server/index.mjs`、`server/model-availability.mjs`、`test/server.mjs` 已存在未提交的用户改动（包含 dead-node reviver）。实现时必须保留这些改动；不要用整文件替换或将它们混入本任务提交。每次编辑这些文件前重新读取当前内容，只改本任务涉及的紧邻代码。

## 任务 1：限制 Responses 出站输出预算

**文件：**
- 修改/测试：`test/server.mjs`
- 修改：`server/gateway.mjs`
- 端到端复核：`test/e2e.mjs`

- [ ] **步骤 1：增加失败的请求路由回归测试**

在 `test/server.mjs` 增加一个最小 Gateway 路由测试。使用 `handleMessages` 走 Anthropic → Chat → Responses 转换；将 `g.attempt` 替换为只捕获最终出站 body 的桩。让 `modelProtocol()` 返回 `responses`，`caps.get()` 返回 `{ maxOut: 131072 }`，然后验证 1M 请求上限被限制、较小预算保持不变：

```js
const g = new Gateway(load(), () => {});
const model = 'muse-spark-1.3-contributor-free';
g.models = [model];
g.modelsAt = Date.now();
g.modelProtocol = () => 'responses';
g.modelMetadata = () => ({ maxOutputTokens: 131072 });
g.caps.get = () => ({ maxOut: 131072 });
g.getAllNodes = async () => ['A'];
g.rankNodes = (nodes) => nodes;
g.ensureNode = async () => 'A';
let sent;
g.attempt = async (_res, body) => { sent = body; };

const send = async (max_tokens) => {
  const req = Readable.from([JSON.stringify({
    model, max_tokens, stream: false,
    messages: [{ role: 'user', content: 'hi' }],
  })]);
  req.headers = {};
  await g.handleMessages(req, fakeRes());
  return sent.max_output_tokens;
};
assert.equal(await send(1048576), 131072);
assert.equal(await send(64), 64);
```

同一测试再令 `caps.get()` 返回 `null`、`modelMetadata()` 返回 `{ maxOutputTokens: 65536 }`，断言 `1048576 → 65536`；两种上限都不存在时断言请求值不变。用 `handleResponses()` 单独确认原生 Responses 的 `max_output_tokens` 也走同一限制。

- [ ] **步骤 2：运行测试确认失败**

运行：`node test/server.mjs`

预期：新断言失败，捕获到的 `max_output_tokens` 仍为 `1048576`；测试不得出站访问真实上游。

- [ ] **步骤 3：在公共出站路径钳制预算**

在 `Gateway.handleChat()` 里，协议转换、模型校验并设置 `body.model` 之后，思考强度处理之前加入：

```js
if (dialect.path === RESPONSES_PATH
    && Number.isFinite(body.max_output_tokens)
    && body.max_output_tokens > 0) {
  const measured = this.caps.get(model)?.maxOut;
  const metadata = this.modelMetadata(model)?.maxOutputTokens;
  const cap = Number.isFinite(measured) && measured > 0 ? measured : metadata;
  if (Number.isFinite(cap) && cap > 0) body.max_output_tokens = Math.min(body.max_output_tokens, cap);
}
```

只限制已经存在的数值预算；未知上限或非 Responses 请求不变；不添加字段、不改上下文、不改 `dialects.mjs` 的最小输出规则。此处同时覆盖经过 `responsesUpstreamDialect` 转换的 Anthropic/Chat 请求和 `RESPONSES` 原生方言。

- [ ] **步骤 4：重跑针对性测试**

运行：`node test/server.mjs`

预期：新上限测试和原有 server 测试全部通过。随后运行：`node test/e2e.mjs`，确认请求仍通过真实路由/假上游，并在 `sent.max_output_tokens` 观察到上限值。

## 任务 2：让真实成功更新模型可用状态

**文件：**
- 修改/测试：`server/model-availability.mjs`、`test/model-availability.mjs`
- 修改/测试：`server/gateway.mjs`、`test/server.mjs` 或 `test/e2e.mjs`

- [ ] **步骤 1：增加失败的状态转移测试**

在 `test/model-availability.mjs` 先构造探针失败后的 `unknown` 记录，再调用 `markAvailable()`，断言状态、错误与重试时间：

```js
await t('真实请求成功清除未知探针错误并标记 available', async () => {
  let now = 1000;
  const a = new ModelAvailability({
    now: () => now,
    post: async () => { throw { status: 503, body: 'temporarily overloaded' }; },
  });
  await a.probe(['muse-free']);
  assert.equal(a.status(['muse-free'])['muse-free'].status, 'unknown');
  now += 10;
  a.markAvailable('muse-free');
  assert.deepEqual(a.status(['muse-free'])['muse-free'], {
    status: 'available', checkedAt: now, error: null,
  });
  assert.equal(a.nextDelay(['muse-free']), MODEL_AVAILABILITY_TTL_MS);
});
```

在现有取消测试里预置/检查 `unknown` 状态，确认客户端取消后仍为 `unknown`；在 Gateway 成功尝试测试中令上游桩返回 `ok: true`，确认成功后状态变为 `available`。通用参数 400 不得被标成成功或模型不可用。

- [ ] **步骤 2：运行测试确认失败**

运行：`node test/model-availability.mjs && node test/server.mjs`

预期：首先因 `markAvailable is not a function` 失败；取消及成功路径断言也应在状态更新尚未实现时暴露缺失行为。

- [ ] **步骤 3：实现成功状态写入**

在 `ModelAvailability` 增加：

```js
markAvailable(model) {
  const id = String(model ?? '').trim();
  if (!id) return;
  this.records.set(id, {
    status: 'available',
    checkedAt: this.now(),
    error: null,
    nextTryAt: null,
  });
}
```

在 `Gateway.attempt()` 两个成功出口调用状态更新。流式代码位于 `if (result.ok)` 内；缓冲/非流式代码位于公共成功分支、记录成功 usage 之前：

```js
if (result.ok) {
  this.availability.markAvailable(body.model);
  // 原有锁定节点、冷却清理和成功记账逻辑保持不变
}
// 缓冲/非流式路径已确认上游结果成功,此处同样更新状态
this.availability.markAvailable(body.model);
this.usage.recordAttempt(cur, 'success', result.usage, { ttfb: result._ttfb, total: dt }, call);
```

不得在 catch、取消或 `result.ok === false` 分支调用；保留既有 `markUnavailable` 的显式下线判定。保留工作区中已有的传输失败短重试和 dead-node 改动。

- [ ] **步骤 4：重跑状态测试**

运行：`node test/model-availability.mjs && node test/server.mjs && node test/e2e.mjs`

预期：已成功的真实请求更新状态；取消、通用 400、503 仍不被谎报为成功或永久下线。

## 任务 3：暴露模型能力并显示胶囊悬停详情

**文件：**
- 修改：`server/gateway.mjs`、`server/index.mjs`
- 修改/测试：`web/core.js`、`web/app.js`、`server/preview.mjs`、`test/check.mjs`、`test/server.mjs`

- [ ] **步骤 1：为状态 API 和 tooltip 纯函数增加失败测试**

在 `test/check.mjs` 导入 `modelTooltip`，覆盖实测输出优先、元数据回退、严格思考等级、宽松顶档、未知值和探针错误。代表性断言：

```js
const title = modelTooltip('muse-free', { 'muse-free': 1048576 },
  { 'muse-free': { maxOutputTokens: 131072 } },
  { 'muse-free': { maxOutputTokens: 65536, reasoningTop: 'max', reasoningEfforts: ['low', 'max'] } },
  { 'muse-free': { status: 'unknown', error: { message: 'upstream overloaded' } } });
assert.match(title, /1,048,576/);
assert.match(title, /65,536/);
assert.match(title, /low.*max/);
assert.match(title, /状态未知/);
assert.match(title, /upstream overloaded/);
```

同时在 `test/server.mjs` 的 `/api/status` 断言里验证 `modelCapabilities` 只含当前免费模型，且记录投影只含 `maxOutputTokens`、`reasoningTop`、`reasoningEfforts`，不直接泄露整个能力缓存记录。

- [ ] **步骤 2：运行前端与状态 API 测试确认失败**

运行：`node test/check.mjs && node test/server.mjs`

预期：前端测试因 `modelTooltip` 尚未导出失败；API 测试因缺少 `modelCapabilities` 失败。

- [ ] **步骤 3：增加精简能力投影和 API 字段**

在 `Gateway` 增加当前免费清单的精简能力投影：

```js
modelCapabilities() {
  const out = {};
  for (const id of this.models) {
    const record = this.caps.get(id);
    out[id] = {
      maxOutputTokens: Number.isInteger(record?.maxOut) && record.maxOut > 0 ? record.maxOut : null,
      reasoningTop: typeof record?.top === 'string' ? record.top : null,
      reasoningEfforts: Array.isArray(record?.efforts) && record.efforts.length ? record.efforts : null,
    };
  }
  return out;
}
```

在 `server/index.mjs` 的 `/api/status` 对象增加 `modelCapabilities: gateway.modelCapabilities()`；旧缓存和无记录模型仍返回空值，不改变 `/api/status` 现有字段。

- [ ] **步骤 4：实现 tooltip 格式化与渲染**

在 `web/core.js` 增加纯函数 `modelTooltip(id, ctxMap, metadataMap, capabilitiesMap, availabilityMap)`：

```js
export function modelTooltip(id, ctxMap, metadataMap, capabilitiesMap, availabilityMap) {
  const cap = capabilitiesMap?.[id] || {};
  const meta = metadataMap?.[id] || {};
  const ctx = Number(ctxMap?.[id]);
  const output = Number.isInteger(cap.maxOutputTokens) && cap.maxOutputTokens > 0
    ? cap.maxOutputTokens : Number(meta.maxOutputTokens);
  const levels = Array.isArray(cap.reasoningEfforts) && cap.reasoningEfforts.length
    ? cap.reasoningEfforts.join(', ')
    : cap.reasoningTop ? `顶档 ${cap.reasoningTop}（完整等级未枚举）` : '未探测';
  const state = modelState(id, availabilityMap);
  const error = String(availabilityMap?.[id]?.error?.message || '').trim();
  return [
    modelLabel(id, ctxMap),
    `上下文上限：${Number.isInteger(ctx) && ctx > 0 ? grouped.format(ctx) : '未知'}`,
    `最大输出：${Number.isInteger(output) && output > 0 ? grouped.format(output) : '未知'}`,
    `思考等级：${levels}`,
    `探针状态：${state.label}${error ? `（${error}）` : ''}`,
  ].join('\n');
}
```

在 `renderModels()` 读取 `S.status.metadata` 和 `S.status.modelCapabilities` 后，为每个胶囊生成 `title` 并用于缓存键与辅助标签：

```js
const title = modelTooltip(m, ctx, metadata, capabilities, availability);
li.title = title;
li.setAttribute('aria-label', title.replaceAll('\n', ' · '));
```

将 `title` 字符串放进 `ul.dataset.key` 的每行缓存值，保证元数据、能力探测和错误摘要变化时重绘。现有溢出文本仍可横向键盘滚动；title 已始终存在，不再被全名 fallback 覆盖。

在 `server/preview.mjs` 的 `/api/status` 回包里给 `big-pickle` 返回 `maxOutputTokens: 131072`、实测顶档 `high`（未枚举完整等级）和 `unknown` 探针错误，确保浏览器烟测覆盖已填充字段与错误摘要，而不是只看空值回退：

```js
modelCapabilities: {
  'big-pickle': { maxOutputTokens: 131072, reasoningTop: 'high', reasoningEfforts: null },
},
metadata: { 'big-pickle': { maxOutputTokens: 131072 } },
modelAvailability: {
  'big-pickle': { status: 'unknown', error: { message: 'upstream overloaded' } },
},
```

- [ ] **步骤 5：重跑前端与 API 测试**

运行：`node test/check.mjs && node test/server.mjs`

预期：各能力值、fallback、未知提示与可用性变化断言通过；未知/探测中状态仍不灰显为 unavailable。

## 任务 4：更新使用说明并完成验证

**文件：**
- 修改：`README.md`
- 验证：`test/check.mjs`、`test/model-availability.mjs`、`test/server.mjs`、`test/e2e.mjs`、完整 npm 测试和浏览器预览

- [ ] **步骤 1：更新 README 模型说明**

在模型可用性与上下文上限段落补充：实际请求成功会确认模型可用；模型胶囊悬停显示上下文、最大输出和思考档位，数据缺失时显示未知/未探测；Responses 出站预算优先按实测 `maxOut`，无实测时按 models.dev `maxOutputTokens` 限制。明确上下文上限不等于最大输出。

- [ ] **步骤 2：运行完整自动化测试**

运行：`npm test`

预期：`test/check.mjs`、`test/anthropic.mjs`、`test/capabilities.mjs`、`test/model-metadata.mjs`、`test/model-availability.mjs`、`test/provider-egress.mjs`、`test/server.mjs`、`test/e2e.mjs` 全部通过。

- [ ] **步骤 3：启动真实 UI 预览并验证悬停**

运行：`npm run preview`；浏览器打开 `http://127.0.0.1:5173`，使用预览登录密码 `preview`。悬停 `big-pickle` 胶囊，确认 tooltip 展示上下文 `1,048,576`、最大输出 `131,072`、顶档 `high`、未知探针状态和错误摘要；Tab 聚焦后确认 `aria-label` 含相同能力详情，窄胶囊仍可用方向键横向滚动。关闭预览服务。

- [ ] **步骤 4：对照工作区变更边界**

只报告本任务的文件和验证结果；保留实现前已存在的用户改动，不执行会将它们一并纳入的 `git add`/commit。若工作区其余状态仍有用户文件变更，保持原样。

## 依赖顺序

任务 1 和任务 2 可分别独立实现；任务 3 依赖 `Gateway.modelCapabilities()` 与 `/api/status` 字段；任务 4 在全部行为改动之后执行。执行时先跑各任务的指定回归，再跑完整套件和浏览器 smoke。