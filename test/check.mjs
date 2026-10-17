/**
 * check.mjs —— core.js 自检。node --test 不需要,直接 assert 跑。
 *
 * 只测有分支/有边界的:排序规则、冷却过期、裁剪、掩码、空值兜底。
 * 纯转发的格式化(fmtCount/fmtPercent)不测。
 *
 * 跑:node test/check.mjs
 */

import assert from 'node:assert/strict';
import {
  COOLDOWN_MS, MAX_LOG, fmtTokens, fmtUptime, fmtClock, successRate, fmtPercent,
  cooldownDeadline, remainMs, nodeRows, pushLog, maskKey, endpointBase, anthropicBase, rankBreakdown,
  fmtDelay, delayGrade, hasNewer, cacheRate, nodeStats, callLog, configPayload, updateHours,
  modelLabel, modelState, modelTooltip,
} from '../web/core.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

// ── 成功率 ──────────────────────────────────────────────

t('没请求时成功率是 null,不是 0(避免误报"全挂了")', () => {
  assert.equal(successRate({ requests: 0, success: 0 }), null);
  assert.equal(fmtPercent(null), '—');
  assert.equal(successRate(undefined), null);
});

t('成功率正常计算', () => {
  assert.equal(successRate({ requests: 4, success: 3 }), 0.75);
  assert.equal(fmtPercent(0.75), '75.0%');
});

// ── 时长 ────────────────────────────────────────────────

t('fmtUptime 逐级降到合适单位', () => {
  assert.equal(fmtUptime(45_000), '45 秒');
  assert.equal(fmtUptime(125_000), '2 分 5 秒');
  assert.equal(fmtUptime(3600_000 * 5 + 60_000 * 7), '5 时 7 分');
  assert.equal(fmtUptime(86400_000 * 2 + 3600_000 * 3), '2 天 3 时');
});

t('fmtUptime / fmtClock 吃到坏值不抛', () => {
  assert.equal(fmtUptime(-1), '0 秒');
  assert.equal(fmtUptime(NaN), '0 秒');
  assert.equal(fmtUptime(undefined), '0 秒');
  assert.equal(fmtClock('不是时间'), '--:--:--');
  assert.match(fmtClock('2026-08-06T01:02:03Z'), /^\d\d:\d\d:\d\d$/);
});

// ── 冷却 ────────────────────────────────────────────────

t('服务端秒数折算成本地截止点', () => {
  assert.equal(cooldownDeadline(90, 1000), 1000 + 90_000);
  assert.equal(cooldownDeadline(-5, 1000), 1000, '负数当 0,不能算出过去的截止点');
  assert.equal(remainMs(5000, 1000), 4000);
  assert.equal(remainMs(500, 1000), 0, '已过期夹到 0,不能是负数');
});

// ── 节点排序(核心) ────────────────────────────────────

const NODES = ['A', 'B', 'C', 'D'];

t('在用节点排第一,其余待用保持订阅原序', () => {
  const r = nodeRows({ nodes: NODES, current: 'C', now: 0 });
  assert.deepEqual(r.map((x) => x.name), ['C', 'A', 'B', 'D']);
  assert.equal(r[0].state, 'active');
  assert.equal(r[1].state, 'idle');
});

t('冷却中的排最后,且剩余短的靠前(对齐网关"选剩余最短")', () => {
  const now = 0;
  const r = nodeRows({
    nodes: NODES,
    current: 'A',
    cooldowns: [{ node: 'B', remain: 80 }, { node: 'D', remain: 20 }],
    now,
  });
  assert.deepEqual(r.map((x) => x.name), ['A', 'C', 'D', 'B']);
  assert.equal(r[2].state, 'cooling');
  assert.equal(r[2].remain, 20_000);
});

t('当前节点正在冷却时标 cooling 而不是 active', () => {
  const r = nodeRows({ nodes: NODES, current: 'A', cooldowns: [{ node: 'A', remain: 30 }], now: 0 });
  const a = r.find((x) => x.name === 'A');
  assert.equal(a.state, 'cooling', '被限流的节点不能显示成"在用"');
  assert.equal(r[0].name, 'B', '排头应让给真正可用的');
});

t('同一节点多条冷却时显示最长的那条,不是最后一条', () => {
  // 冷却按落地记、按供应商组分开,所以一个节点名会出现多次
  const r = nodeRows({
    nodes: NODES, now: 0,
    cooldowns: [{ node: 'A', remain: 300 }, { node: 'A', remain: 20 }],
  });
  const a = r.find((x) => x.name === 'A');
  assert.equal(a.remain, 300_000, '报最短的那条会让人以为 20 秒后就能用');
});

t('冷却已过期的条目直接当可用', () => {
  const r = nodeRows({ nodes: NODES, cooldowns: [{ node: 'B', remain: 0 }], now: 0 });
  assert.equal(r.find((x) => x.name === 'B').state, 'idle');
  assert.equal(r.filter((x) => x.state === 'cooling').length, 0);
});

