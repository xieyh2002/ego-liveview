# ego 实时画面（ego-liveview）

把 ego lite 浏览器的画面实时显示在 DSH（DeepSeek Harness）侧边栏里。dsh 在 ego 里操作网页时，侧边栏能看到同一个画面。

60–80 fps，约 17–25 KB/帧，不需要额外端口。

<!-- 截图放这儿。因为 DSH GUI 需要 token，自动化拿不到页面，这张得人工截。 -->

## 前置条件

- DSH（DeepSeek Harness），且已装 `dsh-better-sidebar`（提供 `ctx.betterSidebar`）。
- ego lite 的 `ego-browser` CLI 在 `PATH` 上（装完 ego lite 就有）。

## 安装

```bash
git clone https://github.com/xieyh2002/ego-liveview.git
```

然后把包链接进 profile。DSH 的 `plugin_manager install_bundle` 需要审批，被禁用时只能手工装——照下面三步：

1. **加依赖**：编辑 `%USERPROFILE%\.dsh\profiles\desktop\package.json`，在 `dependencies` 里加

   ```json
   "@local/ego-liveview": "link:C:/path/to/ego-liveview"
   ```

   再把 `"@local/ego-liveview"` 加进 `dsh.profile.bundles` 数组。

2. **建 junction**（Windows 下 `ln -s` 不可靠，会把目录复制成真目录）：

   ```cmd
   cd %USERPROFILE%\.dsh\profiles\desktop\node_modules
   mklink /J ego-liveview C:\path\to\ego-liveview
   ```

3. **挂进 cordis**：在 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 末尾加

   ```yaml
   - insert:
       - id: ego-liveview
         name: "@local/ego-liveview"
         config: {}
   ```

重启 DSH。

## 怎么用

1. 右侧边栏的标签列表里点 **+**，选「ego 浏览器」（英文界面是 *ego browser*）。
2. 有画面就说明通了。底栏会显示当前页面标题、帧率、单帧大小。
3. dsh 那边用 ego skill 操作浏览器时，这里跟着动，不需要额外操作。

插件会**自动跟随**：它扫描 ego 的所有 TaskSpace，挑最新有内容的那个页面；页面切换、新开 space 都会自动换过去，不用手动指定。

## 原理（三句话）

- ego 没有对外 TCP/CDP 端口，第三方连不进去；唯一入口是 `ego-browser nodejs` 在 ego 宿主进程里跑脚本。
- 所以在 ego 宿主里跑一个 pump：`Page.startScreencast` 取 JPEG 帧，经 **Windows 命名管道**（`[1B type][4B len][payload]`）送到 DSH 进程。
- DSH 侧用插件 host 的 `ctx.webServer.register` 暴露 `/ego-live/stream.mjpg`（MJPEG），侧边栏 tab 里就是一个 `<img>`。

不用额外端口、不用 WebSocket（工作区没有 `ws` 包）、MJPEG 不被 gzip 压缩（`multipart/x-mixed-replace` 不在 compressible 表里）。

## 路由

| 路由 | 说明 |
| --- | --- |
| `GET /ego-live/stream.mjpg` | MJPEG 流，`multipart/x-mixed-replace; boundary=frame` |
| `GET /ego-live/frame.jpg` | 单帧快照 |
| `GET /ego-live/status` | JSON 状态（看的哪个 space/页面、fps、viewers…） |

只允许 loopback 访问（Host 头必须是 `127.0.0.1` / `localhost` / `[::1]`），否则 403。

## 两个必须知道的坑

**1. ego 的窗口必须是「显示过」的状态。**
ego.exe 用 `--startup-ego-browser-service` 起来时窗口是隐藏的（`IsWindowVisible=false`）。隐藏窗口的合成器**一帧都不提交**：`Page.screencastFrame` 不来，`Page.captureScreenshot` 直接超时。所以 bridge 启动时会调一次 `bridge/wake-windows.ps1`，用 `ShowWindow(hwnd, 7)`（SW_SHOWMINNOACTIVE，最小化、不抢焦点、不挡屏）把隐藏的 `Chrome_WidgetWin_1` 窗口显示一下。只要显示过一次，之后就一直出帧。

**2. 千万别在要跑 screencast 的 target 上调 `Page.captureScreenshot`。**
窗口最小化时它会报 `Cannot capture a screenshot while the window is minimized.` 并超时，而这个超时会让该 target 的 screencast **永久不再出帧**（重启 ego 才能恢复）。早期所有「0 帧」的排查都是踩在这上面。要帧就用 screencast，不要混着截图。

其它实测数据：单进程内 screencast 稳定 **58–82 fps**、JPEG q60 960×600 约 17–25 KB/帧、首个管道连接 118ms、首帧 459ms。静态页面不出帧是正常行为（screencast 只在合成器有变化时发帧），所以 `ensureBridge()` 判活用的是 **metadata 心跳**而不是帧到达。

## 配置

`cordis.patch.yml` 里的 `config`：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `quality` | `60` | JPEG 质量 |
| `maxWidth` / `maxHeight` | `960` / `600` | 缩放上限（比这大的页面会被缩） |
| `space` | `''` | 空 = 自动跟随最新 space；填名字或 id 就固定看那个 |
| `idleTimeoutMs` | `20000` | 多久没心跳就重启 bridge |
| `egoBinary` | `ego-browser` | CLI 路径 |

改完代码要**重启 DSH** 才生效（bridge.mjs 只在插件加载时复制到 `%TEMP%\ego-liveview-runtime\`，运行中的 pump 是内存里的旧版）。

## 文件

```
index.js                 host 半边：三个路由 + 管道客户端 + bridge 进程生命周期
client.js                客户端半边：__ModuleLoader__ 模块，注册 better-sidebar tab
bridge/bridge.mjs        在 ego 宿主里跑的 pump：扫描 space → screencast → 写管道
bridge/wake-windows.ps1  显示隐藏的 ego 窗口
```

依赖 `ctx.webServer`（host）和 `ctx.get('betterSidebar')`（client）。better-sidebar 不在就静默不注册，不报错。

## 局限

- **只能看，不能操作。** tab 里是一个 `<img>`，点击/滚动不会传给 ego。要操作还是让 dsh 调 ego skill。做成可交互需要把鼠标事件转成 CDP `Input.dispatchMouseEvent` 并做坐标缩放，没做。
- **只跟随一个页面。** 多标签时跟随 `active` 那个；ego 里切标签会跟着切，但侧边栏里看不到"其他标签"。
- **Windows only。** 命名管道和窗口唤醒（`user32.dll`）都是 Windows 接口。
- **静态页面 fps 会很低**（甚至 1–2）。这不是故障——Chromium 的 screencast 只在合成器有变化时发帧。所以 bridge 判活用的是 metadata 心跳，不是帧到达。

## License

MIT

