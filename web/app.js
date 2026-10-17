/**
 * app.js —— DOM 绑定层。
 *
 * 只做三件事:轮询 /api/* 填数字、SSE 收日志、按钮发命令。
 * 所有"算出来的东西"在 core.js 里,这儿不重复计算。
 */

import {
  LOG_LEVELS, fmtCount, fmtTokens, fmtUptime, fmtClock,
  successRate, fmtPercent, cooldownDeadline, remainMs, nodeRows,
  pushLog, maskKey, endpointBase, anthropicBase, rankBreakdown, COOLDOWN_MS,
  fmtDelay, delayGrade, hasNewer, callLog, nodeStats, configPayload, updateHours,
  modelLabel, modelState, modelTooltip, backendPin,
} from './core.js';

const $ = (id) => document.getElementById(id);
const POLL_MS = 2000;

/** 界面状态。cooldowns 存的是本地截止时间戳,不是服务端给的秒数 */
const S = {
  cfg: {}, status: {}, usage: null,
  nodes: [], cooldowns: [], current: '', locked: '',
  delay: {}, excluded: [],
  egress: { byNode: {}, measured: 0, distinct: 0, measuring: false },
  nodeTestPending: false,
  logs: [], filter: 'all', follow: true,
  pinSaving: false, pinRevision: 0,
  // 检查更新查到的远端 hash。记 hash 而不是布尔:更新完镜像重启后 status 里的
  // build 就变成它,「有新版本」标记自己消失,不用再点一次才知道好了
  latest: '',
};

// ── HTTP ────────────────────────────────────────────────