t('ratio 用于画进度,落在 0..1', () => {
  const r = nodeRows({ nodes: ['A'], cooldowns: [{ node: 'A', remain: 45 }], now: 0 });
  assert.equal(r[0].ratio, 45_000 / COOLDOWN_MS);
});

t('空输入不抛,返回空数组', () => {
  assert.deepEqual(nodeRows(), []);
  assert.deepEqual(nodeRows({ nodes: [] }), []);
  assert.deepEqual(nodeRows({ nodes: ['A'], cooldowns: [null, {}] }).map((x) => x.state), ['idle']);
});

// ── 延迟 ────────────────────────────────────────────────

t('延迟原样带出,没测过的是 null 而不是 0', () => {
  const r = nodeRows({ nodes: NODES, delay: { A: 120, B: null, C: 0 }, now: 0 });
  const by = Object.fromEntries(r.map((x) => [x.name, x.latency]));
  assert.equal(by.A, 120);
  assert.equal(by.B, null, '测过但不通 -> null');
  assert.equal(by.C, null, '0ms 是不可能的实测值,当没测过');
  assert.equal(by.D, null, '压根没在 delay 里');
});

t('测不通的节点垫在最底下并标 dead,不参与轮换', () => {
  const r = nodeRows({
    nodes: ['A', 'B'], excluded: ['Z', 'Y'],
    current: 'A', delay: { A: 90, B: 300, Z: null, Y: null }, now: 0,
  });
  assert.deepEqual(r.map((x) => x.name), ['A', 'B', 'Y', 'Z']);
  assert.equal(r[2].state, 'dead');
  assert.equal(r[2].latency, null);
  assert.equal(r.filter((x) => x.state === 'dead').length, 2);
});

t('excluded 里混进还在用的节点时不重复出现', () => {
  // 两次轮询之间后端刚测完速,nodes 和 excluded 可能短暂重叠
  const r = nodeRows({ nodes: ['A', 'B'], excluded: ['B'], now: 0 });
  assert.deepEqual(r.map((x) => x.name), ['A', 'B']);
  assert.equal(r.find((x) => x.name === 'B').state, 'idle');
});

t('后端给的顺序就是优先级,前端不再按延迟重排', () => {
  // 后端排好序发过来(慢的在前是不可能的,但真发生了也得照显示 ——
  // 否则面板顺序和网关实际取用顺序不一致,那一列编号就是错的)
  const r = nodeRows({ nodes: ['slow', 'fast'], delay: { slow: 900, fast: 80 }, now: 0 });
  assert.deepEqual(r.map((x) => x.name), ['slow', 'fast']);
});

t('fmtDelay:秒级换单位,没测过显示破折号', () => {
  assert.equal(fmtDelay(87), '87ms');
  assert.equal(fmtDelay(999), '999ms');
  assert.equal(fmtDelay(1000), '1.0s');
  assert.equal(fmtDelay(2480), '2.5s');
  assert.equal(fmtDelay(59_999), '60.0s');
  assert.equal(fmtDelay(60_000), '1.0m', '推理模型跑满预算时「92.4s」得能自己换成分钟');
  assert.equal(fmtDelay(92_400), '1.5m');
  assert.equal(fmtDelay(null), '—');
  assert.equal(fmtDelay(0), '—', '0ms 不是真实结果');
  assert.equal(fmtDelay('x'), '—');
});

t('delayGrade 分三档,无数据不给档', () => {
  assert.equal(delayGrade(120), 'fast');
  assert.equal(delayGrade(299), 'fast');
  assert.equal(delayGrade(300), 'mid');
  assert.equal(delayGrade(999), 'mid');
  assert.equal(delayGrade(1000), 'slow');
  assert.equal(delayGrade(null), '');
});

// ── 日志缓冲 ────────────────────────────────────────────

t('日志超上限时裁掉最旧的,长度不超标', () => {
  const buf = [];
  for (let i = 0; i < MAX_LOG + 30; i++) pushLog(buf, { msg: i });
  assert.equal(buf.length, MAX_LOG);
  assert.equal(buf[0].msg, 30, '应保留最新的那批');
  assert.equal(buf.at(-1).msg, MAX_LOG + 29);
});

t('一次灌入远超上限也能裁到位', () => {
  const buf = Array.from({ length: 900 }, (_, i) => ({ msg: i }));
  pushLog(buf, { msg: 'last' }, 10);
  assert.equal(buf.length, 10);
  assert.equal(buf.at(-1).msg, 'last');
});

// ── Key 掩码 ────────────────────────────────────────────

t('掩码保留头尾 4 位,中段不泄漏长度', () => {
  assert.equal(maskKey('zen-a1b2c3d4'), 'zen-••••c3d4');
  assert.equal(maskKey(''), '');
  assert.equal(maskKey(null), '');
  assert.equal(maskKey('short'), '•••••', '短 key 全遮,不能露出任何字符');
  const long = maskKey('sk-' + 'x'.repeat(60));
  assert.ok(!long.includes('xxxxxxxxxxxxx'), '不能把原文抄出来');
  assert.ok(long.length < 64, '中段有上限,不按原长铺满');
});

