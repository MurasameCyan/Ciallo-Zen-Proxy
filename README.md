# Ciallo Zen Proxy

来都来了 不点个⭐再走吗~?

把 [opencode zen](https://opencode.ai) 的免费模型包成一个本地网关,同时支持 **OpenAI**(Chat Completions、Responses)和 **Anthropic** 协议。

出口走你自己的机场节点(内置 mihomo 解析订阅),撞到 429 自动换下一个节点 —— 因为免费额度是**按出口 IP 计**的,换 IP 就等于换额度池。

```
你的 agent ──▶ 本网关 ──▶ mihomo ──▶ 机场节点 ──▶ opencode.ai
   OpenAI /                            ▲
   Anthropic                       429 就换一个
```

> **代码在 [`beta`](https://github.com/MurasameCyan/Ciallo-Zen-Proxy/tree/beta) 分支。**
> `main` 只放这份说明。镜像由 `beta` 的推送构建,标签仍然是 `:latest`,所以 compose 不用改。

---

## 如何用

```bash
curl -O https://raw.githubusercontent.com/MurasameCyan/Ciallo-Zen-Proxy/beta/docker-compose.yml
curl -o .env https://raw.githubusercontent.com/MurasameCyan/Ciallo-Zen-Proxy/beta/.env.example

# 编辑 .env,至少把 PANEL_PASS 填上
docker compose up -d
```

打开 <http://127.0.0.1:9527>,用 `.env` 里的凭据在登录页登录,在「配置」里填机场订阅地址、保存。节点会当场刷新,不用重启容器。

面板上那个 Key 就是接口 Key,复制走给 agent 用。

**升级:** `docker compose pull && docker compose up -d`

### .env

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `PANEL_PASS` | ✅ | 面板密码。面板会**明文显示** API Key 和订阅地址(里面有机场 token),别用弱密码 |
| `PANEL_USER` | | 默认 `admin` |
| `SUBSCRIPTION_URL` | | 机场订阅(Clash/mihomo 格式)。只在首次启动播种,之后以面板里改的为准 |
| `API_KEY` | | 留空则首次启动自动生成,面板里可查可换 |
| `NODE_TEST_URL` | | 延迟探针地址,默认 `https://opencode.ai/`(HEAD 站点根路径,不碰 `/zen/v1`,不花额度)。这条请求是走节点发出去的,你本机连不上不影响 |
| `NODE_TEST_TIMEOUT_MS` | | 单次探测超时,默认 `5000`,取值夹在 1000–8000 之间。超时算不可用 |
| `SHOW_THINKING` | | 设成 `0` 关掉推理内容转发(见下文「推理内容」) |
| `GITHUB_REPO` | | 「检查更新」跟哪个仓库比,默认 `MurasameCyan/Ciallo-Zen-Proxy`。改成自己的 fork 就查自己的 |
| `GITHUB_TRACK_REF` | | 跟哪个分支比,默认 `beta`(`latest` 镜像就是从它出的) |

compose 默认只绑 `127.0.0.1:9527`。想让同网段其它机器连,把端口改成 `"9527:9527"` —— 那等于把面板一起暴露到局域网,`PANEL_PASS` 必须是强密码。

---

## 接上你的工具

面板「接入」卡里有两颗地址按钮:「OpenAI 地址」给你带 `/v1` 的地址、「Anthropic 地址」给你不带 `/v1` 的裸地址(Claude Code 那类客户端自己拼 `/v1/messages`)。两者都取你当前的访问地址,反代/端口映射后面也对。

**模型名必须填对。** 网关只接受当前 `/v1/models` 列出的免费模型,并把你选择的模型原样发给上游；缺少 `model`、模型名为空、填了未知或非免费模型都会在出站前返回 400,不会消耗任何节点尝试。

**「在清单里」不等于「此刻能出结果」。** 网关会用最小请求探测模型可用性，正常结果按六小时间隔刷新，不记入用量统计。只有明确的模型级业务拒绝才灰显为「不可用」；429、可重试的 403/408、网络错误和 5xx 保持「待重试」，不据此断言模型下线。真实请求遇到 `400 Model is unavailable` 时，只把该模型短暂冷却 15 分钟，不切出口；429 按供应商组冷却出口，403/408 短暂避让，5xx 按上游故障处理。其它不可重试的 4xx 原样返回。

`deepseek-v4-flash-free` 就是这种:2026-08-21 opencode 的限时免费推广结束(models.dev 同日标成 deprecated),上游清单里还列着它,但 chat / Responses 一律回 `400 Upstream request failed: Model is unavailable.`,换 UA、换出口都一样。网关把它灰显成「不可用」并按模型冷却一段时间,冷却期内的请求出站前就回 400,不切节点、不烧额度。付费的 `deepseek-v4-flash` 仍在,但那要 Zen 余额,不在本网关范围内。

这份清单是**现拉的**:`GET https://opencode.ai/zen/v1/models`,从 60 多个模型里挑出免费的(`-free` 后缀,外加 `big-pickle` 这个没后缀的例外)。不写死是因为写死过一次就漏了 —— 上游后来上线 `longcat-2.0-free`,而代码里那份列表没人记得改。面板模型列表与 `/v1/models` 使用同一份缓存。

### 模型可用性

面板模型胶囊上的状态点来自 `/api/status` 的 `modelAvailability`：`available` 是最近一次最小请求成功，`probing` 是正在探测，`unknown` 是还没得到可靠结果，`unavailable` 是上游明确拒绝了这个模型。只有 `unavailable` 灰显。探针与真实请求共用出口冷却，必要时有限换点；不会写入 `usage.json`。

探测不等于能力探测。能力探测会上传数 MB 去测上下文上限,而可用性探测只问「现在能不能接受一个最小请求」;两者独立计时。探测失败不会阻塞正常请求,也不会把模型从 `/v1/models` 清单删除。

**真实请求成功也算证据,而且比探针硬。** 探针对 5xx 只记 `unknown` 并等满六小时(上游故障不是这个模型的属性),于是上游抖一下就能让胶囊灰着「状态未知」好几个小时 —— 而同一个模型其实一直在为你干活。所以上游确认成功的请求(流式跑完、或非流式拼装完成)会把该模型写回 `available` 并清掉上一次的错误原因;失败、中断、客户端取消都不写。这条不增加任何出站:用的是你本来就要发的那个请求。

**429 是出口额度耗尽,不是模型属性。** 免费额度按出口 IP 计。2026-10-13 实测:`muse-spark-1.3-contributor-free` 在部分出口上回 `429 FreeUsageLimitError` + `retry-after: 20661`(约 5.7 小时),官方 CLI `1.19.0` 在同一出口上也一样;换到还有额度的出口就是 200。探针以前撞上 429 只换节点、不记冷却,而且要等满六小时才重探,于是 muse / space-bunny 的胶囊一直灰着,其实真实请求换个出口就能跑。现在探针和真实请求一样,把 429 的出口按上游的 Retry-After 记进同一张冷却表,两边都不再撞它;429 的模型 15 分钟后换出口再探,不等六小时。`muse-spark-1.2-contributor-free` 在上游目录里已标 `deprecated`,官方 1.19.0 不再列出它,但同样的请求在有额度的出口上仍回 200。

**免费层拒绝必须与当前官方 CLI 对照。** 2026-10-17，官方发行版 `2.0.32` 对 `nemotron-3.5-super-vl-free` 在部分隔离出口上也返回 `403 FreeTierError`，同出口的网关与探针一致；换到另一条已独立确认公网 IP 的出口后，官方 CLI、真实网关请求和探针均回 200，客户端收到完整 `PONG`。期间还遇到短暂 500，同一请求交错重放后恢复。因此不能只凭错误原文判定额度耗尽、模型永久下线或能力上限。

**拉取时机**:容器启动**立刻**拉一次,之后**每 24 小时**一次,由一个后台定时器负责。开机那次是关键 —— 靠 TTL 熬到过期意味着刚启动的容器要顶着旧清单跑一整天,而重启本来就是「我想让它重新认一遍」的时刻。这个端点几周才变一次,拉勤了只是白出站。等不到明天就点「配置」卡里的**「同步模型」**,当场拉一遍,提示里会告诉你新增/下线了哪些、没变化也会说「没有变化」。这条路(和它背后的 `POST /api/models/sync`)拉失败会**报错**,而自动那两条是静默的 —— 手动点的动作看不到结果等于没点。拉完清单紧接着会跟盘上的能力记录对一遍,清单里有、记录里没有的模型当场探一次(见「能力探测」)。

「每 24 小时」以前是**搭面板轮询的车**:只有 `freeModels()` 被问到(面板 2 秒一次的 `/api/status`、`/v1/models`、或者一个真实请求)才会顺手看一眼过期没有。于是面板关着、又连着一天没请求的话,清单就一直是开机那份 —— 开机那次要是也没拉到,跑的就是代码里的兜底常量,而下一个请求恰好会被那份旧清单挡掉(上游新上的免费模型在网关这儿是 `400 Model not available`)。现在是真定时器,没人看着也照样同步;`models.dev` 元数据搭同一趟车,因为免费判据的第二道(按价格认出「免费但 id 没 `-free` 后缀」的模型)查的就是它。定时器 `unref`,不会让 `SIGTERM` 多等;那一拍的结果会在运行日志里记一行 `[models-auto]`。

**三级回落**:先**直连**上游,不通再**走代理**(节点),两条都不通就用代码里的兜底常量。直连优先是因为这个端点是公开目录、不鉴权、不按 IP 算免费额度(那是 completions 才有的事),直连省一次经节点的出站;更要紧的是**内核没起来时直连是唯一能拉到的路** —— 没配订阅、或 mihomo 挂了的时候,以前这里只会失败。兜底常量是 2026-08-29 核对过的 9 个(上游当天列 64 个模型,免费的就这 9 个),它只在两条网络路径都断时露面,面板那一列不会变空。第 9 个 `ling-3.0-flash-fin-free` 是 2026-08-29 上线的,当天实测出能力记录之后才进兜底 —— 这份清单里的每个模型都必须有一条实测记录(见「能力探测」),没探出来的只靠自动同步进来,不写进常量。

### 上下文上限

面板「可用模型」里名字后面的 `[1M]` 就是这一列。上游的 `/zen/v1/models` 一个字节的元数据都不给,所以这些是**实测值** —— 发一个必然超限的请求,让上游自己的参数校验器把上限报在错误原文里。2026-08-11 全量测过一遍,`x-preview-f-free` 是 2026-08-21 补测的(它已于 2026-08-28 前下线,见表下的 ‡)。

`x-preview-f-free` 就是上游文档里的「Ox Alpha Free」(2026-08-20 上线的匿名 stealth 模型),id 里看不出来。它的上限不是校验器报出来的 —— `[1261] Prompt exceeds max length` 只说超了不说上限是多少,所以这个数是夹出来的:1,048,488 个 token 能过、1,048,688 报错,区间里的整数只有 2²⁰ 这一个说得通,而它的 `max_tokens` 校验器报的上限正好是 131,072(2¹⁷),同一套 2 的幂。

| 模型 | 上下文 | 实测上限(token) |
| --- | --- | --- |
| `big-pickle` | **1M** | 1,048,576 |
| `deepseek-v4-flash-free` | **1M** | 1,048,576 |
| `mimo-v2.5-free` | **1M** | 1,048,576 |
| `x-preview-f-free` ‡ | **1M** | 1,048,576 |
| `longcat-2.0-free` † | **1M** | 1,048,580 |
| `nemotron-3-ultra-free` | **1M** | 1,000,000 |
| `nemotron-3.5-lightning-free` | **1M** | 1,000,000 |
| `ling-3.0-flash-fin-free` | **262K** | 262,144 |
| `ling-3.0-flash-free` † | **262K** | 262,144 |
| `ling-3.0-tiny-free` † | **262K** | 262,144 |
| `laguna-s-2.1-free` | **262K** | 262,144 |
| `north-mini-code-free` † | **256K** | 256,000 |
| `hy3-free` | **197K** | 196,608(静默截断,见下) |

† 2026-08-21 已从上游清单下线,面板上看不到了。这里照列是因为**记录留着**(在 `server/capabilities.mjs` 的 `SEED` 里):哪天 id 一样地回来,直接复用这个数,不用再探一遍。

‡ 2026-08-28 复核时已从上游清单消失 —— 它是「免费一周」的限时模型(2026-08-20 上线),到期即止。记录同样留着。

`1M` 那一档里既有 2²⁰(1,048,576)也有整一百万,都按 `1M` 标 —— 后缀是给人看规模的,差 4.8% 不值得写成 `1.05M` 和 `1M` 两种。要精确值就看右边那列。

`hy3-free` 这一行的判据和其它模型不同,用的时候要当心。它**没有参数校验器**:超限不报错,而是把多出来的那截**静默丢掉**照常回答。所以 196,608 不是错误原文里读来的,是从 `prompt_tokens` 封顶推出来的 —— 700K / 800K / 1.2M / 2M / 3M 字符五种输入全都回报 `196608`,而未超限的输入随大小线性增长(120K 字符→72,368、250K→150,809、300K→180,778)。五个差距悬殊的输入收敛到同一个数,那个数就是上限。

实践上的区别:别的模型超限会 400 挡回来,你立刻知道要缩;hy3 超限**看起来是成功的**,只是它没读到你以为它读到的内容。所以贴长文给它之前自己先截到 196K 以内。

那一列排成**两列**,名字装不下时在自己那个胶囊里左右滚,不用省略号 —— 模型名要照着填进客户端,`nemotron-3.5-lightning…` 这种截断既看不出是哪个也复制不全。胶囊连边框只有 21px 高,塞进一条横向滚动条就没地方放字了,所以条是藏起来的:溢出的那几个另外拿到键盘焦点(方向键能滚),没溢出的不加,免得白占一串 Tab 停留点。

**悬停胶囊看四行能力**(读屏从 `aria-label` 拿到同样的内容):上下文上限、最大输出、思考等级、探针状态。上下文和最大输出**是两件事** —— 2026-10-02 实测 Claude Code 对 `muse-spark-1.3-contributor-free` 发 `max_tokens: 1048576`(拿上下文当输出预算),上游只回一句不点名参数的 `400 The request contains invalid parameters`;同一请求把预算降到 131,072 就 200。所以这两个数现在都摆出来,不用猜。思考等级有实测档位表的列全表(严格型模型),只探到顶档的写「顶档 X(完整等级未枚举)」(宽松型:不认的档位是丢字段而不报错),没有记录的写「未探测」;上下文/最大输出缺记录时写「未知」—— 空着和「实测为 0」是两回事。

**出站前按已知上限夹一次输出预算。** 走 Responses 端点的请求(原生 Responses 客户端,以及 `muse-spark` 这类被 chat/messages 客户端点到、由网关翻成 Responses 的),`max_output_tokens` 会被夹到 `min(客户端要的, 这个模型的上限)`:实测 `maxOut` 优先,没探到就用 models.dev 的 `limit.output`。只往下夹、不放大,也不新增字段 —— 比上限小的预算是客户端自己要的「尽量短」;两处都没有上限就一个字不改,猜一个数会把本来能过的请求夹坏。上下文上限不参与这件事。

这个数是 messages 加 completion 的合计,不是单给输入的。第三方模型库对这些值至少错了四个(models.dev 给 `deepseek-v4-flash-free` 写的是 200000,真值 1048576),所以别照抄。这张表**不再是手写的**,新模型上线会自己长出来 —— 见下面「能力探测」。

models.dev 只作为补充元数据源:网关每天最多刷新一次,缓存到 `/data/models.dev.json`,并在 `/v1/models` 和 `/api/status` 附带名称、成本、模态、工具调用、弃用状态和原生协议等信息。它的 `context_window` 不作为容量真值,网关始终优先返回本地能力探测结果;没有实测记录时不编造容量。

模型模态也参与请求转换:只有 models.dev **明确**标成仅支持 `text` 的模型,网关才把 Chat、Responses、Anthropic 三种请求里的图片和文档按原位置替换成 `[image attached]` / `[document attached]`,避免把模型吃不了的附件原样发上去换 400。模态未知时保持原请求(fail-open),含 `image` 等其它输入模态时正常转发附件。

模型胶囊的悬停详情会显示输入模态：仅文本、多模态或未知。未知不等于仅文本，也不代表已确认支持图片。

### 能力探测

上下文上限和思考强度这两件事上游都不给元数据,只能实测。以前是三张手写常量表(`web/core.js` 的 `MODEL_CTX`、`server/anthropic.mjs` 的 `MAX_CAPABLE` 和 `STRICT_EFFORTS`),代价付过两次:上游新上一个模型表里没有,面板少个 `[1M]` 后缀是小事,**思考强度折错档是大事**(`x-preview-f-free` 的 `medium` 直接 400,而那正是 Claude Code 敲 `think` 翻出来的档位);上游下线一个模型表里还留着,手动清理要连带动测试断言,于是干脆不清,于是表越来越不像真的。

现在记录**按模型 id 存在盘上**(`/data/capabilities.json`),容器启动拉完免费清单后,给清单里**没有记录**的模型现探一次,探完落盘。于是:

- **下线的模型不会出现在面板上。** 面板显示的是「上游现在的清单」,记录只是一张按 id 查的字典 —— 查不到就不显示后缀,字典里多几条没人问它。
- **记录留着不删。** 下线的模型哪天回来了,id 一样就直接复用,不用再探一遍。
- **新模型只探它自己**,不动其它模型的记录。清单没变化就一次出站都没有。

探测手法就是**把上游自己的参数校验器逼出来**:发一个必然违规的值,从错误原文里把合法范围读回来。`max_tokens` 发 999999999 换来 `限制数值范围[1,131072]`;思考强度发一个不存在的档位,严格的模型会回 `please use low, high, or max`,宽松的模型只是丢字段照常回答(那就记成「宽松,不用夹」)。这两种探测各只有几十字节,任何时候都跑。

上下文那一探贵得多(一发就是几 MB),所以只给没有 `ctx` 记录的模型探,串行跑,并且有 48MB 的出站预算封顶 —— 一次装了十个新模型的话探不完的留到下次。先发一次 1.2M token 的顶格请求分流:报出上限的是校验器型(一次搞定)、只说「超了」不说多少的是夹逼型(在 `[196608, 256000, 262144, 1000000, 1048576]` 这几个候选里二分)、不报错但 `prompt_tokens` 封了顶的是静默截断型(`hy3-free` 就这一种)、连 1.2M 都能过的说明上限还在更上面(记下来但不猜)。

**探测失败不落记录。** 只有 4xx(429 除外)算「校验器在说话」;5xx、连不上、超时的错误原文里没有任何关于这个模型的信息,把它当成「探到了:宽松、顶档 high」会写一条**假记录**,而且以后再也不会重探(只探没记录的)。档位和顶档那两探撞上 429 会当场停手,日志里说清停在哪 —— 顶着限流硬探只会把整个节点池烧掉。

探针遇到机场拒连、429 或临时 5xx 时最多尝试三个出口；机场拒连进入封域冷却，429 按上游 Retry-After 进入限流冷却（和真实请求共用一张表）。校验器给出的参数错误原样交给能力解析器，不换节点重复发送。轮换耗尽仍保留原错误，不伪造能力记录。

**但「探不出结果」和「探测失败」是两回事,前者也要记。** 顶探就过了(说明窗口比 1.2M 还大)、或者候选表里一个都夹不出来,这都是**结论**:上限记成空,但连同探测时刻一起落盘。不落的话每次开机都要为同一个模型再花一次 6MB 去问同一个问题。只有「这轮流量预算没轮到它」不留戳 —— 那确实该下次接着探。

`muse-spark-1.2-contributor-free` 是这套东西上线第一天就撞上的反例,值得单独记一笔。它**不管收到什么都回一个没有 `error` 字段的「成功壳子」配一个怪状态码**:普通对话 200、`max_tokens: 1` 是 400、非法档位 400、`max_tokens: 9e8` 偏偏是 **429**。那个 429 显然不是「出口被限流」,可它一度把整轮探测掐停,于是这个模型每次开机都探、每次都白探。现在 `max_tokens` 那一探是 best-effort(它只是留档,没有任何地方拿它做判断),探不到就空着,已经探明白的档位和顶档照样留下 —— 真的出口限流会在更便宜、更正常的前两次请求上先露出来。

**读上限要按句式认,不能盲取原文里最大的数。** 这条是 2026-08-29 探 `ling-3.0-flash-fin-free` 时踩出来的。它的超限原文把两个数写在一起:

```
This endpoint's maximum context length is 262144 tokens.
However, you requested about 1500001 tokens (1500000 of text input, 1 in the output).
```

真上限是前面那个 262144,而最大的那个数是**我自己发出去的量**。早先的实现取最大值,于是把 1500001 当成实测结论落了盘 —— 而且以 `method=validator` 落盘、之后只探没记录的模型,所以**永不重探**:面板从此显示 `[2M]`,真值 256K,差 8 倍。这不是纸面推演,线上那份记录当时就是 1500001。

麻烦的是两种排列**方向相反**:上面这条 limit 在前,而 `[1261] input 1300000 tokens > limit 1048576` 是 limit 在后。单靠取最值必然错一边。所以现在先按点名上限的句式抽(`maximum context length is N`、`> limit N`、中文的 `限制上下文长度[1,N]`),抽不到才回退到取最值。句式那条路不套「至少十万」的下界 —— 那个下界是给盲取防错误码用的(`[1261]` 本身就是个数字),既然点了名就没有这个歧义,沿用的话 64K 级模型永远读不出上限。

还有一处要防:限流话术同样带「limit + 大数字」,但那说的是配额不是容量。`rate limit: 1000000 requests per day` 会被读成一百万的上下文。生产路径上 429 早被「探测失败不落记录」那条挡掉了,但上游偶尔把配额话术塞进 400,所以解析时先把限流那半句摘掉再抽 —— 只摘那一句而不是整条弃用,因为同一段话里可能两种 limit 都在,真上限不该被连坐。

开机那次撞上限流被跳过了,就点「配置」卡里的**「补探能力」**补一遍(背后是 `POST /api/models/probe`)。都有记录时它会直接告诉你「都有记录,不用探」,不出站。

改这个解析器的时候注意:**换掉磁盘上的文件不等于换掉运行中的行为**。Node 在启动时就把模块读进内存了,`docker cp` 进去之后不重启,跑的还是旧解析器 —— 这次就是这么被误导过一次:补丁部署完点了「补探能力」,盘上刚修正的 262144 又被旧代码写回 1500001。重启之后同一条路径才探出 262144。

### OpenAI 协议

```bash
curl http://127.0.0.1:9527/v1/chat/completions \
  -H "Authorization: Bearer <你的 Key>" \
  -H "content-type: application/json" \
  -d '{"model":"big-pickle","messages":[{"role":"user","content":"hi"}]}'
```

Cherry Studio / Chatbox / LobeChat / 任何填得了 Base URL 的客户端,照常填 `http://127.0.0.1:9527/v1` + Key。

### OpenAI Responses 协议

```bash
curl http://127.0.0.1:9527/v1/responses \
  -H "Authorization: Bearer <你的 Key>" \
  -H "content-type: application/json" \
  -d '{"model":"big-pickle","input":[{"role":"user","content":[{"type":"input_text","text":"hi"}]}]}'
```

按模型的原生协议选择上游腿：原生 Responses 模型保持原路径；原生 Chat 模型由网关把 Responses 请求转成 Chat，再把真实 Chat 流转换为 Responses 事件或非流式对象。客户端的 `/v1` 基址和 Bearer Key 不变。支持 `instructions`、字符串或数组 `input`、文本与推理、函数调用及结果、图片和可等价表达的结构化输出；保留 `call_id`、客户端工具名和 usage。

转换边界：

- **`input` 支持字符串和数组。** 原生 Responses 上游需要数组，网关会先包装字符串；Chat 上游则转换成消息历史。工具续轮把上一轮的 `output` 和对应 `function_call_output` 放回 `input`，连续的 assistant 文本、推理与并行调用合成同一轮，工具结果紧跟对应调用。
- **不伪造服务端会话。** Chat 上游无法等价支持 `previous_response_id`、`conversation`、内建工具或后台存储等 Responses 状态，出站前明确回 400；客户端须提交完整历史。原生 Responses 模型不受这层 Chat 转换限制。
- **流式与非流式使用同一转换器。** 流式生成 Responses 生命周期、文本、推理和函数参数增量，非流式收齐同样的事件后返回对象。别名函数名拼完整后才还原；有歧义的别名调用等待真实 `finish_reason` 再公布名称，其它输出继续增量下发。截断或失败不伪造 `response.completed`。
- **原生 Responses 杂块仍过滤。** 少数上游会在 Responses 收尾漏出 Chat chunk，网关不把这种异协议块交给严格客户端；其中可用的 usage 仍参与统计。

### System One 协议(jev 分类器)

```bash
curl http://127.0.0.1:9527/v1/systemone \
  -H "Authorization: Bearer <你的 Key>" \
  -H "content-type: application/json" \
  -d '{"model":"jev-1.13-free","state":"Help! My payouts have been failing for 3 days.","questions":{"urgent":{"type":"noul","instructions":"Does this convey urgency?"}}}'
```

`jev-1.13-free` 是 TypeSafe 的 System One **分类器,不是对话模型**:请求给一段 `state` 和若干带类型的 `questions`(`noul` 是非题回概率、`choice` 单选回分布、`score` 按刻度打分),回每个问题的答案,形状见 [TypeSafe API 文档](https://docs.typesafe.ai/api.md)。拿它打 `/v1/chat/completions` / `/v1/responses` / `/v1/messages` 会在出站前回 400 指明入口 —— 上游那几条路对它回 `ModelProtocolUnsupported` 或 500,而把对话包装成分类问题只能替客户端猜 questions。

这条是**纯透传**:body 原样上行(只剥掉 `stream:false`,上游对 body 里出现 `stream` 一律 400;`stream:true` 当场拒,它没有流式),成功体 `{model, answers, usage, cost}` 原样回。节点轮换、准入身份头和 chat 共用;免费层准入闸不过 —— 塞进去的 stream/tools 反而换 400,实测不带也 200。

模型按 id 认(`jev-` 前缀):opencode 的两份能力目录都不收它,唯一的权威来源是 zen 文档的端点表。可用性探针改发一个最小的 `noul` 问题;能力探测(上下文 / 输出上限 / 思考强度)直接跳过它 —— 分类器没有这几个维度,拿 chat 探针去问只会把协议错误记成假记录。

### Anthropic 协议(Claude Code、Cline)

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:9527
export ANTHROPIC_AUTH_TOKEN=<你的 Key>
claude
```

`Authorization: Bearer` 和 `x-api-key` 两个头都认 —— Anthropic 的 SDK 只发后者,只认 Bearer 的话客户端会收到 401,然后把它显示成「模型不存在或你没有权限」,排查方向直接被带偏。

### 中间套了 CLIProxyAPI 的话

链路是 `Claude Code → CLIProxyAPI → 本网关` 时,思考强度会在中间那一跳被改掉:面板上显示的永远是 `high`,哪怕客户端选的是 `max`。

原因在 cpa 的配置默认值。`openai-compatibility` 渠道的模型如果没写 `thinking`,cpa 给它的档位表就是 `["low", "medium", "high"]`(见 cpa 的 `config.example.yaml`:*omit to default to levels ["low","medium","high"]*);它的 `clampLevel` 会把**不在这张表里**的档位夹到表内最接近的一档,`max` 最近的邻居就是 `high`。低档能正常透传就是这个道理 —— `low` 本来就在表里,压根不走夹取那条分支。

在 cpa 的 `config.yaml` 里给这个模型显式声明档位表:

```yaml
openai-compatibility:
  - name: "zen2api"
    base-url: "https://你的网关地址/v1"
    api-key-entries:
      - api-key: "<网关的 Key>"
    models:
      - name: "deepseek-v4-flash-free"
        alias: "deepseek-v4-flash-free"
        thinking:
          levels: ["low", "medium", "high", "max"]
```

两个坑:

- **`base-url` 必须带 `/v1`。** 少了它 cpa 打的是 `/chat/completions`,那不是 API 路径。本网关对页面路径上的非 GET 请求一律回 404 JSON 就是为了让这个错当场看得出来 —— 早先那版会 302 到登录页,cpa 跟着跳转拿到 200 + 一坨登录页 HTML,当成模型的回答转给了客户端。
- **别往 `levels` 里加 `xhigh`。** 上游对 DS4F 只认 `high` 和 `max`,`xhigh` 会被直接丢掉、退回默认档。网关自己会把 `xhigh` 折成该模型的最高档,但那只发生在 Anthropic 入站那条路上;cpa 是拿 `reasoning_effort` 直接打 OpenAI 路由的,折不到。

### 路由表

| 路由 | 协议 | 说明 |
| --- | --- | --- |
| `POST /v1/chat/completions` | OpenAI | 流式/非流式都支持,流式原样透传 |
| `POST /v1/responses` | OpenAI Responses | 流式/非流式都支持；原生 Responses 保持原路，Chat 模型走反向桥；无法等价表达的 Chat 请求在出站前 400 |
| `POST /v1/systemone` | TypeSafe System One | jev 分类器,纯透传,只支持非流式;对话模型打这里、jev 打对话入口都在出站前 400 |
| `POST /v1/messages` | Anthropic | 非流式转形状,流式实时翻译成 Messages 事件 |
| `POST /v1/messages/count_tokens` | Anthropic | 估算值。缺这个路由 Claude Code 开工前就退出了 |
| `GET /v1/models` | 两者 | |
| `GET /health` | | 不需要鉴权,给探针用 |

错误体按路由前缀分方言:`/v1/messages` 出 `{"type":"error","error":{"type":...}}`,其余出 OpenAI 的 `{"error":{...}}`。SDK 读的就是这个字段,给错形状它会当成解析失败。`/health` 返回 `{ok, models, paused}`,其中 `models` 是当前免费模型数量。

---

## 它替你处理的事

**429 轮换。** 免费额度按出口 IP 计。撞到 429 就把当前出口冷却、换下一个重发,对客户端是透明的。冷却时长优先读上游的 `Retry-After`(日额度用尽时指向 UTC 零点),没给就兜底 60 秒。刚解冻的节点不凭低延迟插回队首,而是排到「还没被限流过的节点」后面 —— 早先这里兜底给到 5 分钟,是因为解冻的节点会立刻凭最低延迟被重新选中、原地打回 429 空转刷屏;改成排队尾根治了这个,兜底就收回到 60 秒,其余节点也全不行时还能较快轮回来重试。最多换 6 次节点。

**冷却优先认实测出口 IP。** provider 的 `server` 只是回退身份，不保证就是公网出口。独立探测测到真实 IP 后，同 IP 的节点共享供应商组冷却；确认是不同 IP 的节点独立判断。未测节点按 provider 的已知冷却出口保守避让，测出不同 IP 后再独立放行；IP、provider 与节点名使用不同身份域，不会因为字符串相同而误合并。节点改名、订阅暂时移除或测得新 IP，都不会把旧 IP 的有效冷却丢掉或错误迁到新 IP。

**冷却表独立持久化。** `/data/cooldowns.json` 原子保存绝对到期时间、Retry-After、供应商组、故障原因、排序标记和节点/provider/IP 关联，不受 `persistUsage` 开关影响。重启恢复原期限，不重新计时；过期自然放行，确认成功只清对应出口与分组，手动重置会同步清盘。当前候选的排序标记保留；不再直接引用的历史出口在冷却失效、排序标记满 24 小时后自动回收，不依赖新的策略或身份变化触发老化。坏文件只告警，不阻止启动。

**延迟排序 + 剔除死节点。** 订阅解析完自动测一遍延迟,快的排前面,轮换就按这个顺序取(刚限流过的节点例外 —— 它会被压到序列末尾,见上「429 轮换」)。测不通的直接不进候选表 —— 不然一个已经下线的节点每次轮换都要先浪费一次超时。测延迟这件事整包交给内核:一次 `GET /group/zen-pool/delay`,内核内部并发测完再一起回,我们不逐个节点发请求(节点名里常带 `/`,例如 `FI_1|1.4MB/s`,拼进 URL 路径要靠转义活着回来)。探针默认打上游 `https://opencode.ai/` 而不是 `gstatic.com/generate_204`:实测后者会让一份 17 节点的订阅**全部**测不通,而同一批节点跑上游是好的 —— 机场封 80 端口、劫持 Google 域名都很常见,探针自己到不了就会把能用的节点全判死。两条保险:全部节点都测不通时**不剔除任何一个**(那更像是探针地址本身不可达,不能让网关自己瘫掉),没测过的节点也不算死。面板上每个节点显示实测延迟,「测延迟」按钮可以随时重测;全灭时日志会把内核给的原因(比如 `all proxies timeout`)一起打出来,换探针地址就用 `NODE_TEST_URL`。

**Zen 与中立目标分开测。** 原有 `/group/zen-pool/delay` 继续决定健康排序；另起独立 mihomo 进程定向测中立站和公网 IP，不修改正在服务的 selector。每批至多 3 个节点，事实缓存 10 分钟；中立站失败只显示「未知」，不会把 Zen 可达的节点剔除。面板分别显示 Zen 延迟、中立延迟、已测 IP 和独立出口数，并区分「限流」「暂避」「上游错误」「拒连」。站点可达不等于模型可用。

「测节点/出口」按钮位于节点池标题行右侧，按钮内显示「进度 已测数/总数」；不再另起测量时间、已测出口数或 IP 数摘要行。测量期间进度继续刷新，结束后保留覆盖进度。

**推理内容。** `deepseek-v4-flash-free` 这类模型会先吐几分钟 `reasoning_content` 再出正文(实测「写个 SVG 动画」的提问 200 秒内推理 68000 字、正文 0 字)。这个字段在 OpenAI 协议里原样透传;在 Anthropic 协议里翻译成 `thinking` 块 —— 丢掉它的话客户端在 `message_start` 之后几分钟收不到任何事件,看起来就是卡死,而上游其实一直在吐。客户端下一轮带回 assistant `thinking` 时,网关会把原推理文本还原为 `reasoning_content` 交还上游,避免 thinking 模式报“必须回传 reasoning_content”。`SHOW_THINKING=0` 可以关掉,那时推理内容整段丢弃,也不占块序号。

**思考强度透传。** 没有开关也没有配置项,客户端发什么就折算成什么。四种写法都认:`reasoning_effort`(OpenAI 顶层)、`reasoning.effort`、`output_config.effort`(Anthropic 现行 —— 新版 Claude Code 发的是这个)、`thinking.budget_tokens`(Anthropic 旧写法,按 2048 / 8000 / 16000 折成 low / medium / high,再往上是这个模型的最高档)。`thinking.type` 是 `adaptive` 时按开了思考算。

**上游认得的档位每个模型不一样,所以按模型折。** 上游对认不出的档位**多数是直接丢字段**而不是降级,于是「发了个它不认的档位」和「什么都没发」结果一样 —— 这正是 `xhigh` 一度静默失效的原因(那是 Claude Code 的默认档)。网关的做法是把 `xhigh` 和 `max` 都视为「要最高档」,再按模型落地:`deepseek-v4-flash-free` 和 `x-preview-f-free` 折成 `max`,其余模型折成 `high`。客户端明确关掉思考时不发这个字段 —— DS4F 关不掉思考,硬塞个最低档也会被上游丢掉,不如让它走默认,至少行为可预期。面板的调用日志里逐条记着实际发出去的档位,`—` 表示没发这个字段(随上游默认),和显式发了 `high` 是两回事。

**但「丢字段」不是所有模型的行为,`x-preview-f-free` 会直接 400。** 它的校验器把话说得很明白:`[1210] This model always engages in thinking and cannot be disabled; please use low, high, or max`。也就是 `minimal` / `medium` / `xhigh` 三种写法原样发过去整条请求就失败 —— 而 `medium` 正是 Claude Code 敲 `think`(`budget_tokens` 4000)翻出来的那一档,也是不少 OpenAI 客户端的默认值。所以对这类模型网关会把档位**夹到它认的那几档,就近向上**:`minimal`→`low`、`medium`→`high`、`xhigh`/`max`→`max`。向上而不是向下,是因为少想一档的后果是「用户明确要求思考却没思考」(这个模型 `low` 实测 `reasoning_tokens` 是 0),多想一档只是慢一点;六档映到三档时这也正好成比例。这几档不是写死的 —— 是探出来的(记录在 `/data/capabilities.json`,见「能力探测」),判据就是上游那句错误原文里点了哪几个档位词。2026-08-21 实测这三档确实有区别:`low` → `reasoning_tokens` 0、`high` → 6、`max` → 37。

**超时预算按请求体积放大。** 小请求的基线还是 75 秒(从进来到回复),剩不到 8 秒就不再开新尝试,直接回 504;每多 1 MiB 请求体就多给 75 秒,顶到 420 秒。单次出站的静默上限同理,45 秒起、每 MiB 加 45 秒、顶到 240 秒。不这么管的话,轮换会把单个请求拖到客户端自己超时,报出来的错和真实原因完全对不上。**流式没有总时长上限** —— 只要上游还在吐(哪怕吐的全是推理),就一直转发;彻底没动静 120 秒才判定断流。

放大是为了装下 1M 级上下文。实测直连上游,1M 上下文的 prefill 要 28–129 秒(同一尺寸重跑能差三倍),网关这侧还得先把 4–5 MiB 的请求体经节点传上去 —— 原来固定 75 秒的预算连 256K 都过不去。按体积连续放大而不是分档,免得 0.9 MiB 这种刚好卡在档位下面一点的请求白等。体积只是 prefill 时间的代理指标(没真去数 token),够 1Mi 用。流式其实不吃这个亏:实测 1M 请求的首字节也只要 7.5 秒(上游不等 prefill 走完才开口),真正被固定预算掐死的是非流式。

**超时不再报成「节点全挂」。** 三处终态失败合到一个出口,说法由实际计数决定:有过超时就回 504 并说明试了几次,请求体到 1 MiB 以上时额外点明「大上下文 prefill 慢,不是节点故障」;全被限流回 429;真的一个节点都切不动才回 503 `all_nodes_unavailable`。原来那句 `Tried 6 nodes, all unavailable` 根本不看原因 —— 256K 的请求就能触发它,而那批节点是好的,照着这句话去查节点是白费功夫。

**首帧和终态按协议认。** 只收到心跳、角色或生命周期事件时，不向客户端提交 HTTP 200；完整合法的业务帧或合法空终态才打开响应。首个错误或畸形工具帧仍可走输出前的错误处理；开始业务输出后不重新生成。Chat 必须有真实 `finish_reason`，单独 `[DONE]` 不算完成；Responses 的 completed/incomplete 与 failed 分开，裸 EOF 和截断不记成功。UTF-8 和 SSE 帧跨网络分块不会被拆坏，心跳只插在完整帧边界。

**流开始后不重试。** 开始业务输出后换节点重发会把两半生成拼到一起，所以后续传输错误和协议错误只按客户端方言报错并收尾，不重试、不记成功。Anthropic 关闭未结束的内容块并完成协议收尾；Chat 和 Responses 不补造正常成功标记。非流式先由网关完整收流，转换失败仍可返回真正的 HTTP 错误，而不是成功外壳。

**工具调用参数增量。** 流式的 tool 参数用 `input_json_delta` 一段段发。参考实现里是在第一个分片就 start+stop,长参数会被截断。

**工具结果里的图片不再静默丢失。** Chat `tool`、Anthropic `tool_result` 和 Responses `function_call_output` 中的图片、文档与文本保序转换，保留调用关联；需要后继 user 视觉项时，先配齐同组并行工具结果再追加附件。只有元数据明确为纯文本的模型才继续使用可见占位，模态未知不擅自丢附件。

---

## 面板

单页,不分标签,从上到下:

| 区块 | 内容 |
| --- | --- |
| 页头 | 只有身份和版本:构建 hash + 「检查更新」+ 仓库入口 + 「退出登录」 |
| 概览 | 一张卡里 2×2 四格:左上 Token 消耗(输入·输出·推理·缓存读·缓存写)、右上 模型统计(各模型 token 用量)、左下 客户端请求总数(成功·失败·成功率)、右下 运行时长(最后请求) |
| 接入 | 一排四颗按钮(「OpenAI 地址」/「Anthropic 地址」/「复制 Key」/「重置 Key」)，下面是可用模型；长名字可横向滚动，`exo-free[1M]` 后紧邻一个无文字的 Claude 后端锁定开关 |
| 配置 | 订阅地址（右端一个节点状态灯）+ 自动更新订阅周期 + 「保存并应用」+ 固定显示当前 OpenCode UA 版本，以及「重启内核」「同步模型」「补探能力」「清零统计」「手动重置」 |
| 运行日志 | 内核和网关的实时日志 |
| 节点池 | 现有 Zen 健康排序、当前节点、按供应商组显示的冷却原因和剩余时间；另列独立中立延迟、真实出口 IP、已测数量与独立 IP 数；未知测量不冒充节点故障 |
| 调用日志 | 默认折叠，逐个客户端请求显示最终结果、请求号、总耗时和真实尝试数；展开可看每次成功、失败、取消或重抽的节点、HTTP 状态、耗时与脱敏错误摘要 |

**exo-free 后端锁定。** 实时免费清单当前不含 `exo-free`。旧的后端识别与重抽逻辑仍保留兼容，但 OpenCode v2 的 `/inference/v1` 请求不会发送已被上游拒绝的 `x-opencode-request`，所以它不为新入口伪造旧 v1 身份。

**OpenCode v2 免费层兼容（2026-10-14）。** 上游把免费 Chat/Responses 推理从 `/zen/v1` 搬到 `/inference/v1`：分别走 `/inference/v1/chat/completions`、`/inference/v1/responses`；本项目的 Anthropic `/v1/messages` 仍按客户端方言翻成这两条上游腿，`/zen/v1/models` 仍是模型清单入口。

- 出站 UA 保持已实测的 `opencode/latest/<发行版本>/cli` 形状，版本号从[官方 CLI 发行接口](https://opencode.ai/update/api/latest/cli/npm)同步，不使用 GitHub 的 v1 release tag。完整四段、major ≥ 2 且不旧于同步版本的下游 UA 仍可转发；旧客户端不能把网关拉回旧版本。
- 免费推理发送 `Authorization: Bearer public`、`x-opencode-session`、`x-opencode-session-id`、`x-session-affinity`、`x-session-id`；不发送 `x-opencode-request`。UA 与会话头始终发送，旧 `opencodeIdentityHeaders` API 字段只控制可选的 client/project 头。
- 合成 session 的 12 位 hex 使用官方降序编码 `~(timeMs * 0x1000 + 1)`；从客户端会话提示派生时只取 36 位时间字段，避免把哈希熵塞进毫秒内计数器而触发 `FreeTierError`。
- 免费请求必须带 OpenCode v2 的精确 `read` 与 `shell` 工具定义。网关不再发送旧的五工具 stub；缺少的定义按 CLI 原文补上，并在 system/instructions 中标记为 placeholder，避免模型真的调用网关没有实现的工具。
- 客户端自己的工具原样保留。若客户端正好把不同 schema 的工具命名为 `read` 或 `shell`，出站临时改成 `read_client` / `shell_client`（重名递增），历史调用和响应再恢复原名；`Read`、`Bash` 等大小写不同的名字不改。
- 版本成功记录原子写入 `/data/opencode-version.json`，启动先读缓存，到期后后台同步，之后每 24 小时检查一次，不依赖面板轮询或客户端请求。网络失败、非法元数据或版本倒退都保留最近成功值；完全没有有效缓存时使用已验证的 `2.0.29`。真实请求与可用性、能力探针共用当前版本，单次请求跨节点重试时身份不变；身份头开关不影响版本同步。`/api/status` 的 `opencodeVersion` 与 `[opencode-version]` 日志提供版本、检查时间和最近错误。
- 2026-10-16 在 API 容器内以官方发行二进制 `2.0.31` 抓取 UA，并用更新后的隔离网关验证：入站 `2.0.1` 被升级为 `2.0.31`，`/v1/messages` 返回 HTTP 200 和完整 `PONG`。自动同步只更新版本数字；若上游将来更改 UA 形状、会话规则或工具校验，仍需升级网关代码，不能靠更换版本数字解决。

这几项是免费层准入形状，不是普通协议转换。客户端非流式请求仍由网关收上游流后拼回 JSON；Chat、Responses、Anthropic 三种入口共用同一套 v2 身份与工具处理。上游返回真实配额/供应商错误时，网关仍按错误原文分类，不把 `200` 外壳或 `403 FreeTierError` 误记成成功。

**登录。** 没登录时任何页面都会被送到 `/login`,填 `PANEL_USER` / `PANEL_PASS`。这是面板自己的一页,不是浏览器那个凭据弹框 —— 弹框是 401 响应里的 `WWW-Authenticate` 头带出来的,样式不可控、密码错了给不出自己的提示、想退出只能关浏览器。现在服务端一律不发这个头,所以浏览器不再弹框。

登录成功给一张 HttpOnly 会话 cookie,有效期 12 小时,存在网关进程内存里 —— 容器重启要重新登录一次。页头最右的 ⇥ 是退出登录,当场作废那张 cookie。凭据连错 10 次会锁 1 分钟(按次数不按 IP,反代后面 IP 全一样),已登录的会话不受影响,别人在外面爆破锁不掉你手上这张。

状态灯和那三个按钮都在「配置」卡里,和订阅地址挨着 —— 看一眼状态然后动手是一回事,分在页头和卡片两个地方要来回扫视。灯只剩一个(节点数):网关能打开这个面板就说明活着,内核版本看一眼就够、不会变,真会动的只有节点数。内核挂了的时候借它报「内核未运行」—— 只显示「无节点」的话,看不出是订阅没填还是内核死了,这两件事的处置完全不同。

监听端口面板上看不到也改不了:容器对外端口由 compose 的 `ports` 决定,进程改绑只会让映射指向一个没人听的地方。要换端口改 compose(`/api/config` 也会忽略提交上来的 `port`,直接 POST 绕不过去)。

API Key 屏幕上永远是掩码,只有「重置」和「复制」两个动作 —— 复制的是真值。没有「显示」:留一串完整 key 在屏幕上没什么用,而它就在「复制」旁边。「重置」会先问一次,正在用旧 Key 的客户端会立刻收到 401。

订阅地址改完点保存**当场生效**：地址变了就重写 mihomo 配置并重启内核（期间 `/v1/*` 短暂返回 503，客户端重试即可），没变就只让内核重新拉一遍 provider。刷完节点接着自动测一遍延迟，保存后的提示会告诉你刷到几个、其中几个可用。

**自动更新订阅。** 单位为小时，默认每 1 小时更新一次；填 `0` 可关闭。每次自动更新完成后都会自动测一遍延迟。修改周期只重排下一次更新时间，不重启 mihomo。周期刷新统一归网关调度,生成的 mihomo 配置里 provider 的 `interval` 是 `0` —— 让内核自己也按周期拉一次的话,那次更新网关无从感知,刷完的新节点表就不会跟着测速。

**稳定 session 标识。** 网关优先读取 Claude Code 的 `x-claude-code-session-id`，也兼容客户端显式提供的其它会话 ID；但发给上游的 `x-opencode-session` 必须符合 `ses_<12 位小写 hex><14 位数字或字母>`。合法的 OpenCode session 原样保留，UUID 或自定义字符串会按原值稳定哈希成合法格式；都没有时按第一条 user 内容生成。这样同一对话增长后 ID 不变，换节点重试也复用同一个 ID。它只用于让上游有机会保持会话和 prompt cache，不增加额度，也不提供并发隔离。

**多 lane 并发分摊。** 平时单出口、一个节点用到 429 才换；主 lane 已有请求时，按需拉起独立 mihomo 进程和端口的子 lane，使用另一个未占用节点。每个子 lane 使用自己的订阅快照，重试只在自己的节点表中选择未试过、未冷却的候选，避免主子节点名字不同而反复回退到失败首节点；切换成功后更新实际绑定，后续请求可复用成功节点。429/封域冷却由 Gateway 统一维护，子 lane 成功不覆盖主 lane 的锁定或持久化节点。每条子 lane 同时只接一个请求；空闲满 5 分钟自动回收，退出时全部关闭。多 lane 会同时消耗多个出口 IP 的额度，保持低并发即可继续使用单出口。

**OpenCode UA。** 面板固定显示当前同步版本，不提供关闭开关。网关始终发送可信的 `User-Agent` 和合法格式的稳定 `x-opencode-session`；版本从官方 CLI 发行接口每日同步，网络失败时保留最近成功值或已验证的默认版本。客户端带来的 UUID 或自定义 session 会先稳定哈希成上游要求的格式。

**「模型统计」和「调用日志」口径分开。** 概览按客户端请求累计 token；节点桶按实际上游尝试计数。每次重试不会额外增加客户端请求数，失败或取消不冒充成功，首字和耗时均值只取成功样本。最近尝试 `calls` 与最终请求摘要 `requests` 各保留 200 条，早期明细移出窗口不影响累计统计；两份窗口分别截断时仍保留真实尝试总数，不伪造缺失节点或耗时。

**失败与重试链可以直接查。** 进入推理处理的请求返回 `X-Request-ID`，面板按该 ID 关联全部保留尝试，最终客户端结果不被某次上游成功覆盖；无出站尝试的失败也有请求记录。每次尝试保留序号、节点、模型、实际强度、结果、HTTP 状态、首字、耗时和用量。错误摘要有界且脱敏，不保存请求/响应正文、Key 或订阅凭据；旧成功明细没有请求号时明确显示为历史记录，不编造关联。

「清零统计」把请求数、Token 用量、按模型分项、按节点尝试统计和调用日志全部归零并落盘,不可恢复,所以会先问一次。它不动订阅和 Key。

**构建 hash 和检查更新。** 页头右端那个等宽小牌子是当前镜像的构建 commit(点它跳到那次提交),旁边 ⟳ 拿它和 GitHub 上 `beta` 的 HEAD 比一下。**只在你点的时候才出站** —— 匿名 GitHub API 每小时 60 次,自动轮询会烧光,而且它一小时也变不了几次。有新版本时牌子变琥珀色,`docker compose pull && docker compose up -d` 之后牌子自己恢复(比的是两个 hash,不是那次检查的结果)。

牌子显示 `unknown` 说明这个镜像构建时没注入 `GIT_COMMIT` —— 自己 `docker build` 不带 `--build-arg GIT_COMMIT=$(git rev-parse HEAD)` 就会这样。此时不会报「有新版本」:本地 hash 不知道,新旧无从判断,报了只是让人白拉一次镜像。

**日志。** 分四级(信息 / 成功 / 警告 / 错误),面板上按级别筛。方括号里是发出这行的子系统,常见的:`[gateway]` `[mihomo]` `[chat]` `[stream]` `[429]`(限流换节点)`[delay]`(测延迟)`[update]`(检查更新)`[config]` `[reset]`。面板里只留最近 500 条,在内存里 —— 容器重启就空了。同样的内容也全写了 stdout,要翻更早的用 `docker compose logs -f`。

### 数据

都在命名卷 `ciallo-data`(容器内 `/data`):

| 文件 | 内容 |
| --- | --- |
| `config.json` | 订阅地址、API Key、端口、`opencodeIdentityHeaders`、`persistUsage`、`pinClaudeBackend` 开关和 `subscriptionUpdateHours` 周期。**含机场 token**，别往外发 |
| `usage.json` | 客户端累计统计(`total` / `byDay` / `byModel`)、节点尝试统计(`byNode`)、最近尝试(`calls`)和最终请求摘要(`requests`)，两个明细窗口各 200 条；仅 `persistUsage` 开启时持久化 |
| `cooldowns.json` | 独立于用量开关的出口冷却、绝对到期时间、供应商组、故障原因、排序历史及节点/provider/实测 IP 关联；重启不延长期限 |
| `capabilities.json` | 每个模型的实测记录:上下文上限、判据(`validator` / `bracket` / `truncate`)、`max_tokens` 上限、认的思考强度档位。按 id 存,只增不删 —— 下线的模型回来了直接复用。「清零统计」不动它 |
| *(内存)* `modelAvailability` | 模型可用性探测结果。每 6 小时刷新,重启后按当前出口重新确认,不写入用量统计。上游确认成功的真实请求也会把对应模型写回 `available` |
| `models.dev.json` | models.dev 的补充元数据缓存,24 小时 TTL。成本、模态、协议等可供客户端参考；上下文容量仍以 `capabilities.json` 的实测值为准 |
| `mihomo-zen.yaml` | 生成的内核配置,每次改订阅地址重写 |
| `mihomo-data/` | 内核自己的缓存(provider 快照、GeoIP) |
| `last-node.txt` | 主 lane 上次确认成功的节点；失败或子 lane 的结果不覆盖它，恢复时仍遵守现有冷却 |

用命名卷不用 `./data` 绑挂,是因为容器里以 uid 1000 运行,宿主目录属主对不上会 permission denied;真要绑挂先 `mkdir data && sudo chown 1000:1000 data`。

### 面板 API

面板自己就用这些,想脚本化(比如把状态接到自己的监控上)直接打:

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/api/status` | GET | 网关/内核状态、实时免费模型清单、模型可用性(`modelAvailability`)、探测调度(`modelAvailabilityStatus`)、模型冷却(`modelCooldowns`)、上下文上限(`ctx`)、实测能力(`modelCapabilities`)、可锁定后端(`pinnableBackends`)、锁定开关(`pinClaudeBackend`)、构建标识 |
| `/api/config` | GET · POST | 读取/保存订阅地址、`opencodeIdentityHeaders`、`persistUsage`、`pinClaudeBackend` 与 `subscriptionUpdateHours`；明确提交订阅时当场应用，只切开关不碰内核。`port` 只读，提交了也忽略 |
| `/api/nodes` | GET | 排过序的节点、剔除名单、Zen 延迟、带分组/原因/出口的冷却及当前节点；`egress` 含定向测量事实、已测数量、独立 IP 数与 `byNode` |
| `/api/nodes/test` | POST | 立刻测一遍延迟,回 `{tested, alive, fastest}` |
| `/api/models/sync` | POST | 立刻拉一遍免费清单(直连优先),回 `{models, added, gone}`。两条网络路径都不通时回 500,清单保持原样 |
| `/api/models/probe` | POST | 给清单里还没有能力记录的模型探一遍,回 `{probed, skipped, note, ctx, running}`。都有记录时 `note` 是 `nothing-missing`,一次都不出站;超过 20 秒没探完就先回 `running: true`,探测在后台继续 |
| `/api/usage` | GET | 客户端统计、`byNode` 尝试统计、`calls` 最近尝试与 `requests` 最终请求摘要；`/api/usage/reset` (POST) 全部清零 |
| `/api/regen-key` | POST | 换 API Key,不重启就生效 |
| `/api/restart` | POST | 重启内核 |
| `/api/reset` | POST | 清冷却 + 忘掉上次节点 + 重写配置 + 重启内核 |
| `/api/check-update` | POST | 跟 GitHub 上的 `GITHUB_TRACK_REF` 比一次 |
| `/api/logs` | GET | SSE。首帧是历史快照(数组),之后每条一帧 |
| `/api/login` | POST | `{user, pass}`,成功回一张会话 cookie。登录页用的就是它 |
| `/api/logout` | POST | 作废当前会话 cookie |

鉴权两条路,同一套凭据:浏览器走登录页拿会话 cookie,脚本照旧直接带 `Authorization: Basic`(不会收到 challenge,也就不会有弹框)。没凭据时 `/api/*` 回 `401 {"error":"未登录"}`,页面则 302 到 `/login`。有副作用的都是 POST,别指望 GET 能触发。探活用 `/health`,那个不要鉴权。

---

## 开发

零 npm 依赖,Node ≥ 20。代码全在 `beta` 分支:

```bash
git clone -b beta https://github.com/MurasameCyan/Ciallo-Zen-Proxy.git
cd Ciallo-Zen-Proxy

npm test              # 前端、Anthropic、用量/重试链、双向 Responses、SSE 边界、出口与冷却恢复
                      # + 能力/目录/身份版本、路由鉴权和整条链路
npm run preview       # 不起内核,只看 UI
npm start             # 完整跑,需要 /data 可写

npm run verify:tunnel     # TLS-over-CONNECT 出站(要 openssl)
npm run verify:upstream   # 出站是否真经代理(比对出口 IP),PROXY_PORT=2080 驱动
npm run verify:api        # 打真实部署,BASE=http://... KEY=... 两个环境变量驱动
npm run verify:logout     # 无头浏览器走一遍登录/退出登录(要 Chrome 或 Edge)
```

`verify:logout` 要浏览器是因为那条路只有真浏览器能验:按钮里套着 `<svg>`,点击落在子元素上;而「退出登录没反应」的成因是浏览器把弹框时代收到的 Basic 凭据缓存在 origin 上一直主动带,退出后又被 302 回面板 —— 服务端删不掉那份缓存,只能不让它开门(见 `server/index.mjs` 的鉴权分支)。脚本用 CDP 的 `Network.setExtraHTTPHeaders` 把那份缓存模拟出来。同一套零依赖 CDP 客户端还驱动 `scripts/shot.mjs`(截图 + 布局体检)。

`server/anthropic.mjs` 是纯函数 + 一个可注入回调的 `AnthropicStream`,所以整个转换层不用起 HTTP 就能断言。前端同一个思路:`web/core.js` 只放算出来的东西(节点排序、Key 掩码、时长格式化、新旧判断),`web/app.js` 只负责把结果贴到 DOM 上 —— 所以 `test/check.mjs` 不用浏览器就能把那些规则钉住。`server/capabilities.mjs` 也是这个切法:发请求的部分收在一个可注入的 `post` 回调后面,解析错误原文的三个函数(`parseEfforts` / `parseMaxOut` / `parseCtx`)单独导出 —— 花钱的是发请求,会错的是解析,所以 `test/capabilities.mjs` 一次都不出站就能把探测的每条分支跑一遍。

`test/e2e.mjs` 的模型清单和推理响应都来自测试数据：后台清单刷新不访问真实上游，也不会因上游模型下线而移除用例模型或触发额外探测。

`test/server.mjs` 的默认 HTTP(S) 与 fetch 传输只允许环回地址；外部上游必须由用例显式注入。即使在已有 mihomo 的容器里运行自检，也不会意外把能力探测发到真实免费模型上。真实出站验证使用上面的 `verify:*` 脚本，与自检分开执行。

```
server/
  index.mjs      路由、静态文件、面板 API
  auth.mjs       凭据校验、会话表、失败限速(纯逻辑,不碰 http)
  gateway.mjs    上游转发、节点轮换、方言分发(OPENAI / ANTHROPIC / RESPONSES)
  model-availability.mjs 低成本模型连通性探测与六小时调度
  anthropic.mjs  Messages ⇄ Chat Completions 转换 + SSE 状态机
  capabilities.mjs 模型能力实测记录:探测、解析错误原文、落盘复用
  mihomo.mjs     内核进程和控制端口
  config.mjs     配置读写、mihomo yaml 生成
  build.mjs      构建 hash(环境变量 → git)、跟 GitHub 比新旧
```

加协议就多写一个 dialect 对象(`toUpstream` / `validate` / `respond` / `sink` / `fail`,外加上游 `path` 和 `applyEffort`),轮换和冷却那套逻辑不用动。

---

## 镜像

`ghcr.io/murasamecyan/ciallo-zen-proxy:latest`,多架构(`linux/amd64` + `linux/arm64`)。

CI 先跑测试和 TLS 出站验证，再构建镜像；容器烟测检查健康、鉴权、构建标识及协议接口。免费模型清单跟随上游变化，不要求某个固定模型必须存在。

| 标签 | 来源 |
| --- | --- |
| `latest` | `beta` 的每次推送 |
| `beta` | 同上,同一份 digest |
| `sha-<短 sha>` | 每次构建都留一个,用来回滚 |
| `1.2` / `1.2.3` | 打 `v*` 标签时出 |

**自己构建**记得带 `--build-arg GIT_COMMIT=$(git rev-parse HEAD)`,不然面板上的构建 hash 是 `unknown`(CI 里传的是 `github.sha`)。

**`docker compose pull` 报 `unauthorized`?** 不是构建失败。GHCR 新建的包默认私有,而且**不跟随仓库可见性** —— 仓库公开了包照样是私有的。仓库 owner 打开
`https://github.com/users/MurasameCyan/packages/container/ciallo-zen-proxy/settings`
→ Danger Zone → Change visibility → Public,点一次,之后每次推送都继承。这个没有 API,只能手点。

**想手动重建?** 往 `beta` 推一个空提交(`git commit --allow-empty -m rebuild && git push`)。Actions 页面上没有「Run workflow」按钮 —— `workflow_dispatch` 要求 workflow 文件在**默认分支**上,而默认分支是只有 README 的 `main`。`push` 触发不受影响,它用的是被推分支上的那份文件。

---

## 说明

免费额度是 opencode 给的,别拿它跑压测。机场订阅里有你的 token,面板明文显示 —— 所以 `PANEL_PASS` 是必填项,不是建议项。
