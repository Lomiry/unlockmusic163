# ImmortalWrt 路由器 APK

适配 ImmortalWrt 25.12.1，x86/64（APK 架构 x86_64）。这是路由器的 APK 软件包，不是 Android 应用。

构建使用官方 SDK，并固定 SDK SHA256。APK 内核心直接来自同一次提交的 `precompiled/app.js`；CI 会解包并逐字节核对核心与文件校验值。Stage 9 性能优化版已通过本地回归，APK 安装与真实路由器运行仍需实机验证，因此自动生成的 Release 标为预发布。

## 安装

先保留路由器现有的 `luci-app-unblockneteasemusic`、Node.js、证书和路由配置，并在 LuCI 中关闭核心自动更新。

下载 Release 内的 `.apk` 和 `SHA256SUMS`。将 APK 上传到路由器 `/tmp`，校验下载文件。该自建包未使用 ImmortalWrt 官方私钥签名，命令行安装时仅对这个本地文件允许未受信任的签名：

```sh
apk add --allow-untrusted /tmp/unblockneteasemusic-stage9-*.apk
unm-stage9 activate
unm-stage9 status
```

安装会检查 Node.js 与既有 LuCI 插件依赖。`unm-stage9 activate` 检查包内文件与服务布局，备份原核心和 init，再启用 Stage 6/9，关闭额外 XEAPI 观察与 Stage 8 observer。证书、UCI 配置、端口、音源和转发设置保留。原服务在运行时会重启；原来停止的服务保持停止，可从 LuCI 启动。

包本身存放在 `/usr/share/unblockneteasemusic-stage9/`，不会与 LuCI 插件管理的文件产生 APK 所有权冲突。只有执行 activate 才切换现有核心。升级本包后再次执行 activate 才使用新版核心。

安装后先验证普通歌、原灰歌和额外灰歌，以及重启服务后的开关。

## 回退与卸载

```sh
unm-stage9 rollback
apk del unblockneteasemusic-stage9
```

原核心及 init 备份位于 `/etc/unblockneteasemusic-stage9/`，不会被重复激活覆盖。若激活后手动改过核心或 init，回退会拒绝覆盖这些改动。先保存并处理改动后再操作。卸载前应先 rollback；仅卸载软件包不会自动替换当前运行核心。

## 自动构建

Stage 9 分支相关文件更新会自动构建，并在成功验证后发布新的 `router-apk-N` 预发布 Release。每次构建的 APK release 编号递增。原稳定 Release 与默认分支 enhanced 保持不变。

SDK 来源：[ImmortalWrt 25.12.1 x86/64 官方目录](https://downloads.immortalwrt.org/releases/25.12.1/targets/x86/64/)。软件许可为 LGPL-3.0-only，许可文本与依赖声明随包提供。
