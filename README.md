# @dsh-external/dsh-local-workspace

本地文件夹工作区桥：把**你自己电脑上的文件夹**变成服务器上的工作区。

## 适用场景

Harness（GUI 服务器）跑在远程/容器里，你的文件在你自己的电脑上。本插件在输入区加一条
「本地文件夹工作区」横条，让你：

1. **上传**：点「选择本地文件夹」，浏览器弹出文件夹选择器（`<input webkitdirectory>`，
   Chrome/Edge/Firefox/Safari 均支持），整个文件夹逐文件上传到服务器；
2. **切换**：上传完成后自动把该目录注册为工作区（复用内置 `workspaces` 服务）并打开新会话，
   会话 cwd = 该目录——fs 沙箱的 workspace 根随之指向它，代理即可读写其中的文件；
3. **下载**：随时把工作区打包成 zip 下载回本地（含代理改动后的最新内容）；
4. **删除**：删除服务器上的工作区目录（工作区注册与会话不受影响）。

## 使用

刷新 GUI 后，**侧边栏底部（设置按钮旁）**出现「本地文件夹」按钮：

- 点击打开「本地文件夹工作区」弹层：
  - **上传**：点「选择本地文件夹」，浏览器弹出文件夹选择器（`<input webkitdirectory>`，
    Chrome/Edge/Firefox/Safari 均支持），整个文件夹逐文件上传到服务器，带进度条与取消；
  - **切换**：上传完成后自动把该目录注册为工作区（复用内置 `workspaces` 服务）并打开新会话，
    会话 cwd = 该目录——fs 沙箱的 workspace 根随之指向它，代理即可读写其中的文件；
  - **下载**：当前会话在本插件目录时，可把工作区打包成 zip 下载回本地
    （含代理改动后的最新内容）；
  - **删除**：删除服务器上的工作区目录（工作区注册与会话不受影响）。

## 工作方式

- **宿主端**（`src/index.ts`）：注册 HTTP 前缀路由 `/local-workspace/api`
  （`webServer` 服务），端点：`ping`、`begin`、`file`（原始二进制体上传）、`commit`、
  `status`（按会话 cwd 解析）、`download`（自实现 zip：deflate + UTF-8 名 + 中央目录）、
  `remove`。
- **客户端**（`src/client/index.tsx`）：注册 `sidebar.footer.action`（侧边栏底部入口，
  id `local-workspace`，order 50）与 `shell.overlay`（弹层，order 60），两个条目共享
  一个 apply 内构建的 store（open 开关）；UI 全部用官方 ui-primitives 组件
  （Button/Modal/图标），外观跟随 Web UI 主题令牌。上传用 XHR（有进度），
  下载用 fetch → Blob → `<a download>`。
- **切换会话**：上传完成后客户端调用 `ctx.workspaces.create({ path })` 再
  `ctx.workspaces.startSession(workspaceId)`，会话 cwd 由宿主 apiproxy 设为工作区路径。

## 配置（cordis.yml / 插件配置）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `baseDir` | `$DSH_HOME/local-workspaces`（无 `DSH_HOME` 时 `~/.dsh/local-workspaces`） | 上传工作区的根目录 |
| `maxFileBytes` | 256 MiB | 单个文件上传上限 |
| `maxTotalBytes` | 1 GiB | 单个工作区目录总大小上限 |
| `maxFiles` | 20000 | 单个工作区目录文件数上限 |

## 安全

- 所有目录参数必须 realpath 后位于 `baseDir` 内（防 symlink 逃逸）；
- 相对路径拒绝绝对路径与 `..` 段；工作区名拒绝分隔符、控制字符、`.`/`..`；
- 上传/下载均有大小与条目上限；symlink 与非常规文件不打包。

## 构建与注入

```bash
DSH_CHECKOUT=/root/deepseek-harness bash scripts/build.sh   # host: tsc → lib/index.js
DSH_CHECKOUT=/root/deepseek-harness node_modules/.bin/tsdown  # client: tsdown → lib/client.js
npm pack                                                       # 可选：发布用 tgz
# 注入器环境内：dev_inject_plugin /root/dsh-routing-suite/local-workspace
# 重载：dev_reload_package dsh-local-workspace   卸载：dev_uninject_plugin dsh-local-workspace
```

## 已知限制

- 只上传文件（空目录不保留）；大文件整体读入内存打包 zip（受 `maxFileBytes` 约束）；
- `webkitdirectory` 每次需重新选择文件夹；无自动双向同步（上传覆盖同名文件）。