async function api(path, opts) {
  const r = await fetch(`/api${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts?.headers || {}) },
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON 就当空 */ }
  // 会话过期或被退出了。回登录页,而不是让轮询一直红着「连接不上后端」——
  // 后端好得很,是这张 cookie 不认了
  if (r.status === 401) {
    location.replace('/login');
    throw new Error('未登录');
  }
  if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
  return data;
}

// ── 渲染 ────────────────────────────────────────────────

function setPill(el, cls, text) {
  el.className = `pill ${cls}`;
  el.querySelector('[data-t]').textContent = text;
}

/**
 * 「订阅地址」右端那一个状态灯。原来是三个:网关能打开这个面板就说明活着
 * (面板和 /v1 同一个 server),内核版本看一眼就够、不会变,真会动的只有节点数,所以只留这一个。
 *
 * 内核挂了的时候借它报出来 —— 只显示「无节点」的话,看不出是订阅没填还是
 * 内核死了,而这两件事要做的处置完全不同。
 */
function renderPills() {
  const st = S.status;
  if (!st.mihomoRunning) return setPill($('pill-node'), 'down', '内核未运行');

  // 只数还在轮换表里的冷却:已经被剔除的节点显示的是「不可用」,
  // 再从可用数里扣一次就成了双重扣减(分子会比实际少)
  const cooling = new Set();
  for (const c of S.cooldowns) {
    if (remainMs(c.deadline) > 0 && S.nodes.includes(c.node)) cooling.add(c.node);
  }
  // 分母算上被剔除的:订阅里有 17 个就该显示 /17,少掉的那几个正是要看见的信息
  const total = S.nodes.length + S.excluded.length;
  setPill($('pill-node'), cooling.size ? 'cool' : total ? 'up' : '',
    total ? `节点 ${S.nodes.length - cooling.size}/${total} 可用` : '无节点');
}

function renderStats() {
  const t = S.usage?.total;
  if (!t) return;

  $('s-req').textContent = fmtCount(t.requests);
  $('s-req-sub').textContent = `成功 ${fmtCount(t.success)} · 失败 ${fmtCount(t.fail)}`;

  // 成功率是请求总数右边一列,「成功率」三个字由那列的 <h3> 出,这里只填数值
  const rate = successRate(t);
  $('s-rate').textContent = fmtPercent(rate);
  $('s-rate-bar').style.width = `${(rate ?? 0) * 100}%`;

  $('s-tok').textContent = fmtTokens(t.totalTokens);
  $('s-tok-sub').textContent =
    `输入 ${fmtTokens(t.promptTokens)} · 输出 ${fmtTokens(t.completionTokens)}`
    + ` · 推理 ${fmtTokens(t.reasoningTokens)} · 缓存读 ${fmtTokens(t.cacheReadTokens)}`
    + ` · 缓存写 ${fmtTokens(t.cacheWriteTokens)}`;

  $('s-up').textContent = fmtUptime(Date.now() - (S.usage.startTime || Date.now()));
  // 不再写「主用 X」:同一张卡的「模型统计」格已经把全部模型按 token 用量列出来了
  $('s-up-sub').textContent = S.usage.lastRequest
    ? `最后请求 ${fmtClock(S.usage.lastRequest)}`
    : '还没有请求';

  renderModelStats();
}

/**
 * 模型统计格:各模型累计的 token 用量,按用量降序(排序和过滤都在 core.js 的
 * rankBreakdown 里)。数值用和左上角同一套 K/M/B 紧凑写法,精确值放在 title 里。
 *
 * 口径和「调用日志」刻意不同:那张表是最近 200 条的时间线,翻得到「这一次
 * 发生了什么」;这一格是开机至今的累计分布,回答「token 都花在哪个模型上」。
 * 逐条日志被环形缓冲截断后,早期的调用只在这个累计数里还留着。
 */
function renderModelStats() {
  const rows = rankBreakdown(S.usage?.byModel, 0);
  $('s-models-empty').hidden = rows.length > 0;

  // 全量重建。模型是个位数量级,重建比 diff 简单且看不出差别
  const ul = $('s-models');
  ul.replaceChildren(...rows.map((r) => {
    const li = document.createElement('li');
    const nm = tag('nm', r.key);
    nm.title = r.key;              // 窄档会省略号截断,悬停看全名
    const n = document.createElement('b');
    n.textContent = fmtTokens(r.totalTokens);
    n.title = `${fmtCount(r.totalTokens)} tokens`;
    li.append(nm, n);
    return li;
  }));

  // 行高量出来写进 --row,让 CSS 的「5 行」有准确基准。不能在 CSS 里用
  // calc(5*1.45em):行盒 17.4px 而 li 实际 18.4px —— 次数那个 <b> 是等宽字体,
  // baseline 对齐下它的行盒更高,把整行撑大 1px,五行差 5px 就会露出第六行的边。
  const first = ul.firstElementChild;
  if (first) {
    const h = first.getBoundingClientRect().height;
    if (h > 0) ul.style.setProperty('--row', `${h}px`);
  }

  // 这格限高 5 行、滚动条藏了(见 style.css 的 .mstats),所以装不下时得另给
  // 键盘一条路:有 tabindex 才能聚焦、方向键才滚得动。正好装得下时不加 ——
  // 不可滚的容器占一个 Tab 停留点是白挡路。
  const over = ul.scrollHeight > ul.clientHeight + 1;   // +1 吸收亚像素误差
  if (over) {
    ul.tabIndex = 0;
    ul.setAttribute('role', 'group');   // 可聚焦容器要有角色,否则读屏念不出这是什么
  } else {
    ul.removeAttribute('tabindex');
    ul.removeAttribute('role');
  }
}

function renderNodes() {
  const rows = nodeRows({ ...S, now: Date.now() });
  const ul = $('nodes');
  $('nodes-empty').hidden = rows.length > 0;
  const total = S.nodes.length + S.excluded.length;
  const probe = S.egress;
  $('btn-speed').textContent = S.nodeTestPending
    ? `进度 ${probe.measured}/${total}`
    : '测节点/出口';

  // 全量重建。节点数是几十条量级,重建比 diff 简单且看不出差别。
  // ponytail: 上限约几百条;再多要改成按 name 复用 <li>。
  ul.replaceChildren(...rows.map((n, k) => {
    const li = document.createElement('li');
    li.className = `node ${n.state}`;

    // 编号用排序后的位次,不是订阅里的下标(n.i)。卡片说「从上往下就是网关
    // 接下来会用的顺序」,那这一列就得是那个顺序;拿订阅下标去标一个已排过序
    // 的列表,冷却的节点被排到看不见的下面之后,剩下的会显示成 1,2,3,4,7,8,
    // 读着像丢了两行。要回查订阅位置的话节点名本来就是唯一的。
    const idx = document.createElement('span');
    idx.className = 'idx';
    // 被剔除的不给编号:它们不在轮换序列里,给了会让人以为还排着队
    idx.textContent = n.state === 'dead' ? '×' : k + 1;

    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = n.name;
    nm.title = n.name;

    const ms = document.createElement('span');
    ms.className = `ms ${delayGrade(n.latency)}`;
    ms.textContent = fmtDelay(n.latency);
    ms.title = 'Zen 站点延迟;站点可达不代表模型可用';

    const st = document.createElement('span');
    st.className = 'st';
    if (n.state === 'dead') {
      st.append(tag('badge dead', '不可用'));
    } else if (n.state === 'active') {
      st.append(tag('badge on', '在用'));
    } else if (n.state === 'cooling') {
      const policy = n.cooldown;
      const reason = policy?.blocked ? '拒连' : policy?.reason === 'rejected' ? '暂避'
        : policy?.reason === '5xx' ? '上游错误' : '限流';
      st.append(tag('badge cool', `${reason} ${Math.ceil(n.remain / 1000)}s`));
      st.title = `${policy?.group || 'default'} 供应商组 · ${reason}`
        + (policy?.egress ? ` · 出口 ${policy.egress}` : '');
    } else {
      st.append(tag('badge', '待用'));
    }

    li.append(idx, nm, ms, st);
    const fact = probe.byNode[n.name];
    if (fact) {
      const detail = tag('route', `中立 ${fact.neutral?.ms > 0 ? fmtDelay(fact.neutral.ms) : '—'} · 出口 ${fact.exitIp || '未知'}`);
      detail.title = `独立定向测量 ${fmtClock(fact.at)};Zen ${fact.zen?.status ?? fact.zen?.error ?? '未知'};中立 ${fact.neutral?.status ?? fact.neutral?.error ?? '未知'}`;
      li.append(detail);
    }
    if (n.cooldown) {
      const policy = n.cooldown;
      const cause = policy.blocked ? '连接被拒绝' : policy.reason === 'rejected' ? '可重试上游拒绝或超时'
        : policy.reason === '5xx' ? '上游 5xx' : 'HTTP 429 限流';
      li.append(tag('route', `${policy.group || 'default'} · ${cause}`));
    }
    return li;
  }));
}

function tag(cls, text) {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  return s;
}

/** 「标签 + 值」那一小块。值加粗,标签留灰,扫的时候只看粗体就行 */
function num(cls, label, value) {
  const s = tag(`num ${cls}`, `${label} `);
  const b = document.createElement('b');
  b.textContent = value;
  s.append(b);
  return s;
}

/** 调用日志:最终请求结果独立于可展开的真实尝试链。 */
function renderCallLog() {
  const { rows, tokens, ttfb, duration } = callLog(S.usage?.calls, S.usage?.requests);
  const { totals } = nodeStats(S.usage?.byNode);
  $('nstat-empty').hidden = rows.length > 0;
  $('nstat-sum').textContent = rows.length
    ? `最近 ${fmtCount(rows.length)} 条 · Token ${fmtTokens(tokens)}`
      + ` · 成功平均首字 ${fmtDelay(ttfb)} · 成功平均耗时 ${fmtDelay(duration)}`
      + ` · 累计限流 ${fmtCount(totals.rateLimited)} · 超时 ${fmtCount(totals.timeout)}`
      + ` · 错误 ${fmtCount(totals.upstreamError)}`
      + (totals.clientCanceled ? ` · 取消 ${fmtCount(totals.clientCanceled)}` : '')
    : '请求结果和上游尝试会保留在这里,包括失败与取消。';

  const labels = { success: '成功', rateLimited: '限流', timeout: '超时', upstreamError: '上游错误',
    clientCanceled: '客户端取消', backendMismatch: '后端不匹配', error: '失败', fail: '失败', pending: '结果待定' };
  const result = (outcome, status) => tag(`trace-result ${outcome === 'success' ? 'ok' : outcome === 'pending' ? 'pending' : 'failed'}`,
    `${labels[outcome] || outcome || '未知结果'}${status != null ? ` · HTTP ${status}` : ''}`);
  const tokenText = (r) => `Token ${fmtTokens(r.total)} · 入 ${fmtTokens(r.in)}`
    + ` · 出 ${fmtTokens(r.out)} · 推理 ${fmtTokens(r.reasoning)}`;
  const ul = $('nstats');
  const top = ul.scrollTop;
  const focused = document.activeElement?.closest('#nstats .trace-summary');
  const existing = new Map([...ul.children].map((li) => [li.dataset.traceKey, li]));

  rows.forEach((r, index) => {
    let li = existing.get(r.key);
    if (li) existing.delete(r.key);
    else {
      li = document.createElement('li');
      li.className = 'nstat';
      li.dataset.traceKey = r.key;
      const details = document.createElement('details');
      details.className = 'trace-request';
      const summary = document.createElement('summary');
      summary.className = 'trace-summary';
      const attempts = document.createElement('ol');
      attempts.className = 'trace-attempts';
      attempts.setAttribute('aria-label', '按发生顺序排列的上游尝试');
      details.append(summary, attempts);
      li.append(details);
    }
    // 保留 details/summary 节点本身:轮询不丢折叠状态,键盘焦点也不被重建夺走。
    const summary = li.querySelector('.trace-summary');
    const main = tag('nstat-main', '');
    const name = tag('nm', r.node || '无上游尝试');
    name.title = r.node;
    main.append(tag('at', fmtClock(r.at)), name,
      result(r.outcome, r.status), num('', '模型', r.model || '—'),
      num('', '总耗时', fmtDelay(r.elapsed)));
    const sub = tag('sub', `${r.requestId ? `请求 ${r.requestId}` : '历史记录 · 无请求关联'}`
      + ` · 保留 ${fmtCount(r.attempts.length)} / ${fmtCount(r.attemptCount)} 次尝试 · ${tokenText(r)}`);
    summary.replaceChildren(main, sub);

    li.querySelector('.trace-attempts').replaceChildren(...r.attempts.map((a) => {
      const item = document.createElement('li');
      const head = tag('nstat-main', '');
      const node = tag('nm', a.node || '—');
      node.title = a.node;
      head.append(tag('at', a.attempt != null ? `#${a.attempt}` : '历史尝试'), node,
        result(a.outcome, a.status), num('', '模型', a.model || '—'),
        num('', '强度', a.effort || '—'), num('', '首字', fmtDelay(a.ttfb)),
        num('', '耗时', fmtDelay(a.elapsed)));
      item.append(head, tag('sub', tokenText(a)));
      if (a.error) {
        const error = document.createElement('p');
        error.className = 'trace-error';
        error.textContent = a.error;
        item.append(error);
      }
      return item;
    }));
    if (!r.attempts.length) {
      const missing = document.createElement('li');
      missing.className = 'sub';
      missing.textContent = r.attemptCount ? '尝试明细已移出最近记录窗口。' : '没有发出上游尝试。';
      li.querySelector('.trace-attempts').append(missing);
    }
    if (ul.children[index] !== li) ul.insertBefore(li, ul.children[index] || null);
  });
  for (const li of existing.values()) li.remove();
  if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
  ul.scrollTop = top;
}

