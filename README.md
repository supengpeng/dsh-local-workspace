# @dsh-external/dsh-local-workspace

本地文件夹工作区桥：把**你自己电脑上的文件夹**变成服务器上的工作区。

## 适用场景

Harness（GUI 服务器）跑在远程/容器里，你的文件在你自己的电脑上。本插件在侧边栏提供「本地文件夹」管理面板，同时把官方「添加工作区」扩展为支持本机文件夹：

1. **上传**：选择本地文件夹，浏览器弹出文件夹选择器（`<input webkitdirectory>`），整个文件夹逐文件上传到服务器；
2. **切换**：上传完成后自动把该目录注册为工作区（复用内置 `workspaces` 服务）并打开新会话，会话 cwd = 该目录；
3. **下载**：随时把工作区打包成 zip 下载回本地（含代理改动后的最新内容）；
4. **删除**：删除服务器上的工作区目录（工作区注册与会话不受影响）；
5. **后台双向同步**：在支持的浏览器（Chrome/Edge，需安全上下文）选择本地文件夹后，插件在后台持续对比本地与服务器，自动双向同步新增、修改和删除；
6. **服务器目录**：同时保留官方 DirectoryBrowser，可浏览/新建服务器已有目录。

## 使用

刷新 GUI 后，**官方 WorkspaceBrowser 头部**会出现「本地文件夹」按钮；如果未安装官方补丁，则按钮会出现在**侧边栏底部**：

- 点击打开「本地文件夹工作区」弹层：
  - **一次性上传**：点「选择本地文件夹」，浏览器弹出文件夹选择器（`<input webkitdirectory>`），整个文件夹并发上传到服务器，带总进度条与取消；
  - **后台双向同步**：点「选择文件夹并开始同步」，浏览器弹出文件夹句柄授权（File System Access API），插件会创建/切换会话并开始后台持续同步；
  - **下载**：当前会话在本插件目录时，可把工作区打包成 zip 下载回本地（含代理改动后的最新内容）；
  - **删除**：删除服务器上的工作区目录（工作区注册与会话不受影响）。

另外，官方侧边栏/空状态的「添加工作区」也会弹出本插件的选择器：

- **选择本机文件夹**：上传到服务器后交给官方 `workspaces.create` 注册；
- **选择服务器目录**：默认使用官方 DirectoryBrowser 目录浏览 UI。

## 官方 WorkspaceBrowser 头部按钮（可选补丁）

「本地文件夹」按钮默认显示在**官方 WorkspaceBrowser 头部**。这需要在
`@deepseek-ai/dsh-client-ui-workspace` 中新增一个槽位：

- 槽位名：`sidebar.workspaces.localWorkspaceAction`
- 涉及文件：
  - `packages/client/ui-workspace/src/client/WorkspaceBrowser.tsx`
  - `packages/client/ui-workspace/src/client/contract/slots.ts`
  - `packages/client/ui-workspace/src/client/index.ts`

仓库内已提供补丁文件：

```bash
# 在 deepseek-harness 仓库根目录执行
git apply /path/to/dsh-local-workspace/official-ui-workspace.patch

# 重新构建官方客户端包
pnpm --filter @deepseek-ai/dsh-client-ui-workspace bundle
```

### 不安装补丁的兼容模式

如果你**不安装**上述官方补丁，插件会自动进入兼容模式：

- 官方 WorkspaceBrowser 头部按钮不会显示；
- 插件自动回退到**侧边栏底部「本地文件夹」按钮**；
- 管理弹层、上传、下载、删除、双向同步、官方「添加工作区」等全部功能仍然可用。

因此：

- 如果你或你的 AI 希望使用官方 WorkspaceBrowser 头部按钮，请先确认是否安装补丁；
- 如果不安装，插件仍然兼容，不需要改代码。

## 后台双向同步

- **触发**：选择本地文件夹并授权后，即使关闭弹窗也会每 30 秒自动同步一次；页面刷新后若浏览器仍持有已授权句柄且未手动停止，会自动恢复同步。
- **方向**：本地新增/修改 → 上传服务器；服务器新增/修改 → 下载本地；删除双向传播。
- **冲突**：同一文件两边都修改时，以最后修改时间（mtime）较新的一侧覆盖另一侧。
- **删除语义**：首次同步只合并两边现有文件，不删除；之后依赖持久化的 baseline 区分“远端新增文件”和“本地删除文件”，从而安全地双向传播删除。
- **状态**：弹层内可查看上次同步时间、最近一次上传/下载/删除数量、错误信息，并可立即同步、停止同步或忘记文件夹。

