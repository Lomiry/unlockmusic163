# UnblockNeteaseMusic 路由器版

本仓库维护 OpenWrt / ImmortalWrt 上运行的 UNM 核心，配合现有 LuCI 插件与 procd 服务使用。当前 Stage 9 针对 Android 网易云 9.6.05 的 XEAPI 接口，包含灰歌权限修补和播放音源回填。

## 下载与部署

前往 [GitHub Releases](https://github.com/Lomiry/unlockmusic163/releases) 下载路由器更新包，解压后先阅读包内 README 和部署说明。路由器需已有 Node.js、UnblockNeteaseMusic 服务配置和 HTTPS 证书。

[Stage 9 部署说明](docs/android-9.6.05-stage9.md) 包含版本校验、备份、启用、关闭和回滚步骤。自动部署脚本仅适用于说明中指定的 Stage 8 核心；已正常运行 Stage 9 的设备无需重新安装。

- 路由器核心：`precompiled/app.js`。
- 服务：`/etc/init.d/unblockneteasemusic`。
- 已验证核心 SHA256：`d8b0171e346f6655985669896197d5a65bc66afb7b783cc28af4b4c5370fdace`。
- Stage 6：`UNM_XEAPI_PRIVILEGE_PATCH=true`，负责灰歌可点击。
- Stage 9：`UNM_XEAPI_PLAYER_URL_PATCH=true`，负责回填可播放音源。
- Stage 8 observer：`UNM_ALBUM_PLAY_OBSERVER=false`。

核心自动更新应保持关闭，避免覆盖已验证版本。客户端流量需要经过路由器 UNM，并继续使用既有的证书和转发配置。

## 功能

- 使用多个音源匹配不可播放歌曲。
- 通过 HTTP / HTTPS 代理处理网易云请求。
- 支持上游代理、音源顺序、缓存及独立诊断日志。
- 保留可选的中继入口 `bridge.js`，用于路由器所需的音源中继。

## 源码开发与构建

在有足够内存的 Linux 开发环境中构建，再把核心部署到路由器：

```sh
git clone --branch debug/android-9.6.05-stage9 https://github.com/Lomiry/unlockmusic163.git
cd unlockmusic163
node .yarn/releases/yarn-3.8.7.cjs install --immutable
node .yarn/releases/yarn-3.8.7.cjs build
node .yarn/releases/yarn-3.8.7.cjs package:router
node .yarn/releases/yarn-3.8.7.cjs test --runInBand --testPathPatterns='xeapi|privilege|batch|album-play'
```

核心构建产物在 `precompiled/`，路由器更新包与校验文件在 `dist/`。回归脚本在 `scripts/`，所需基准版本及复跑方式见 Stage 9 部署说明。开发依赖中的平台包由工具链管理，不作为路由器安装包分发。

## 路由器参数与音源

现有 LuCI / procd 配置负责传入启动参数和环境变量。下面保留核心支持的参数与音源说明。

### 配置参数

```bash
$ unblockneteasemusic -h
usage: unblockneteasemusic [-v] [-p http[:https]] [-a address] [-u url] [-f host]
                           [-o source [source ...]] [-t token] [-e url] [-s]
                           [-h]

optional arguments:
  -v, --version                   output the version number
  -p port, --port http[:https]    specify server port
  -a address, --address address   specify server host
  -u url, --proxy-url url         request through upstream proxy
  -f host, --force-host host      force the netease server ip
  -o source [source ...], --match-order source [source ...]
                                  set priority of sources
  -t token, --token token         set up proxy authentication
  -e url, --endpoint url          replace virtual endpoint with public host
  -s, --strict                    enable proxy limitation
  -c, --cnrelay host:port         Mainland China relay to get music url
  -h, --help                      output usage information
```

### 音源清单

将有兴趣的音源代号用 `-o` 传入 UNM 即可使用，像这样：

```bash
node precompiled/app.js -o bilibili ytdlp
```

| 名称                        | 代号        | 默认启用 | 注意事项                                                                                                              |
| --------------------------- | ----------- | -------- | --------------------------------------------------------------------------------------------------------------------- |
| QQ 音乐                     | `qq`        |          | 需要准备自己的 `QQ_COOKIE`（请参阅下方〈环境变量〉处）。必须使用 QQ 登录。                                            |
| 酷狗音乐                    | `kugou`     | ✅       |                                                                                                                       |
| 酷我音乐                    | `kuwo`      |          |                                                                                                                       |
| 波点音乐                    | `bodian`    | ✅       |                                                                                                                       |
| 咪咕音乐                    | `migu`      | ✅       | 需要准备自己的 `MIGU_COOKIE`（请参阅下方〈环境变量〉处）。                                                            |
| JOOX                        | `joox`      |          | 需要准备自己的 `JOOX_COOKIE`（请参阅下方〈环境变量〉处）。<br>仅支持 Hong Kong, Macau, Thailand, Malaysia, Indonesia. |
| YouTube（纯 JS 解析方式）   | `youtube`   |          | 需要 Google 认定的**非中国大陆区域** IP 地址。                                                                        |
| YouTube（通过 `youtube-dl`) | `youtubedl` |          | 需要自行安装 `youtube-dl`。                                                                                           |
| YouTube（通过 `yt-dlp`)     | `ytdlp`     | ✅       | 需要自行安装 `yt-dlp`（`youtube-dl` 仍在活跃维护的 fork）。                                                           |
| B 站音乐                    | `bilibili`  |          |                                                                                                                       |
| B 站音乐                    | `bilivideo` |          | 在大陆地区外的IP地址可能查询不到某些版权视频（如索尼音乐上传的MV等）                                                  |
| 第三方网易云 API            | `pyncmd`    |          |                                                                                                                       |