function renderConn() {
  // 屏幕上永远是掩码,它只用来「认得出是哪把 key」;要用就点「复制 Key」,
  // 那条路复制的是真值。两个协议的 base URL 一样不落框,点按钮时现算
  // (见下面的 data-copy-proto 绑定)。
  $('key-mask').textContent = maskKey(S.cfg.apiKey || '');
}

/**
 * 可用模型。服务端从上游 /zen/v1/models 现拉(开机一次、之后每天一次),这里只负责贴。
 * 写死在前端的那份漏过一个新上线的免费模型,所以不再留本地常量做兜底 ——
 * 兜底在服务端,前端拿到什么就显示什么。
 *
 * 名字后面的 `[1M]` 是上下文上限,来自服务端的实测记录(status.ctx);上游不给这个
 * 元数据,服务端还没探到的就只显示模型名(刚上线的新模型有那么几十秒是这样)。
 * modelAvailability 是最小连通性探针的快照;只有明确 unavailable 的项灰显,
 * unknown/probing 仍保留,避免把暂时限流或网络故障误画成下线。
 *
 * 胶囊本身只放得下模型名(21px 高、两列),所以「上下文 / 最大输出 / 思考等级 /
 * 输入模态 / 探针状态」走悬停和读屏:modelTooltip 拼成多行文本,数据缺失时明说
 * 未知/未探测 —— 上下文上限和最大输出是两件事(Claude Code 拿前者当输出预算发
 * 1M,换来一句不点名参数的 400),看不见这两个数就只能靠猜。
 */
