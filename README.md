# codex-weixin

<p align="center">
  <img src="src/web/favicon.svg" alt="codex-weixin logo" width="128" height="128" />
</p>

<p align="center">
  <strong>中文</strong> | <a href="./README.en.md">English</a>
</p>

<p align="center">
  <strong>把个人微信账号接入本机 OpenAI Codex，并用 Web 控制台管理账号、会话和 Token 用量。</strong>
</p>

```text
微信私聊 <-> codex-weixin <-> 本机 Codex CLI <-> 允许的工作目录
```

`codex-weixin` 是一个在本机运行的微信到 Codex 桥接服务。服务提供扫码登录、微信消息接入、受管 Codex 会话和本地 Web 管理页。Web 服务默认只监听 `127.0.0.1`，不会把管理页面开放到局域网或公网。

## 当前能力

- 扫码接入一个或多个微信账号；每个账号拥有独立的联系人授权、附件和会话运行状态。
- 接收微信文本、图片、音频、视频和文件；单个入站附件最大 `100 MiB`。
- 通过 Codex actions 把本机图片、视频和文件作为微信原生消息发回。
- 在 Web 中新建、重命名、切换、重置和删除会话；Web 与微信继续使用同一个受管 Codex thread。
- 在 Web 或微信中切换模型、推理强度和流式回复；支持 `app-server`、`exec` 和自动选择后端。
- 长任务显示过程进度；可以用 `/stop` 中断当前任务。
- 提供 Token 统计中控台：KPI、趋势图、输入构成、会话排行、最近请求、筛选和分页。
- 页面会自动刷新账号、会话和用量状态；配置和历史数据保存在本机状态目录。

## 快速开始

### 环境要求

- Node.js `>=22`
- Git（源码开发时需要）
- 已安装并登录的 Codex CLI

先确认 Codex CLI 可用：

```bash
npm install -g @openai/codex
codex --version
codex
```

### 从 npm 安装

```bash
npm install -g codex-weixin
codex-weixin
```