// ── 其他 ────────────────────────────────────────────────

t('fmtTokens 空值显示 0', () => {
  assert.equal(fmtTokens(undefined), '0');
});

t('endpointBase 原样沿用当前地址,不拼进程端口', () => {
  assert.equal(endpointBase('http://ds4f.example.com'), 'http://ds4f.example.com/v1',
    '反代在 80 上时不能凭空补 :9527,那个地址外面连不上');
  assert.equal(endpointBase('http://localhost:9527'), 'http://localhost:9527/v1');
  assert.equal(endpointBase('https://a.b'), 'https://a.b/v1');
  assert.equal(endpointBase('http://h:8080/'), 'http://h:8080/v1', '末尾斜杠不能变成 //v1');
  assert.equal(endpointBase(''), 'http://localhost:9527/v1', '没 origin 时给个能用的默认');
  assert.equal(endpointBase(null), 'http://localhost:9527/v1');
});

t('anthropicBase 是裸地址,不带 /v1(客户端自己拼 /v1/messages)', () => {
  assert.equal(anthropicBase('https://ds4f.example.com'), 'https://ds4f.example.com',
    'base 带 /v1 会被拼成 /v1/v1/messages');
  assert.equal(anthropicBase('http://h:8080/'), 'http://h:8080', '末尾斜杠要去掉');
  assert.equal(anthropicBase(''), 'http://localhost:9527', '没 origin 时退回本机默认');
  assert.equal(anthropicBase(null), 'http://localhost:9527');
  // 两个协议同源,只差末尾那段 /v1
  assert.equal(endpointBase('https://a.b'), `${anthropicBase('https://a.b')}/v1`);
});

t('modelLabel 给模型名带上下文后缀,服务端没给上限的原样返回', () => {
  // 这张表以前手写在 core.js 里,现在是服务端 /api/status 的 ctx 字段(探出来的
  // 实测记录)。前端只负责查和格式化,所以测试自己造一张就够
  const CTX = {
    'deepseek-v4-flash-free': 1048576,
    'ling-3.0-flash-free': 262144,
    'north-mini-code-free': 256000,
    'hy3-free': 196608,
    'longcat-2.0-free': 1048580,
    'nemotron-3-ultra-free': 1000000,
  };
  assert.equal(modelLabel('deepseek-v4-flash-free', CTX), 'deepseek-v4-flash-free[1M]');
  assert.equal(modelLabel('ling-3.0-flash-free', CTX), 'ling-3.0-flash-free[262K]');
  assert.equal(modelLabel('north-mini-code-free', CTX), 'north-mini-code-free[256K]');
  // hy3-free 的数是从 prompt_tokens 封顶推的(它静默截断,不报超限),196608 -> "197K"
  assert.equal(modelLabel('hy3-free', CTX), 'hy3-free[197K]');
  // 刚上线还没探到上限的模型只显示名字 —— 不能显示 "[undefined]" 也不能漏掉模型
  assert.equal(modelLabel('brand-new-free', CTX), 'brand-new-free');
  assert.equal(modelLabel(null, CTX), '');
  // 服务端那个字段整个缺席时(老版本网关、或者 status 还没回来)也不能炸
  assert.equal(modelLabel('deepseek-v4-flash-free'), 'deepseek-v4-flash-free');
  assert.equal(modelLabel('deepseek-v4-flash-free', null), 'deepseek-v4-flash-free');
  // 坏值当没有,不能把 "[NaN]" 贴到界面上
  assert.equal(modelLabel('x', { x: 'huge' }), 'x');
  assert.equal(modelLabel('x', { x: 0 }), 'x');
  // 1M 那一档三种真值都得压成 "1M":2²⁰、2²⁰+4、整一百万。后缀是给人看规模的,
  // 差 4.8% 不值得写成 "1.05M" 和 "1M" 两种(maximumFractionDigits:0 负责这件事)
  assert.equal(modelLabel('longcat-2.0-free', CTX), 'longcat-2.0-free[1M]');
  assert.equal(modelLabel('nemotron-3-ultra-free', CTX), 'nemotron-3-ultra-free[1M]');
  // 后缀只有 K 和 M 两种单位,不能冒出 "1048576" 或 "1.0M" 这类写法
  for (const id of Object.keys(CTX)) {
    assert.match(modelLabel(id, CTX), /\[\d+[KM]\]$/, `${id} 的后缀得是纯数字加 K/M`);
  }
});

t('modelState 归一四种模型状态,坏值和缺字段回退 unknown', () => {
  const states = {
    ready: { status: 'available' },
    checking: { status: 'probing' },
    gone: { status: 'unavailable', error: { message: 'Model is unavailable' } },
    bad: { status: 'broken' },
  };
  assert.deepEqual(modelState('ready', states), {
    status: 'available', label: '可用', message: '', muted: false,
  });
  assert.deepEqual(modelState('checking', states), {
    status: 'probing', label: '探测中', message: '', muted: false,
  });
  assert.deepEqual(modelState('gone', states), {
    status: 'unavailable', label: '不可用', message: 'Model is unavailable', muted: true,
  });
  for (const [id, map] of [['new', states], ['bad', states], ['new', null]]) {
    assert.deepEqual(modelState(id, map), {
      status: 'unknown', label: '状态未知', message: '', muted: false,
    });
  }
});