function renderModels() {
  if (S.pinSaving) return;
  const list = Array.isArray(S.status.models) ? S.status.models : [];
  const ctx = S.status.ctx && typeof S.status.ctx === 'object' ? S.status.ctx : {};
  const availability = S.status.modelAvailability
    && typeof S.status.modelAvailability === 'object'
    ? S.status.modelAvailability : {};
  const metadata = S.status.metadata && typeof S.status.metadata === 'object' ? S.status.metadata : {};
  const caps = S.status.modelCapabilities && typeof S.status.modelCapabilities === 'object'
    ? S.status.modelCapabilities : {};
  const ul = $('models');
  // 哪些模型可钉后端,服务端给(见 core.js 的 backendPin)
  const pinnable = S.status.pinnableBackends && typeof S.status.pinnableBackends === 'object'
    ? S.status.pinnableBackends : {};
  const pinOn = S.status.pinClaudeBackend !== false;
  const titleOf = (m) => modelTooltip(m, ctx, metadata, caps, availability);
  // 内容没变就不重建。以前是每轮无条件重建(8 个 <li> 比 diff 还便宜),但下面
  // 要读 scrollWidth 量溢出,那会强制同步重排 —— 2 秒一次地重排一整格不值得,
  // 而这个清单几周才变一次
  //
  // key 直接拿整条 title 算:它已经把上下文、最大输出、思考等级和探针状态都
  // 折进去了 —— 新模型是先进清单、几十秒后才探出能力的,少算一项就意味着那项
  // 要等到清单下次真的变了才补上(状态同理:探针后台完成时清单本身不变)。
  //
  // 钉选开关的两个输入也要进 key:不算的话,点完开关下一轮轮询不重绘,
  // 滑块停在旧位置上(而服务端已经按新值跑了)。
  const key = JSON.stringify([
    list.map((m) => [m, modelState(m, availability).status, titleOf(m)]),
    pinnable, pinOn,
  ]);
  if (ul.dataset.key === key) return;
  const focusedPin = document.activeElement?.dataset.pin;
  ul.dataset.key = key;

  ul.replaceChildren(...list.map((m) => {
    const li = document.createElement('li');
    const state = modelState(m, availability);
    li.classList.add(state.status);
    const title = titleOf(m);
    li.title = title;
    // 读屏拿到的和悬停一样多:只靠颜色点区分状态的话,状态和能力都读不出来。
    // 换行在 aria-label 里会被读成一长串,所以折成分隔符
    li.setAttribute('aria-label', title.replaceAll('\n', ' · '));

    // 名字单独滚动,后端开关留在胶囊内。
    const name = document.createElement('span');
    name.className = 'mname';
    name.textContent = modelLabel(m, ctx);
    li.append(name);

    // 可钉后端的模型多一个开关(目前只有 exo-free)。纯开关,不配文字 ——
    // 胶囊只有 21px 高,放得下滑块就放不下说明,用途靠 title 和 aria-label 说。
    const pin = backendPin(m, pinnable, pinOn);
    if (pin) {
      const sw = document.createElement('label');
      sw.className = 'pin-switch';
      sw.title = pin.title;
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.setAttribute('role', 'switch');
      box.checked = pin.on;
      box.dataset.pin = m;
      box.setAttribute('aria-label', `锁定 ${pin.label} 后端`);
      const track = document.createElement('span');
      track.className = 'track';
      track.setAttribute('aria-hidden', 'true');
      sw.append(box, track);
      li.append(sw);
    }
    return li;
  }));

  updateModelNameFocus();
  if (focusedPin) {
    [...ul.querySelectorAll('input[data-pin]')].find((box) => box.dataset.pin === focusedPin)?.focus();
  }
}