- 支持 `pyncmd` 的 API 服务由 GD studio <https://music.gdstudio.xyz> 提供。

### 环境变量

| 变量名称              | 类型 | 描述                                                                                                          | 示例                                                             |
| --------------------- | ---- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| ENABLE_FLAC           | bool | 激活无损音质获取                                                                                              | `ENABLE_FLAC=true`                                               |
| ENABLE_LOCAL_VIP      | str  | 激活本地黑胶 VIP，可选值：`true`（等同于 CVIP）、`cvip` 和 `svip`                                             | `ENABLE_LOCAL_VIP=svip`                                          |
| LOCAL_VIP_UID         | str  | 仅对这些 UID 激活本地黑胶 VIP，默认为对全部用户生效                                                           | `LOCAL_VIP_UID=123456789,1234,123456`                            |
| ENABLE_HTTPDNS        | bool | 激活故障的 Netease HTTPDNS 查询（不建议）                                                                     | `ENABLE_HTTPDNS=true`                                            |
| BLOCK_ADS             | bool | 屏蔽应用内部分广告                                                                                            | `BLOCK_ADS=true`                                                 |
| DISABLE_UPGRADE_CHECK | bool | 禁用更新检测                                                                                                  | `DISABLE_UPGRADE_CHECK=true`                                     |
| DEVELOPMENT           | bool | 激活开发模式。需要自己用 `yarn` 安装依赖 (dependencies)                                                       | `DEVELOPMENT=true`                                               |
| FOLLOW_SOURCE_ORDER   | bool | 严格按照配置音源的顺序进行查询                                                                                | `FOLLOW_SOURCE_ORDER=true`                                       |
| JSON_LOG              | bool | 输出机器可读的 JSON 记录格式                                                                                  | `JSON_LOG=true`                                                  |
| NO_CACHE              | bool | 停用 cache                                                                                                    | `NO_CACHE=true`                                                  |
| MIN_BR                | int  | 允许的最低源音质，小于该值将被替换                                                                            | `MIN_BR=320000`                                                  |
| SELECT_MAX_BR         | bool | 选择所有音源中的最高码率替换音频                                                                              | `SELECT_MAX_BR=true`                                             |
| LOG_LEVEL             | str  | 日志输出等级。请见〈日志等级〉部分。                                                                          | `LOG_LEVEL=debug`                                                |
| LOG_FILE              | str  | 从 Pino 端设置日志输出的文件位置。也可以用 `*sh` 的输出重导向功能 (`node precompiled/app.js >> app.log`) 代替 | `LOG_FILE=app.log`                                               |
| JOOX_COOKIE           | str  | JOOX 音源的 wmid 和 session_key cookie                                                                        | `JOOX_COOKIE="wmid=<your_wmid>; session_key=<your_session_key>"` |
| MIGU_COOKIE           | str  | 咪咕音源的 aversionid cookie                                                                                  | `MIGU_COOKIE="<your_aversionid>"`                                |
| QQ_COOKIE             | str  | QQ 音源的 uin 和 qm_keyst cookie                                                                              | `QQ_COOKIE="uin=<your_uin>; qm_keyst=<your_qm_keyst>"`           |
| YOUTUBE_KEY           | str  | Youtube 音源的 Data API v3 Key                                                                                | `YOUTUBE_KEY="<your_data_api_key>"`                              |
| SIGN_CERT             | path | 自定义证书文件                                                                                                | `SIGN_CERT="./server.crt"`                                       |
| SIGN_KEY              | path | 自定义密钥文件                                                                                                | `SIGN_KEY="./server.key"`                                        |
| SEARCH_ALBUM          | bool | 在其他音源搜索歌曲时携带专辑名称（默认搜索条件 `歌曲名 - 歌手`，启用后搜索条件 `歌曲名 - 歌手 专辑名`）       | `SEARCH_ALBUM=true`                                              |
| NETEASE_COOKIE        | str  | 网易云 Cookie                                                                                                 | `MUSIC_U=007554xxx`                                              |

#### 日志等级 (`LOG_LEVEL`)

这些是常用的值：

- `debug`: 输出所有记录（调试用）
- `info`: 只输出一般资讯（默认值）
- `error`: 只在出严重问题时输出

详细请参见 [Pino 对此的说明](https://github.com/pinojs/pino/blob/master/docs/api.md#level-string)。

## 证书与客户端连接

使用路由器既有 UNM 服务的 HTTPS 证书和转发配置。Android 9.6.05 需保持流量经过该服务；本仓库提供的更新包替换核心并配置 Stage 9 开关。

## 致谢与许可

本项目基于 [UnblockNeteaseMusic/server](https://github.com/UnblockNeteaseMusic/server) 与原始 [nondanee/UnblockNeteaseMusic](https://github.com/nondanee/UnblockNeteaseMusic)。感谢上游维护者、协议研究者和音源实现贡献者。

本项目使用 LGPL-3.0-only；见 [COPYING](COPYING) 和 [COPYING.LESSER](COPYING.LESSER)。构建产物中的依赖许可见 `precompiled/app.js.LICENSE.txt`。