服务启动后打开 [http://127.0.0.1:8787](http://127.0.0.1:8787)。也可以设置 `CODEX_WEIXIN_OPEN=0`，手动打开这个地址。

### 从源码运行

```bash
git clone https://github.com/FortuneBush/codex-weixin-robot.git
cd codex-weixin-robot
npm install
npm run build
npm start
```

开发模式会直接运行 TypeScript 服务：

```bash
npm run dev
```

如果修改了 `src/web` 后使用 `npm start`，请先执行 `npm run build`，这样 `dist/web` 才会包含最新页面。

## 第一次使用

1. 启动服务并打开 Web 管理页。
2. 在“微信账号”页扫码登录；首次登录后等待联系人同步完成。
3. 在联系人列表中允许需要使用 Codex 的微信联系人。
4. 在“会话”页创建或选择会话，确认工作目录后即可从 Web 或微信发送任务。
5. 进入“Token 统计”查看已经完成的 Codex 请求。没有完成过请求时，统计页会显示空状态。

## Web 管理页

### 微信账号

账号页显示扫码状态、联系人授权和账号备注。服务可以同时维护多个账号；账号之间的联系人、会话、附件和运行状态相互隔离。移除账号时可以保留历史，之后重新扫码可以恢复本机保留的账号状态。

### 会话

会话页按微信账号列出受管 Codex threads，支持新建、重命名、激活、重置和删除。页面可以直接发送文本和附件，每次最多 `10` 个文件、合计 `100 MiB`。每个会话还可以单独覆盖模型、推理强度和流式回复设置。

### Token 统计中控台

Token 统计页每 `5` 秒自动刷新。统计来自本机受管会话记录，用于观察当前服务消耗，不是 OpenAI 账单数据。

- 顶部 KPI 显示累计 Token、Input、Output、Cache Hit Rate、请求轮数和平均每轮 Token。
- 趋势图按日期绘制 Input、Output 和 Cached；页面最多展示最近 `14` 个日期点。
- 输入构成图区分缓存输入和未缓存输入，便于判断上下文复用情况。
- “会话消耗排行”使用彩色分段柱：Input 使用绿色、Cached 使用黄色、Output 使用蓝色，并在柱下显示具体数值和缓存命中率。
- “最近请求”列出每轮的账号、会话、Input、Output、Cached、总量和发生时间。
- 可以按微信账号和会话筛选，按累计 Token、Input、Output、Cache Hit Rate 或最近使用时间排序。
- 会话排行和最近请求都支持分页，每页可选 `5`、`10` 或 `20` 条；筛选条件、KPI、图表和列表会同步更新。

统计口径如下：`Input` 是输入上下文 Token，`Output` 是模型生成 Token，`Cached` 是命中的缓存输入 Token，`Cache Hit Rate = Cached / Input`。没有 Input 时命中率显示为 `--`。每个受管会话最多保留最近 `1000` 条 Token 记录。

### 设置

设置页用于维护默认工作目录、允许的工作区、Codex 后端、exec sandbox、默认模型、推理强度和流式回复。也可以查看运行信息、检查版本并执行更新。默认配置适合本机使用；改变 sandbox 权限前请确认 Codex 需要访问的文件范围。

## 微信命令

在已授权的微信联系人中发送以下命令：

```text
/help                         显示命令
/status                       查看当前绑定、模型和推理强度
/bind <absolute-path>         把当前聊天绑定到工作目录
/new                          创建新的受管 Codex 会话
/resume [R-number]            列出或切换历史会话
/model [number|model-id|default]  查看或切换模型
/effort [number|level|default]   查看或切换推理强度
/stream [on|off|default]      查看或切换流式回复
/prompt start                 开始缓冲多条微信消息
/prompt done                  提交已缓冲的消息
/stop                         中断当前 Codex 任务
```

`/model`、`/effort` 和 `/stream` 的修改只作用于当前受管会话；使用 `default` 可以恢复继承 Web/Codex 全局设置。`/bind` 只能选择设置页允许的绝对工作目录。

## 从 Codex 发送微信媒体

Codex 可以在回复中输出 `codex-weixin-actions` JSON 代码块，把本机文件发送回当前微信联系人。路径必须是绝对路径，并且位于允许的工作区内：

````markdown
```codex-weixin-actions
{"actions":[
  {"type":"send","mediaType":"image","path":"C:/work/chart.png","caption":"分析图"},
  {"type":"send","mediaType":"file","path":"C:/work/report.pdf"}
]}
```
````

支持的 `mediaType` 为 `image`、`video` 和 `file`。服务会校验路径、文件类型和大小，不能把任意本机路径直接暴露给微信。

## 配置

Web 设置页会把配置写入状态目录中的 `config.json`。主要字段如下：

| 配置项 | 作用 |
| --- | --- |
| `defaultCwd` | 默认 Codex 工作目录 |
| `allowedWorkspaces` | `/bind` 和会话可使用的绝对工作目录列表 |
| `codexBin` | Codex CLI 可执行文件，默认 `codex` |
| `codexBackend` | `auto`、`app-server` 或 `exec` |
| `codexExecSandbox` | `read-only`、`workspace-write` 或 `danger-full-access` |
| `codexTimeoutMs` | Codex 单次任务超时；留空表示不限制，范围为 1 分钟至 24 小时 |
| `model` / `effort` | 默认模型和推理强度，留空表示沿用 Codex 设置 |
| `streamReplies` | 是否向微信发送过程进度 |
| `allowedSenderIds` | 允许使用服务的微信联系人 ID |
| `maxBufferItems` / `promptBufferTtlMs` | 消息缓冲数量和过期时间 |
| `maxInboundBytes` | 入站附件大小上限，默认 `100 MiB` |

### 环境变量

```text
CODEX_WEIXIN_PORT=8787
CODEX_WEIXIN_STATE_DIR=~/.codex-weixin
CODEX_WEIXIN_OPEN=0
```

Windows PowerShell 示例：

```powershell
$env:CODEX_WEIXIN_PORT="8787"
$env:CODEX_WEIXIN_OPEN="0"
codex-weixin
```

## 本地数据

默认状态目录为 `~/.codex-weixin/`：

```text
~/.codex-weixin/
  accounts/                 微信账号凭据
  retained-accounts.json    已移除账号的恢复索引
  config.json               Web 设置和 Codex 配置
  runtime/<account-id>/     联系人授权、会话和 Token 统计
  inbound/<account-id>/     微信入站附件
  logs/<account-id>/        运行日志
```

Token 用量来自 `runtime` 中的本机记录；服务不会把微信凭据返回给浏览器。不要提交或分享整个状态目录。

## 安全边界

- Web 服务只监听 `127.0.0.1`，并拒绝非本机 Host 和 Origin。
- 修改类 API 使用页面运行时令牌；读取接口也只服务于本机管理页。
- 未知联系人默认拒绝，必须在“微信账号”页明确授权。
- 所有工作区和媒体路径都会经过允许列表校验。
- 微信端没有 Codex 审批弹窗，app-server 使用 `approvalPolicy: "never"`；实际文件访问仍受所选 Codex sandbox 约束。
- `danger-full-access` 会绕过 Codex 文件系统 sandbox，只应在明确接受风险时使用。
- 多个账号可以并行触发 Codex，会共同占用本机 CPU、内存和 Codex 配额。

## 开发与验证

```bash
npm install
npm run dev       # 开发模式
npm test          # Node 测试
npm run typecheck # TypeScript 类型检查
npm run build     # 构建 dist/server 和 dist/web
npm start         # 运行构建产物
```

构建入口为 `dist/server/index.js`。提交页面改动前至少执行 `npm run typecheck` 和 `npm run build`；提交前可用 `git diff --check` 检查 Markdown 和代码的空白错误。

## 截图

仓库中的界面截图位于 [`docs/images/screenshots`](./docs/images/screenshots/)：

- [微信多媒体输入与回传](./docs/images/screenshots/wechat-media-input-output.png)
- [微信语音指令](./docs/images/screenshots/wechat-voice-command.png)
- [微信命令](./docs/images/screenshots/wechat-cli-commands.png)
- [微信过程进度](./docs/images/screenshots/wechat-process-progress.png)
- [Web 多账号](./docs/images/screenshots/web-multi-account.png)
- [Web 会话管理](./docs/images/screenshots/web-session-management.png)
- [Web 全局设置](./docs/images/screenshots/web-global-settings.png)

Token 统计页当前以动态数据为主，README 用文字说明其交互和统计口径，避免引用固定的旧截图。

## 许可

本项目使用 [MIT License](./LICENSE)。版本变更见 [CHANGELOG.md](./CHANGELOG.md)。