t('modelTooltip 五行能力详情:实测优先、元数据兜底、缺字段说「未知/未探测」', () => {
  const ctx = { 'muse-free': 1048576, 'no-ctx-free': 0 };
  // 实测 maxOut 和 models.dev 的 limit.output 同时存在时取实测那份 —— models.dev
  // 对好几个 Zen 模型是错的(给 deepseek-v4-flash-free 写 200000,真值 1048576)
  const full = modelTooltip('muse-free', ctx,
    { 'muse-free': { maxOutputTokens: 262144, inputModalities: ['text', 'image'] } },
    { 'muse-free': { maxOutputTokens: 131072, reasoningTop: 'max', reasoningEfforts: ['low', 'high', 'max'] } },
    { 'muse-free': { status: 'unknown', error: { message: 'The backend is temporarily overloaded' } } });
  assert.match(full, /^muse-free\[1M\]\n/, '第一行是胶囊上那个带后缀的名字');
  assert.match(full, /上下文上限：1,048,576/);
  assert.match(full, /最大输出：131,072/);
  assert.match(full, /思考等级：low, high, max/);
  // 含 text 以外的输入模态就是多模态,并把模态名列出来 —— 「能贴图」和
  // 「能贴 PDF」不是一回事,只说「多模态」还是得去查
  assert.match(full, /输入模态：多模态（text, image）/);
  // 探针错误要带出来:unknown 的原因是「上游过载」还是「还没探」是两件事。
  // 但 unknown 仍是 unknown —— 不能靠这行文案把它说成可用或不可用
  assert.match(full, /探针状态：状态未知（The backend is temporarily overloaded）/);

  // 没探到 maxOut 时回落 models.dev
  const fallback = modelTooltip('muse-free', ctx,
    { 'muse-free': { maxOutputTokens: 262144, inputModalities: ['text'] } },
    { 'muse-free': { maxOutputTokens: null, reasoningTop: 'high', reasoningEfforts: null } },
    { 'muse-free': { status: 'available' } });
  assert.match(fallback, /最大输出：262,144/);
  // 宽松模型(对不认的档位是丢字段而不是报错)探不出完整档位表,只有顶档 ——
  // 列成 "high" 一个词会被读成「只支持 high」,所以要说清是顶档
  assert.match(fallback, /思考等级：顶档 high（完整等级未枚举）/);
  // 仅 text 不只是「不支持图片」:网关会把附件原位换成占位符再发出去
  // (见 dialects.mjs 的 isTextOnly),这件事必须写在脸上
  assert.match(fallback, /输入模态：仅文本（附件会被替换成占位）/);
  assert.match(fallback, /探针状态：可用$/);

  // 一个字段都没有的新模型:每一项都明说「未知/未探测」,不许显示 undefined/NaN/0
  const blank = modelTooltip('brand-new-free', {}, {}, {}, {});
  assert.equal(blank, [
    'brand-new-free',
    '上下文上限：未知',
    '最大输出：未知',
    '思考等级：未探测',
    '输入模态：未知',
    '探针状态：状态未知',
  ].join('\n'));

  // 模态未知 ≠ 仅文本:网关对缺元数据的模型是 fail-open(附件原样转发),
  // 显示成「仅文本」会让人以为贴图会被吃掉,反过来显示成多模态又是撒谎
  const unknownModality = modelTooltip('new-free', {}, { 'new-free': {} }, {}, {});
  assert.match(unknownModality, /输入模态：未知/);
  assert.match(modelTooltip('new-free', {}, { 'new-free': { inputModalities: [] } }, {}, {}),
    /输入模态：未知/, '空数组也是「没说」,不是「只支持文本」');
  assert.match(modelTooltip('new-free', {}, { 'new-free': { inputModalities: 'text' } }, {}, {}),
    /输入模态：未知/, '不是数组的坏值当没有');
  // 大小写和空白不该改变结论 —— 这张表是第三方的,字面值不保证规整
  assert.match(modelTooltip('new-free', {}, { 'new-free': { inputModalities: [' Text ', 'IMAGE'] } }, {}, {}),
    /输入模态：多模态（text, image）/);

  // 三张表整个缺席(旧网关、或 status 还没回来)也不能炸
  assert.match(modelTooltip('x-free'), /^x-free\n上下文上限：未知/);
  // 坏值当没有
  assert.match(modelTooltip('x-free', { 'x-free': 'huge' },
    { 'x-free': { maxOutputTokens: 'lots' } },
    { 'x-free': { maxOutputTokens: -5, reasoningEfforts: [] } }, {}),
  /上下文上限：未知\n最大输出：未知\n思考等级：未探测/);
});


