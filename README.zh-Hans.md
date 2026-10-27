[English](./README.md) | [简体中文](./README.zh-Hans.md)

# PingAtlas

> [!WARNING]
> 本项目由 **Vibe Coding** 编写，尽管已经过人工审查，但无法保证 100% 可控且无缺陷，
> 使用前请自行评估风险。

PingAtlas 是一个基于 [Globalping](https://globalping.io) 的在线网络测试服务，运行在本项目自研的 Node.js + TypeScript 框架之上。提供 ping、traceroute、DNS、MTR、HTTP 测量控制台、实时结果查看、可选的 OpenID Connect 登录，并支持 PWA。

界面呈现**测试节点列表**与**测量结果详情**，不提供地图视图 —— 在中国大陆在线发布地图需要审图号。

## 功能

- **五种测量类型** —— `ping`、`traceroute`、`dns`、`mtr`、`http`，各自暴露上游 API 的完整选项（包数、协议、端口、IP 版本、查询类型、解析器、HTTP 方法/路径/查询串/请求头、超时等）
- **节点筛选** —— 自由填写的 `magic` 目标，以及大洲 / 国家 / 城市 / ASN / 网络 / 标签筛选，**默认 3 个节点**，并按当前模式的硬上限钳制（匿名 50、认证 500）
- **位置自动补全** —— 每个位置输入框都是 ARIA combobox，数据来自去重后的探针索引（`GET /api/probes`，不消耗 Globalping 额度）。匹配为模糊匹配，优先级依次为精确 > 前缀 > 包含 > **子序列**（例如输入 `Fuzho` 可匹配到 `Fuzhou`）；候选项展示节点数量，个人标签 `u-*` 降权，支持 ↑/↓/Enter/Esc 键盘操作与鼠标点选。索引依次缓存于内存、`localStorage`（24 小时 TTL）与浏览器 HTTP 缓存（`max-age=300`）
- **结果视图**：
  - 节点列表：每台 probe 一张卡片，含国家 / 城市 / ASN / 网络 / 标签
  - 逐节点详情：ping 的 RTT 柱状图与丢包率、traceroute / MTR 跳数、DNS 应答、HTTP 状态码 / 响应头 / 响应体预览 / 耗时分解 / TLS
  - 每台 probe 的原始输出可折叠展开
  - 测量进行中实时刷新进度，并结构化渲染上游报错
- **双通道请求**：
  - 浏览器**直连** `https://api.globalping.io`，使用访客自身的匿名额度（250/小时，按 IP 计），为默认通道
  - 本地额度用尽、或请求节点数超过 50 时，自动降级到本服务的 `/api/*` 代理，由后端注入 `GP_TOKEN`
  - 左下角同时展示两条额度条；服务端代币通道仅在登录后可用
- **仅支持 OpenID Connect 登录** —— 授权码流程 + S256 PKCE（`openid-client` v6），兼容 Keycloak，其他 IdP 可通过环境变量适配；显示登录用户名（`preferred_username`）
- **PWA** —— 提供 `manifest.webmanifest` 与带版本化应用外壳缓存的服务工作线程
- **国际化** —— 内置简体中文与英文；新增语言需要一个语言文件与一处注册
- **明暗主题** —— 跟随系统偏好，也可手动切换
- **响应式布局** —— 宽度 ≤620px 时结果表折叠为卡片式堆叠：长主机名换行，数值列保持单行，不产生横向滚动

## 额度策略

额度来源共有两处，前端为每次测量选择其中之一：

| 额度条 | Owner | 来源 | 说明 |
| --- | --- | --- | --- |
| 左 | `ip`（自己） | 浏览器直连 `GET {apiUrl}/v1/limits` | 按公网 IP 250/小时；轮询不消耗额度 |
| 右 | `user`（服务端代币） | 经本服务 `GET /api/limits` | 仅在登录且配置了 `GP_TOKEN` 时展示；可能额外返回 `credits.remaining` |

每次测量按以下顺序判定通道：

1. 直连 API 不可达 → 代理（否则提示「无可用额度通道」）
2. 本地额度 `remaining <= 0` → 代理
3. 请求节点数超过匿名上限（>50）→ 代理
4. 访客手动切换到代理额度条 → 代理
5. 其余情况 → 直连（本地额度）

其他行为：

- 本地额度有结余时，**默认走直连**。
- 本地额度由 **5 分钟心跳**刷新；当 `remaining` 归零时，会在上游给出的 `reset` 时间之后 2 秒精准复查一次。切回前台也会触发复查（30 秒节流）。
- 每次测量的响应都会用 `X-RateLimit-*` 响应头**就地更新**额度条，无需额外请求。
- **点击额度条**可强制切到代理通道；当本地额度重置时（表现为 `remaining` 由 0 变正），偏好会自动复位，并提示本地额度已恢复。

## 请求流向

```
浏览器 ── 本地额度有结余 ──────► {GP_API_URL}/v1/measurements       (直连，按 IP 匿名限额)
      │                          {GP_API_URL}/v1/measurements/{id}   (公开可读，不消耗额度)
      │
      └── 本地额度用尽 ────────► /api/measurements ─► {GP_API_URL}/…   (后端注入 GP_TOKEN)
          (请求节点数 >50、或直连 API 不可达时同样走此通道)
```

- `GET /api/config` 返回 `{ apiUrl, proxyAvailable, maxProbes: { direct, proxy } }`，供前端确定直连地址以及每种模式可申请的节点数。
- `GET /api/limits`、`POST /api/measurements`、`GET /api/measurements/:id` 原样透传上游响应（状态码与 JSON 一致）并透传限额头。`GP_TOKEN` 永不下发浏览器。
- `GET /api/probes` 是唯一不带代币访问上游的接口：它拉取一次 `GET /v1/probes`，把 5000+ 条记录折叠成去重索引（国家 / 地区 / 城市 / 网络 / 标签，92 KB JSON，`Cache-Control: public, max-age=300`，另有进程内 5 分钟缓存），供浏览器做自动补全。该接口不消耗 Globalping 额度。上游不可达时回退到过期副本；若不存在副本则返回 `502`，前端停用自动补全且不展示错误。
- 轮询按上游要求节流：上一次响应到达后等 500 ms，每个测量最多 2 请求/秒。

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `GP_API_URL` | 否 | `https://api.globalping.io` | 上游 Globalping 根地址（不含 `/v1`） |
| `GP_TOKEN` | 否 | — | 服务端 Globalping access token。留空则完全禁用代理（`proxyAvailable: false`），前端只显示本地一条额度 |
| `GP_TIMEOUT` | 否 | `30000` | 上游请求超时（毫秒） |
| `OIDC_ISSUER` | 否* | — | OpenID Provider issuer URL（如 `https://sso.example.com/realms/master`） |
| `OIDC_CLIENT_ID` | 否* | — | OIDC client id |
| `OIDC_CLIENT_SECRET` | 否* | — | OIDC client secret |
| `OIDC_REDIRECT_URI` | 否* | — | 回调地址，必须与 IdP 中登记的一致，如 `https://your.domain/api/auth/callback` |
| `OIDC_SCOPE` | 否 | `openid profile email` | 请求的 scope |
| `OIDC_USERNAME_CLAIM` | 否 | `preferred_username` | 用作用户名的 claim（IdP 无此字段时可用 `name` / `sub`） |
| `OIDC_PROVIDER_NAME` | 否 | 本地化默认值 | 登录弹窗按钮上显示的 SSO 提供商名称 |
| `OIDC_ACCOUNT_URL` | 否 | — | SSO 用户中心地址；配置后右上角用户名变为指向它的链接（只接受 `http`/`https`） |
| `OIDC_POST_LOGOUT_REDIRECT_URI` | 否 | `OIDC_REDIRECT_URI` 的站点根 | 「同时退出 SSO」后 IdP 的回跳地址；需在 IdP 登记 |
| `SESSION_SECRET` | 否* | — | 用于签名会话 Cookie 的 ≥32 位随机串 |
| `SESSION_COOKIE_NAME` | 否 | `pa_session` | 会话 Cookie 名 |
| `SESSION_TTL` | 否 | `604800` | 会话有效期（秒） |
| `STATIC_DIR` | 否 | 自动 | 静态目录（生产 `dist/public`、开发 `public`，留空自动解析） |

\* 只有在 **OIDC 四项齐全且设置了 `SESSION_SECRET`** 时才会启用登录 —— 否则登录入口与整条代理通道都会被隐藏。

其他继承自框架的服务端变量：`SERVER_HOST`、`SERVER_PORT`（默认 `80`，Docker 镜像内为 `3001`）、`LOG_LEVEL`、`PROJECT_NAME`、`SERVER_NAME`、`ENV_PRODUCT`。

## 快速开始

```bash
pnpm install
pnpm build        # 后端 → dist/index.js (ESM) + 前端 → dist/public/（一次构建同时产出）
pnpm dev          # 后端开发（nodemon + tsx，直接服务 ./public）+ 前端 esbuild watch
```

运行：

```bash
GP_TOKEN='…' \
SESSION_SECRET='…' \
node dist/index.js
```

启动后访问 http://localhost:80 （或 `SERVER_PORT`）。执行测量本身无需任何配置：浏览器直接访问公开的 Globalping API，`GP_TOKEN` 仅用于启用登录后的兜底通道。

## 测试

使用 Jest（ESM + ts-jest）覆盖后端框架工具、Globalping 代理控制器、OIDC 服务以及全部前端模块，并包含针对真实 `node:http` 服务器的端到端用例。

```bash
pnpm test            # 全量跑一次（33 个套件 / 839 个用例）
pnpm test:watch      # 监听模式
pnpm test:coverage   # 输出 coverage/（html + lcov + 文本摘要）
pnpm lint            # ESLint（含测试文件）
pnpm typecheck       # tsc --noEmit
```

目录划分：`test/backend`（框架工具、路由、venation、配置、日志）、`test/service`（OIDC）、`test/frontend`（jsdom 下的前端模块）、`test/integration`（控制器 + 真实 HTTP 服务）、`test/helpers` 与 `test/setup`（共享夹具与基线环境变量）。未设置覆盖率阈值，当前约为 98.9% 行覆盖、98.7% 语句覆盖。

## OIDC：Keycloak 示例

1. 在 Keycloak 中创建客户端：
   - **Access Type / Client authentication**：`confidential`
   - **Standard flow**：启用（Authorization Code + PKCE S256）
   - **Valid redirect URIs**：`https://your.domain/api/auth/callback`
2. 设置环境变量：`OIDC_ISSUER`（realm 地址）、`OIDC_CLIENT_ID`、`OIDC_CLIENT_SECRET`、`OIDC_REDIRECT_URI` 以及 `SESSION_SECRET`。
3. 重启服务。右上角显示*登录*，点击后进入 Keycloak 登录；登录完成后显示用户名（`preferred_username`）与*退出*，同时左下角出现第二条额度条。

其他 IdP（Authentik、Google、GitLab OIDC 等）只需调整 `OIDC_ISSUER`，必要时调整 `OIDC_USERNAME_CLAIM`。

## 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/config` | `{ apiUrl, proxyAvailable, maxProbes }`（公开） |
| `GET` | `/api/auth/status` | `{ loggedIn, authEnabled, user }` |
| `GET` | `/api/auth/login` | 302 → IdP |
| `GET` | `/api/auth/callback` | OIDC 回调 → 写入会话 Cookie → `/` |
| `GET` | `/api/auth/logout` | 清除会话 → `/` |
| `GET` | `/api/limits` | 代理服务端代币的 `GET /v1/limits`（需登录 + `GP_TOKEN`） |
| `GET` | `/api/probes` | 位置自动补全用的去重探针索引（公开、无需代币、不消耗额度） |
| `POST` | `/api/measurements` | 代理 `POST /v1/measurements`（需登录 + `GP_TOKEN`） |
| `GET` | `/api/measurements/:id` | 代理 `GET /v1/measurements/{id}`（需登录 + `GP_TOKEN`） |
| 其余 GET | `/` 或静态文件 | 前端页面与资源 |

## 新增语言

1. 参照 `zh-Hans.json` 新建 `public/locales/<code>.json`。
2. 在 `src/frontend/i18n.ts` 的 `SUPPORTED_LANGS` 中注册语言代码。

## PWA 说明

服务工作线程维护带版本号的应用外壳缓存，优先走网络（html/js/css 使用 `no-cache`），失败时回退缓存。应用外壳变更后需提升 `public/sw.js` 中的 `CACHE_VERSION`。PWA 需要 HTTPS 或 `localhost`。

## 安全响应头

所有响应都带严格 CSP：`script-src 'self'`、`style-src 'self'`，**不使用** `'unsafe-inline'`。因此前端改动有两条约束：

- 首屏主题脚本是独立文件 `public/theme-init.js`（在样式表之前的阻塞 `<script src>`），不再内联；
- 不允许内联 `style="…"` 属性与 `<style>` 元素，请改用 class。

`connect-src` 还包含 `GP_API_URL` 的 origin，因为走本机额度时会直连 Globalping。**有意不下发** `Strict-Transport-Security`：TLS 在反向代理终止，HSTS 应在那里配置。

## Docker

已发布镜像：[`docker.io/yanranxiaoxi/pingatlas`](https://hub.docker.com/r/yanranxiaoxi/pingatlas)（`latest` 跟随默认分支）。

```bash
docker run -d --name pingatlas \
  -p 3001:3001 \
  -e GP_TOKEN='…' \
  -e SESSION_SECRET='…' \
  docker.io/yanranxiaoxi/pingatlas:latest
```

如需本地构建，再运行自己打的标签：

```bash
pnpm build
docker build -t pingatlas .
docker run -d --name pingatlas -p 3001:3001 \
  -e GP_TOKEN='…' \
  -e SESSION_SECRET='…' \
  pingatlas
```

镜像同时发布在 GitLab 私有仓库：`registry.gitlab.soraharu.com/xiaoxi/pingatlas:latest`。镜像内执行 `pnpm install --prod` 并复制 `dist/`（后端 + `public/`）。

## 限制

- 登录仅支持 OIDC，不提供本地账号，也不支持访客自填 Globalping token。
- 测量不做持久化，结果仅存在于当前页面，不提供历史记录、分享链接或仪表盘。
- 会话无状态，重启服务即失效。
- 代理不存储上游响应体，仅记录会话用户与上游错误。

完整设计说明见 [PLAN.md](./PLAN.md)。