## 工作方式

- **宿主端**（`src/index.ts`）：注册 HTTP 前缀路由 `/local-workspace/api`
  （`webServer` 服务），端点：`ping`、`begin`、`file`（流式写入原始二进制体，可携带
  `mtime` 保留修改时间）、`commit`、`status`、`download`（自实现流式 zip）、
  `sync/manifest`、`sync/file`、`sync/remove-file`。
- **客户端**（`src/client/index.tsx`）：注册
  `sidebar.workspaces.localWorkspaceAction`（官方 WorkspaceBrowser 头部入口），
  未检测到该槽位时自动注册 `sidebar.footer.action`（侧边栏底部兼容入口），并注册
  `shell.overlay`（本地文件夹管理弹层），同时注册官方
  `sidebar.workspaces.directoryFlow` / `conversation.hero.workspace.directoryFlow`
  （官方「添加工作区」入口）；本机文件夹上传用官方 ui-primitives，
  服务器目录选择用官方 DirectoryBrowser。
- **同步引擎**（`src/client/sync.ts`）：使用 File System Access API 持有本地文件夹句柄，
  IndexedDB 持久化句柄与 baseline；对比本地/远端 manifest 后执行上传、下载、删除。
- **切换会话**：上传完成后由官方 flow 调用 `ctx.workspaces.create({ path })` 并
  `ctx.workspaces.startSession(workspaceId)`，会话 cwd 由宿主 apiproxy 设为工作区路径。

## 配置（cordis.yml / 插件配置）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `baseDir` | `$DSH_HOME/local-workspaces`（无 `DSH_HOME` 时 `~/.dsh/local-workspaces`） | 上传工作区的根目录 |
| `maxFileBytes` | 256 MiB | 单个文件上传上限 |
| `maxTotalBytes` | 1 GiB | 单个工作区目录总大小上限 |
| `maxFiles` | 20000 | 单个工作区目录文件数上限 |
| `serverDirectoryMode` | `browse` | 服务器目录选择方式：`native`（官方原生选择器）/ `browse`（官方 DirectoryBrowser 浏览）/ `tryNativeFirst`（先原生、失败回退浏览） |

## 安全

- 所有目录参数必须 realpath 后位于 `baseDir` 内（防 symlink 逃逸）；
- 上传相对路径逐段检查，拒绝 symlink 与目录目标，防止写入逃逸；
- 相对路径拒绝绝对路径与 `..` 段；工作区名拒绝分隔符、控制字符、`.`/`..`；
- 上传时即时执行文件数与总大小上限（同一目录的写入/提交/删除按 key 串行化，避免并发突破限额）；
- 下载同样受大小与条目上限约束；symlink 与非常规文件不打包。

## 性能

- 上传请求体流式写入临时文件后原子改名，服务端不整体驻留大文件内存；
- 一次性上传客户端直接发送 File/Blob 并以 4 路并发上传，大文件夹传输更快；
- zip 下载流式写出（每次只保留一个文件的压缩数据），不再构建整包 Buffer。

## 构建与注入

```bash
DSH_CHECKOUT=/root/deepseek-harness bash scripts/build.sh   # host: tsc → lib/index.js
DSH_CHECKOUT=/root/deepseek-harness node_modules/.bin/tsdown  # client: tsdown → lib/client.js
npm test                                                      # build + node:test
npm pack                                                      # 可选：发布用 tgz
# 注入器环境内：dev_inject_plugin /root/dsh-routing-suite/local-workspace
# 重载：dev_reload_package dsh-local-workspace   卸载：dev_uninject_plugin dsh-local-workspace
```

## 已知限制

- 后台双向同步依赖 File System Access API，仅 Chromium 系浏览器（Chrome/Edge）且需 HTTPS/localhost 安全上下文；其他浏览器仍可使用一次性上传；
- 只同步文件，空目录不保留；
- `webkitdirectory` 一次性上传每次需重新选择文件夹；
- 冲突处理是自动的最后修改时间优先，无人工冲突解决界面。