t('rankBreakdown 按 token 用量降序并截断', () => {
  const r = rankBreakdown({ a: { totalTokens: 5_000 }, b: { totalTokens: 9_000_000 }, c: { totalTokens: 120_000 } }, 2);
  assert.deepEqual(r.map((x) => x.key), ['b', 'c']);
  assert.equal(r[0].totalTokens, 9_000_000);
  assert.deepEqual(rankBreakdown(null), []);
});

t('rankBreakdown 排的是用量而不是成功数或请求数', () => {
  // 「模型统计」那格问的是「token 都花在哪个模型上」。按成功数排的话,一个跑了
  // 一堆短问答的模型会压过真正吃掉大头的长对话模型
  const r = rankBreakdown({
    chatty: { requests: 500, success: 490, totalTokens: 80_000 },
    heavy: { requests: 20, success: 19, totalTokens: 6_000_000 },
  });
  assert.deepEqual(r.map((x) => x.key), ['heavy', 'chatty']);
});

t('rankBreakdown 用量相同时按模型名排,不随对象键序抖动', () => {
  const r = rankBreakdown({ zeta: { totalTokens: 10 }, alpha: { totalTokens: 10 } });
  assert.deepEqual(r.map((x) => x.key), ['alpha', 'zeta']);
});

t('rankBreakdown 丢掉零用量的模型', () => {
  // 全失败的模型没有 token,列一行 0 只是占位,那格宽度要留给真有量的
  assert.deepEqual(rankBreakdown({ dead: { requests: 12, success: 0, totalTokens: 0 } }), []);
  // 坏值和缺字段都按 0 处理,不能让 NaN 混进排序
  assert.deepEqual(rankBreakdown({ old: { requests: 9 }, bad: { totalTokens: 'x' } }), []);
});

t('rankBreakdown limit=0 不截断', () => {
  // 模型统计那格全量显示(模型是个位数量级),截到 5 会悄悄少几行
  const map = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`m${i}`, { totalTokens: (i + 1) * 1000 }]));
  assert.equal(rankBreakdown(map, 0).length, 8);
  assert.equal(rankBreakdown(map).length, 5, '默认仍截断到 5');
});

t('hasNewer 只在两个 hash 都有且不同时才亮', () => {
  assert.equal(hasNewer('c31f0a8', '9dfba56'), true);
  assert.equal(hasNewer('9dfba56', '9dfba56'), false, '更新完重启后标记要自己消失');
  assert.equal(hasNewer('', '9dfba56'), false, '还没查过就不该亮');
  assert.equal(hasNewer('c31f0a8', ''), false, '本地 hash 未知时新旧无从判断');
});

t('配置提交:只改周期时省略订阅,主动保存时保留订阅以强制刷新', () => {
  assert.deepEqual(configPayload({
    savedUrl: 'https://sub.example/a', url: 'https://sub.example/a',
    savedUpdateHours: 0, updateHours: 0,
  }), { subscriptionUrl: 'https://sub.example/a', subscriptionUpdateHours: 0 });
  assert.deepEqual(configPayload({
    savedUrl: 'https://sub.example/a', url: 'https://sub.example/a',
    savedUpdateHours: 0, updateHours: 6,
  }), { subscriptionUpdateHours: 6 });
  assert.deepEqual(configPayload({
    savedUrl: 'https://sub.example/a', url: 'https://sub.example/b',
    savedUpdateHours: 0, updateHours: 0,
  }), { subscriptionUrl: 'https://sub.example/b', subscriptionUpdateHours: 0 });
  assert.deepEqual(configPayload({
    savedUrl: 'https://sub.example/a', url: 'https://sub.example/a',
    savedUpdateHours: 0, updateHours: 0,
  }), { subscriptionUrl: 'https://sub.example/a', subscriptionUpdateHours: 0 });
});

t('自动更新小时数只接受 0 或正整数', () => {
  assert.equal(updateHours(''), 0);
  assert.equal(updateHours('0'), 0);
  assert.equal(updateHours('6'), 6);
  assert.equal(updateHours('1.5'), null);
  assert.equal(updateHours('-1'), null);
  assert.equal(updateHours('8761'), null);
});

// ── 节点统计 ────────────────────────────────────────────

t('缓存命中率:上游没给缓存字段或没有分母时显示无数据', () => {
  // 0% 会被读成「试过、一次没命中」,而真相可能是上游根本没报这个数
  assert.equal(cacheRate({ promptTokens: 100, cacheReadTokens: 0, hasCacheData: false }), null);
  assert.equal(cacheRate({ promptTokens: 0, cacheReadTokens: 0, hasCacheData: true }), null);
  assert.equal(cacheRate(undefined), null);
  assert.equal(fmtPercent(cacheRate({ promptTokens: 100, hasCacheData: false })), '—');
  assert.equal(cacheRate({ promptTokens: 100, cacheReadTokens: 0, hasCacheData: true }), 0,
    '明确收到 cached_tokens:0 才是真的 0%');
  assert.equal(cacheRate({ promptTokens: 200, cacheReadTokens: 50, hasCacheData: true }), 0.25);
});