function updateModelNameFocus() {
  for (const name of $('models').querySelectorAll('.mname')) {
    name.tabIndex = name.scrollWidth > name.clientWidth + 1 ? 0 : -1;
  }
}

function renderBuild() {
  const { build = '', buildUrl = '', repoUrl = '', trackRef = '' } = S.status;
  const el = $('build-id');
  el.textContent = build || '—';
  if (buildUrl || repoUrl) el.href = buildUrl || repoUrl;
  if (repoUrl) $('repo-link').href = repoUrl;

  const stale = hasNewer(S.latest, build);
  el.classList.toggle('new', stale);
  // 徽标只有 7 个字符,「跟谁比的」放 title 里 —— 不然「有新版本」这个状态
  // 看不出是拿哪个分支比出来的
  el.title = build
    ? `当前构建 ${build}${trackRef ? ` · 跟随 ${trackRef} 分支` : ''}${stale ? ` · 有新版本 ${S.latest}` : ''}`
    : '构建标识未知(构建时没注入 GIT_COMMIT)';
}

function renderLog() {
  const box = $('log');
  const shown = S.filter === 'all' ? S.logs : S.logs.filter((l) => l.level === S.filter);

  box.replaceChildren(...shown.map((l) => {
    const li = document.createElement('li');
    li.className = l.level || 'info';

    const t = document.createElement('span');
    t.className = 't';
    t.textContent = fmtClock(l.ts);

    const m = document.createElement('span');
    m.className = 'm';
    // 读屏听到的是纯文本,级别靠颜色区分不够,补个前缀
    m.textContent = `${LOG_LEVELS[l.level] ? `[${LOG_LEVELS[l.level]}] ` : ''}${l.msg}`;

    li.append(t, m);
    return li;
  }));

  if (S.follow) box.scrollTop = box.scrollHeight;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('toasts').append(el);
  setTimeout(() => el.remove(), 3200);
}

// ── 轮询 ────────────────────────────────────────────────

async function refresh() {
  const pinRevision = S.pinRevision;
  try {
    const [status, cfg, usage, pool] = await Promise.all([
      api('/status'), api('/config'), api('/usage'), api('/nodes'),
    ]);
    const preservePin = S.pinSaving || pinRevision !== S.pinRevision;
    const pin = S.status.pinClaudeBackend;
    S.status = status || {};
    S.cfg = cfg || {};
    // 切换前发出的慢轮询不能覆盖较新的保存结果。
    if (preservePin) {
      S.status.pinClaudeBackend = pin;
      S.cfg.pinClaudeBackend = pin;
    }
    S.usage = usage;
    S.nodes = pool?.nodes || [];
    S.current = pool?.current || '';
    S.locked = pool?.locked || '';
    S.delay = pool?.delay || {};
    S.excluded = pool?.excluded || [];
    S.egress = pool?.egress || { byNode: {}, measured: 0, distinct: 0, measuring: false };
    // 服务端给秒,进来立刻折算成本地截止点,之后本地走秒不用等下次轮询
    S.cooldowns = (pool?.cooldowns || []).map((c) => ({ ...c, deadline: cooldownDeadline(c.remain) }));

    renderPills(); renderStats(); renderNodes(); renderCallLog();
    renderConn(); renderModels(); renderBuild();

    // 表单不在用户编辑时才回填,否则打字会被轮询覆盖
    if (document.activeElement !== $('f-sub')) $('f-sub').value = S.cfg.subscriptionUrl || '';
    const persist = $('f-persist');
    if (document.activeElement !== persist) persist.checked = S.cfg.persistUsage === true;
    const hours = $('f-sub-hours');
    if (document.activeElement !== hours) hours.value = S.cfg.subscriptionUpdateHours || 0;
    renderOpenCodeUa();
  } catch (e) {
    setPill($('pill-node'), 'down', '连接不上后端');
  }
}

/** 冷却条每秒自己走,不等轮询 */
function tick() {
  if (S.cooldowns.some((c) => remainMs(c.deadline) > 0)) { renderNodes(); renderPills(); }
}

// ── 日志流 ──────────────────────────────────────────────

function connectLogs() {
  const es = new EventSource('/api/logs');
  es.onmessage = (ev) => {
    try {
      const line = JSON.parse(ev.data);
      // 首帧是历史快照(数组),之后是单条
      if (Array.isArray(line)) S.logs = line.slice(-500);
      else pushLog(S.logs, line);
      renderLog();
    } catch { /* 坏帧丢掉,不影响后续 */ }
  };
  // EventSource 自带重连,这里只在彻底关闭时兜底
  es.onerror = () => { if (es.readyState === EventSource.CLOSED) setTimeout(connectLogs, 3000); };
}

// ── 交互 ────────────────────────────────────────────────