t('nodeStats 最近调用的排最上面', () => {
  const { rows } = nodeStats({
    busy: { requests: 400, success: 400, lastAt: 1_000 },
    fresh: { requests: 2, success: 2, lastAt: 9_000 },
    mid: { requests: 40, success: 40, lastAt: 5_000 },
  });
  assert.deepEqual(rows.map((r) => r.name), ['fresh', 'mid', 'busy'],
    '刚打过的节点在最上面 —— 跑得多不代表现在还在用');
});

t('nodeStats 没有 lastAt 的旧桶垫底,同分按尝试数再按名字稳定排', () => {
  const { rows } = nodeStats({
    B: { requests: 10, success: 10 },
    A: { requests: 10, success: 3 },
    C: { requests: 40, success: 40 },
    now: { requests: 1, success: 1, lastAt: 123 },
  });
  assert.deepEqual(rows.map((r) => r.name), ['now', 'C', 'A', 'B'],
    '升级前的桶没有时间戳,只能退回原来的次序,且不能盖在有时间戳的前面');
});

t('nodeStats 跳过一次都没试过的节点', () => {
  const { rows, totals } = nodeStats({ A: { requests: 0 }, B: { requests: 2, success: 1, timeout: 1 } });
  assert.deepEqual(rows.map((r) => r.name), ['B'], '零尝试的节点不占一行');
  assert.equal(totals.requests, 2);
  assert.equal(totals.timeout, 1);
});

t('nodeStats 带出最近一次的模型和思考强度,旧桶缺字段归一成空串', () => {
  const { rows } = nodeStats({
    A: { requests: 1, success: 1, lastAt: 2, lastModel: ' deepseek-v4-flash-free ', lastEffort: ' max ' },
    B: { requests: 1, success: 1, lastAt: 1 },   // 加这两个字段之前落盘的桶
  });
  const [a, b] = rows;
  // 两头空格来自落盘数据,渲染前就该修掉,否则面板上是「模型  ds4f 」
  assert.equal(a.lastModel, 'deepseek-v4-flash-free');
  assert.equal(a.lastEffort, 'max');
  // 旧桶不能变成 'undefined' 字符串 —— 前端靠 || '—' 兜底,那要求这里是空串
  assert.equal(b.lastModel, '');
  assert.equal(b.lastEffort, '');
});

t('nodeStats 合计只加五类结果和尝试数,token 不进合计', () => {
  const { totals } = nodeStats({
    A: { requests: 3, success: 1, rateLimited: 1, timeout: 1, promptTokens: 900 },
    B: { requests: 2, success: 1, upstreamError: 1, promptTokens: 100 },
  });
  assert.deepEqual(totals,
    { requests: 5, success: 2, rateLimited: 1, timeout: 1, upstreamError: 1, clientCanceled: 0 });
});

t('nodeStats 把 clientCanceled 计入合计,且从成功率分母里剔掉', () => {
  // 一个节点:2 次成功 + 3 次客户端取消。取消不是节点的错,成功率应是 2/2=100%,
  // 而不是 2/5=40% —— 分母只算「真正跑完」的尝试
  const { rows, totals } = nodeStats({ A: { requests: 5, success: 2, clientCanceled: 3 } });
  assert.equal(totals.clientCanceled, 3);
  assert.equal(rows[0].clientCanceled, 3);
  assert.equal(rows[0].rate, 1, '取消从分母剔除后,2/2 = 100%');
  // 全是取消时没有可判定的样本,成功率是 null(不是 0%,避免误报「全挂了」)
  assert.equal(successRate({ requests: 3, success: 0, clientCanceled: 3 }), null);
});

t('nodeStats 缺字段当 0,坏值不传染成 NaN', () => {
  // 旧 usage.json 里的桶可能没有 cacheReadTokens 这类后加的字段
  const { rows } = nodeStats({ A: {
    requests: 4, success: 3, promptTokens: 200, cacheReadTokens: 50, hasCacheData: true,
  } });
  const r = rows[0];
  assert.equal(r.upstreamError, 0);
  assert.equal(r.cacheWriteTokens, 0);
  assert.equal(r.rate, 0.75);
  assert.equal(r.cache, 0.25);
  assert.deepEqual(nodeStats(null), {
    rows: [], totals: { requests: 0, success: 0, rateLimited: 0, timeout: 0, upstreamError: 0, clientCanceled: 0 },
    ttfb: null, duration: null,
  });
});

t('nodeStats 保留缓存字段存在性,兼容旧桶里的非零缓存', () => {
  const explicitZero = nodeStats({ A: {
    requests: 1, promptTokens: 100, cacheReadTokens: 0, hasCacheData: true,
  } }).rows[0];
  assert.equal(explicitZero.cache, 0, '上游明确返回 0 时面板应显示 0%');

  const legacy = nodeStats({ B: {
    requests: 1, promptTokens: 100, cacheReadTokens: 25,
  } }).rows[0];
  assert.equal(legacy.cache, 0.25, '旧桶的非零缓存读数本身足以证明上游报过数据');
});