/** 按钮跑异步命令期间禁用,避免连点触发两次重启 */
async function run(btn, label, fn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '处理中…';
  try {
    // fn 可以返回一句话补在 toast 后面(比如「刷到 48 个节点」),
    // 让「保存」这种看不出效果的操作有个可见的结果
    const extra = await fn();
    toast(extra ? `${label}完成,${extra}` : `${label}完成`, 'ok');
  } catch (e) {
    toast(`${label}失败:${e.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = old;
    refresh();
  }
}

/** 面板只展示当前同步到的 OpenCode UA 版本,不再提供可关闭的开关。 */
function renderOpenCodeUa() {
  const version = S.status?.opencodeVersion?.version;
  if (/^\d+\.\d+\.\d+$/.test(String(version || ''))) $('f-identity-version').textContent = version;
}

function wire() {
  $('btn-restart').onclick = (e) => run(e.target, '内核重启', () => api('/restart', { method: 'POST' }));
  $('btn-reset').onclick = (e) => run(e.target, '手动重置', () => api('/reset', { method: 'POST' }));

  // 退出登录:不走 run()(它要改按钮文字,会把里面的 svg 抹掉)。
  // 请求失败也照样回登录页 —— 用户的意图是「离开」,不该被一个失败的请求拦下
  $('btn-logout').onclick = async () => {
    try { await api('/logout', { method: 'POST' }); } catch { /* 下面照样跳 */ }
    location.replace('/login');
  };

  // 重置 Key 要二次确认:它就在「复制」旁边,点错的话所有在用的客户端立刻 401
  $('btn-regen').onclick = (e) => {
    if (!confirm('重置 API Key?正在用旧 Key 的客户端会全部收到 401,需要重新填。')) return;
    run(e.target, '重置 Key', () => api('/regen-key', { method: 'POST' }));
  };

  // 同步模型:立刻去上游拉一遍免费清单(平时开机一次 + 每天一次)。
  // toast 报「变了什么」而不只是「成了」—— 多数时候清单几周都不变,只说
  // 「同步完成」的话看不出到底拉到了没有,还是又拿旧的糊过去了。
  $('btn-sync').onclick = (e) => run(e.target, '同步模型', async () => {
    const r = await api('/models/sync', { method: 'POST' });
    const n = r?.models?.length ?? 0;
    const diff = [
      r?.added?.length ? `新增 ${r.added.join(', ')}` : '',
      r?.gone?.length ? `下线 ${r.gone.join(', ')}` : '',
    ].filter(Boolean).join(',');
    return diff ? `共 ${n} 个,${diff}` : `共 ${n} 个,没有变化`;
  });

  // 补探能力:给清单里还没有记录的模型探一遍上下文上限和思考强度档位。
  // 平时开机自动跑一次(有记录的一个字节都不出站),这颗按钮是给「开机那次撞上
  // 限流被跳过了」用的。
  //
  // toast 要分清「没探到」和「不用探」—— 前者是待办(换个出口再点一次),
  // 后者是正常状态。探不完就说还在探:1M 模型一个要几十秒到几分钟,那时候
  // 结果在运行日志里逐个模型出现。
  $('btn-probe').onclick = (e) => run(e.target, '补探能力', async () => {
    const r = await api('/models/probe', { method: 'POST' });
    if (r?.running) return '还在探,结果看运行日志';
    const got = r?.probed?.length ?? 0;
    const miss = r?.skipped?.length ?? 0;
    if (!got && !miss) return '都有记录,不用探';
    return `探到 ${got} 个${miss ? `,${miss} 个没探到(看运行日志)` : ''}`;
  });

  // 仅本次点击等待测量时显示进度，轮询继续更新已测数量。
  $('btn-speed').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    S.nodeTestPending = true;
    renderNodes();
    try {
      const r = await api('/nodes/test', { method: 'POST' });
      const fastest = r?.fastest ? `最快 ${r.fastest.node} ${fmtDelay(r.fastest.delay)}` : '没有可用节点';
      toast(r?.tested ? `测节点/出口完成,${r.alive}/${r.tested} 可用,${fastest}` : '测节点/出口完成', 'ok');
    } catch (err) {
      toast(`测节点/出口失败:${err.message}`, 'err');
    } finally {
      S.nodeTestPending = false;
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      renderNodes();
      refresh();
    }
  };

  // 清零要二次确认:统计是累计值,清了拿不回来(重启也不会回来,它落盘了)
  $('btn-zero').onclick = (e) => {
    if (!confirm('清零所有统计数据?请求数、Token 用量、运行时长都会从零开始,不可恢复。')) return;
    run(e.target, '统计清零', () => api('/usage/reset', { method: 'POST' }));
  };

  // 检查更新走自己的 handler 而不是 run():run 会把按钮文字换成「处理中…」,
  // 那会连带把里面的 svg 抹掉;而且它最后要 refresh() 一遍,这里没必要。
  $('btn-update').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.classList.add('spin');
    try {
      const r = await api('/check-update', { method: 'POST' });
      S.latest = r?.latest || '';
      if (r?.error) toast(`检查更新失败:${r.error}`, 'err');
      else if (r?.hasUpdate) toast(`有新版本 ${r.latest} —— docker compose pull 后重启容器`, 'ok');
      else toast(`已是最新${r?.current ? ` ${r.current}` : ''}`, 'ok');
    } catch (err) {
      toast(`检查更新失败:${err.message}`, 'err');
    } finally {
      btn.disabled = false;
      btn.classList.remove('spin');
      renderBuild();
    }
  };

  const copyToClipboard = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制', 'ok');
    } catch {
      toast('复制失败,请手动选中', 'err');
    }
  };

  // 复制:key 复制真值(屏幕上只有掩码,复制掩码出去等于给了个用不了的 key),
  // 其余按 data-copy 取那个输入框的值
  for (const btn of document.querySelectorAll('[data-copy]')) {
    btn.onclick = () => copyToClipboard(
      btn.dataset.copyReal === 'key' ? (S.cfg.apiKey || '') : $(btn.dataset.copy).value);
  }

  // 接入地址:两个协议各复制自己的 base URL,现算 —— 取当前访问地址,和原 f-base 同源
  for (const btn of document.querySelectorAll('[data-copy-proto]')) {
    btn.onclick = () => copyToClipboard(
      btn.dataset.copyProto === 'anthropic'
        ? anthropicBase(location.origin)
        : endpointBase(location.origin));
  }

  $('cfg-form').onsubmit = (e) => {
    e.preventDefault();
    const err = $('cfg-err');
    const url = $('f-sub').value.trim();

    // 提交前挡一道:订阅地址错了会让内核重启后拿不到节点
    if (url && !/^https?:\/\/.+/i.test(url)) {
      err.textContent = '订阅地址要以 http:// 或 https:// 开头';
      err.hidden = false;
      return;
    }
    const hours = updateHours($('f-sub-hours').value.trim());
    if (hours == null) {
      err.textContent = '自动更新小时数必须是 0 到 8760 的整数，0 表示关闭';
      err.hidden = false;
      return;
    }
    err.hidden = true;

    // 订阅地址和自动更新周期提交。OpenCode UA 始终由网关发送,不再作为配置项提交。
    run($('btn-save'), '保存', async () => {
      const r = await api('/config', {
        method: 'POST',
        body: JSON.stringify(configPayload({
          savedUrl: S.cfg.subscriptionUrl || '',
          url,
          savedUpdateHours: S.cfg.subscriptionUpdateHours || 0,
          updateHours: hours,
        })),
      });
      if (r?.nodes == null) return '';
      // 保存会顺带测一遍延迟。测完了就把可用数一起说了,没测完(节点多、超了
      // 20 秒)只报节点数,结果稍后自己出现在节点池里
      const s = r.speed;
      return s ? `刷到 ${r.nodes} 个节点,${s.alive}/${s.tested} 可用` : `刷到 ${r.nodes} 个节点`;
    });
  };


  // 统计持久化开关独立于配置表:它和订阅/内核无关,点一下立即生效,
  // 不用等「保存并应用」。单独 POST 到 /api/config 只带这一个字段。
  $('f-persist').onchange = async (e) => {
    const on = e.target.checked;
    try {
      await api('/config', { method: 'POST', body: JSON.stringify({ persistUsage: on }) });
      S.cfg.persistUsage = on;
      toast(on ? '统计持久储存已开启,重启不再清零' : '统计持久储存已关闭,重启后统计清零', 'ok');
    } catch (err) {
      toast(`持久储存切换失败:${err.message}`, 'err');
      e.target.checked = !on;   // 失败拨回,别让界面和服务端不一致
    }
  };

  // 模型清单会重建,开关事件委托在容器上。保存期间禁止重复提交。
  $('models').addEventListener('change', async (e) => {
    const box = e.target;
    if (!(box instanceof HTMLInputElement) || !box.dataset.pin || S.pinSaving) return;
    const on = box.checked;
    const before = S.status.pinClaudeBackend !== false;
    const wasFocused = document.activeElement === box;
    S.pinSaving = true;
    S.pinRevision++;
    box.disabled = true;
    try {
      const saved = await api('/config', { method: 'POST', body: JSON.stringify({ pinClaudeBackend: on }) });
      S.cfg.pinClaudeBackend = saved.pinClaudeBackend;
      S.status.pinClaudeBackend = saved.pinClaudeBackend;
      toast(on
        ? '已锁定 Claude 后端:重抽失败会报错,不会切换到其它后端'
        : '已关闭后端锁定:接受上游的随机后端', 'ok');
    } catch (err) {
      toast(`后端锁定切换失败:${err.message}`, 'err');
      box.checked = before;
    } finally {
      const restoreFocus = wasFocused && (document.activeElement === document.body || document.activeElement === box);
      S.pinSaving = false;
      S.pinRevision++;
      box.disabled = false;
      renderModels();
      if (restoreFocus) {
        [...$('models').querySelectorAll('input[data-pin]')].find((next) => next.dataset.pin === box.dataset.pin)?.focus();
      }
    }
  });
  new ResizeObserver(updateModelNameFocus).observe($('models'));

  for (const seg of document.querySelectorAll('.seg')) {
    seg.onclick = () => {
      for (const s of document.querySelectorAll('.seg')) s.classList.toggle('on', s === seg);
      S.filter = seg.dataset.lv;
      renderLog();
    };
  }

  $('f-follow').onchange = (e) => { S.follow = e.target.checked; if (S.follow) renderLog(); };
  $('btn-logclear').onclick = () => { S.logs = []; renderLog(); };

  // 手动往上翻就停止自动滚动,翻回底部再恢复 —— 不然读旧日志会被拽走
  $('log').addEventListener('scroll', (e) => {
    const box = e.target;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
    if (atBottom !== S.follow) {
      S.follow = atBottom;
      $('f-follow').checked = atBottom;
    }
  }, { passive: true });
}

wire();
refresh();
connectLogs();
setInterval(refresh, POLL_MS);
setInterval(tick, 1000);