t('nodeStats 耗时按样本数加权,不是对各节点的平均再平均', () => {
  const { rows, ttfb, duration } = nodeStats({
    // 跑了 100 次的快节点和跑了 1 次的慢节点:等权平均会算出 ~2.5s,
    // 而实际经历过的平均值贴近 100ms 那一侧
    fast: { requests: 100, success: 100, ttfbMs: 10_000, ttfbCount: 100, durationMs: 50_000, durationCount: 100 },
    slow: { requests: 1, success: 1, ttfbMs: 5_000, ttfbCount: 1, durationMs: 9_000, durationCount: 1 },
  });
  assert.equal(rows.find((r) => r.name === 'fast').ttfb, 100);
  assert.equal(rows.find((r) => r.name === 'slow').ttfb, 5_000);
  assert.equal(ttfb, 15_000 / 101, '合计应是总和除以总样本数');
  assert.equal(duration, 59_000 / 101);
});

t('nodeStats 没有成功样本时耗时是 null 而不是 0', () => {
  // 一直超时的节点:显示 0ms 等于断言「零延迟」,而真相是无从得知
  const { rows, ttfb, duration } = nodeStats({ A: { requests: 5, timeout: 5 } });
  assert.equal(rows[0].ttfb, null);
  assert.equal(rows[0].duration, null);
  assert.equal(fmtDelay(rows[0].duration), '—');
  assert.equal(ttfb, null);
  assert.equal(duration, null);
});

// ── 调用日志 ────────────────────────────────────────────

t('callLog 逐条保留同一节点的不同强度,不像聚合桶只剩最后一次', () => {
  // 这条就是这张表存在的理由:同一个节点连着跑三个档位,按节点聚合只留得下 ''
  const { rows } = callLog([
    { at: 1, node: 'A', model: 'ds4f', effort: 'high' },
    { at: 2, node: 'A', model: 'ds4f', effort: 'max' },
    { at: 3, node: 'A', model: 'ds4f', effort: '' },
  ]);
  assert.deepEqual(rows.map((r) => r.effort), ['', 'max', 'high'], '最近的排最前');
});

t('callLog 用数组顺序倒排,同一毫秒内也保真实先后', () => {
  // 按 at 排序会把同毫秒的两条打乱;后端是 push 追加的,数组本身就是时间序
  const { rows } = callLog([
    { at: 5, node: 'first' }, { at: 5, node: 'second' }, { at: 5, node: 'third' },
  ]);
  assert.deepEqual(rows.map((r) => r.node), ['third', 'second', 'first']);
});

t('callLog 的 ttfb 分清 null 和 0,坏值不传染成 NaN', () => {
  const { rows } = callLog([
    { at: 1, node: 'A', ttfb: 0, ms: 0 },
    { at: 2, node: 'B', ttfb: null, ms: null },
    { at: 3, node: 'C', ttfb: 'oops', ms: 'oops' },
    { at: 4, node: 'D', ttfb: 1200, ms: 3400 },
  ]);
  const by = Object.fromEntries(rows.map((r) => [r.node, r]));
  // 测不到首字节和「零延迟」不是一回事,两者都显示 —,但 ms=0 是个真实的数
  assert.equal(by.A.ttfb, null, 'ttfb 为 0 等于没测到');
  assert.equal(by.A.ms, 0, 'ms 为 0 是真实值,保留');
  assert.equal(by.B.ttfb, null);
  assert.equal(by.C.ttfb, null);
  assert.equal(by.C.ms, null, '坏值归一成 null,不能变 NaN');
  assert.equal(fmtDelay(by.C.ms), '—');
  assert.equal(by.D.ttfb, 1200);
});

t('callLog 平均值按有样本的条数算,推理 token 不进 total', () => {
  const { rows, tokens, ttfb, duration } = callLog([
    { at: 1, node: 'A', in: 100, out: 20, reasoning: 500, ttfb: 1000, ms: 4000 },
    { at: 2, node: 'B', in: 200, out: 30, reasoning: 0 },   // 没有耗时样本
  ]);
  assert.equal(rows[1].total, 120, 'total 只算入+出 —— 推理已经含在出里了');
  assert.equal(tokens, 350);
  assert.equal(ttfb, 1000, '分母是有样本的那一条,不是两条');
  assert.equal(duration, 4000);
});

t('callLog 修掉两头空格,坏条目直接跳过', () => {
  const { rows } = callLog([
    null, 'nope', 42,
    { at: 1, node: ' 🇭🇰 香港 01 ', model: ' ds4f ', effort: ' max ' },
  ]);
  assert.equal(rows.length, 1, '坏条目不占一行');
  // 空格来自落盘数据,渲染前就该修掉,否则面板上是「模型  ds4f 」
  assert.equal(rows[0].node, '🇭🇰 香港 01');
  assert.equal(rows[0].model, 'ds4f');
  assert.equal(rows[0].effort, 'max');
});

t('callLog 没有数据时给空表而不是崩', () => {
  for (const bad of [null, undefined, {}, 'x']) {
    assert.deepEqual(callLog(bad), { rows: [], tokens: 0, ttfb: null, duration: null });
  }
});

t('callLog 将交错完成的重试归到请求,按尝试序号排列并保留最终结果', () => {
  const { rows, tokens, ttfb, duration } = callLog([
    { at: 1, requestId: 'r1', attempt: 2, node: 'B', model: 'actual-b', effort: 'max',
      outcome: 'success', status: 200, elapsed: 900, in: 10, out: 4, ttfb: 100, ms: 900 },
    { at: 2, requestId: 'r2', attempt: 1, node: 'C', outcome: 'clientCanceled', elapsed: 500 },
    { at: 3, requestId: 'r1', attempt: 1, node: 'A', outcome: 'rateLimited', status: 429,
      error: 'quota exhausted', elapsed: 15, ttfb: 1, ms: 15, in: 2, out: 0 },
  ], [
    { at: 4, requestId: 'r1', model: 'requested', outcome: 'success', status: 200, elapsed: 1000, attempts: 2 },
    { at: 5, requestId: 'r2', model: 'requested', outcome: 'clientCanceled', status: 499, elapsed: 500, attempts: 1 },
  ]);
  assert.deepEqual(rows.map((r) => r.requestId), ['r2', 'r1']);
  const r1 = rows[1];
  assert.equal(r1.outcome, 'success');
  assert.equal(r1.model, 'requested');
  assert.equal(r1.elapsed, 1000);
  assert.equal(r1.attemptCount, 2);
  assert.deepEqual(r1.attempts.map((a) => a.node), ['A', 'B']);
  assert.equal(r1.attempts[0].status, 429);
  assert.equal(r1.attempts[0].error, 'quota exhausted');
  assert.equal(r1.attempts[1].model, 'actual-b');
  assert.equal(tokens, 16, '实际 usage 只算一次,请求汇总不再重复记 token');
  assert.equal(ttfb, 100, '失败的首字节时间不能稀释成功平均');
  assert.equal(duration, 900, '失败与取消耗时不能稀释成功平均');
});

t('callLog 无上游尝试的失败仍可查看,未完成请求不冒充成功', () => {
  const { rows } = callLog([
    { at: 1, requestId: 'running', attempt: 1, node: 'A', outcome: 'timeout', elapsed: 50 },
  ], [
    { at: 2, requestId: 'rejected', model: 'unknown', outcome: 'error', status: 400, elapsed: 2, attempts: 0 },
  ]);
  assert.equal(rows[0].requestId, 'rejected');
  assert.equal(rows[0].status, 400);
  assert.equal(rows[0].outcome, 'error');
  assert.deepEqual(rows[0].attempts, []);
  assert.equal(rows[1].requestId, 'running');
  assert.equal(rows[1].outcome, 'pending');
  assert.equal(rows[1].attempts[0].outcome, 'timeout');
});

t('callLog 历史成功不伪造请求号,未知耗时不算零耗时', () => {
  const { rows, duration } = callLog([
    { at: 1, node: 'old', in: 3, out: 2, ms: null },
    { at: 2, requestId: 'failed', attempt: 1, node: 'new', outcome: 'upstreamError', ms: 1 },
  ], []);
  const old = rows.find((r) => r.node === 'old');
  assert.equal(old.requestId, null);
  assert.equal(old.outcome, 'success');
  assert.equal(old.total, 5);
  assert.equal(old.ms, null);
  assert.equal(duration, null);
});

t('callLog 请求和尝试各自窗口截断时仍保留真实尝试数与状态', () => {
  const { rows } = callLog([
    { at: 4, requestId: 'long', attempt: 7, node: 'last', outcome: 'success' },
  ], [
    { at: 5, requestId: 'long', outcome: 'success', attempts: 7, elapsed: 100 },
    { at: 6, requestId: 'summary-only', outcome: 'error', status: 503, attempts: 2 },
  ]);
  assert.equal(rows[0].attemptCount, 2);
  assert.deepEqual(rows[0].attempts, []);
  assert.equal(rows[1].attemptCount, 7);
  assert.equal(rows[1].attempts.length, 1);
  assert.equal(rows[1].attempts[0].attempt, 7);
});

t('callLog 最终客户端失败不能被上游成功结果覆盖', () => {
  const { rows } = callLog([
    { at: 1, requestId: 'disconnect', attempt: 1, node: 'A', outcome: 'success', status: 200, in: 8, out: 2 },
  ], [
    { at: 2, requestId: 'disconnect', outcome: 'clientCanceled', status: 499, attempts: 1 },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'clientCanceled');
  assert.equal(rows[0].status, 499);
  assert.equal(rows[0].attempts[0].outcome, 'success');
  assert.equal(rows[0].attempts[0].status, 200);
});

console.log(`\ncheck.mjs: 全部通过 (${n} 组)\n`);
