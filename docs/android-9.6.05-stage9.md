# Stage 9：Android 网易云 9.6.05 XEAPI v1 灰歌音源替换

日期：2026-10-01。已完成实现、相关测试、本地代理回归和构建。用户反馈 Android 网易云 9.6.05 实机中普通歌、原灰歌及额外灰歌均可正常播放；服务重启后 Stage 6、Stage 9 环境变量保持开启，Stage 8 observer 关闭。此实机结果来自用户反馈。

app.js SHA256：`d8b0171e346f6655985669896197d5a65bc66afb7b783cc28af4b4c5370fdace`

## 实现范围与源码

仓库：`Lomiry/server`；分支：`debug/android-9.6.05-stage9`。本分支包含 Stage 9 及其依赖的 XEAPI 解码、Stage 6 权限补丁、observer、测试与回归脚本。

- `src/xeapi-player-url-patch.js`：独立、默认关闭。开关 `UNM_XEAPI_PLAYER_URL_PATCH=true`。日志文件变量 `UNM_XEAPI_PLAYER_URL_PATCH_LOG_FILE`，默认 `/var/run/unblockneteasemusic/xeapi-player-url-patch.log`。
- `src/hook.js`：XEAPI 响应先选择 Stage 6 privilege 补丁或 Stage 9 player 补丁，等待完成后调用 observer。接口互斥，不会对同一响应重复补丁。
- `src/xeapi-privilege-patch.js`：给原缓冲工厂增加可选 apiPath/onResult/onFallback 参数。默认参数、Stage 6 修改字段和原日志回调签名保持原行为；Stage 9 直接复用该工厂。
- `src/album-play-observer.js`：把本地 Stage 7 的目标改为 Stage 8 已确认的 `/api/song/enhance/player/url/v1`。保留 `UNM_ALBUM_PLAY_OBSERVER`、`UNM_ALBUM_PLAY_LOG_FILE` 和原日志标签以兼容原 init。它观察的是**最终返回客户端的响应**，成功回填时看到的是替换后的 URL 状态。仍建议首轮部署关闭它。
- 新增 `src/xeapi-player-url-patch.test.js`、`scripts/xeapi-player-url-regression.cjs`；相应更新 observer 测试和代理回归路径。

只接受精确 `/api/song/enhance/player/url/v1`、HTTP 200、成功解码、根 code 严格等于数字 200、data 数组。只匹配普通 JSON 对象的 `item.code === 404 && item.url === null && item.br === 0`。data 超过 512 项也跳过。

ID 接受正安全整数，或可精确转换为正安全整数的十进制数字字符串（不含前导零）。ID 缺失、非法时原 item 保留。调用原 `src/provider/match`，不改变 provider 选择和原缓存。一次响应内按规范化 ID 去重；不会新增跨请求缓存。

成功后只回填 url/type/md5/br/size/code/freeTrialInfo。Android 使用原非 PC endpoint/package 规则；endpoint 有值时不降级 https，未设置时直接使用 matcher URL。type 按 999000→flac，否则 mp3；md5 使用 matcher 值或原 `crypto.md5.digest(song.url)` fallback；br 使用 matcher 值或 128000；size 使用 matcher size；code=200、freeTrialInfo=null。fee/payed/flag/level/encodeType/message 等保持原值。

每个 matcher 的拒绝、同步异常、无可用 http(s) URL，只保留对应原 item；其他成功项可提交。没有成功项时返回同一原始密文 Buffer，保留状态与 headers。只有重编码完成才提交：保留内层 gzip，EAPI AES-128-ECB 加密，恢复原 HTTP identity/gzip/deflate/br，仅在原本有 Content-Length 时更新它，不新增其他响应头。

与 Stage 6 一样，出现 ETag/Content-MD5/Digest/Content-Digest/Repr-Digest/Content-Range/Trailer 任一头、非 200、未知 encoding、已结束流、已知 body 超限时跳过。缓冲和编码上限 1 MiB，响应整体期限 2 秒、最多 8 个缓冲响应；超限/超时/异常回放原缓冲前缀及后续原流，迟到结果不提交。额外限制最多 8 个尚未结束的 matcher 调用；响应超时不会释放仍在执行的 matcher 名额，避免累积后台调用。

独立日志仅允许 apiPath、examinedCount、matchedFailureCount、patchedCount、matcherFailedCount、skippedNoIdCount；不记录歌曲 ID/名、真实 URL、Cookie/token/header 或异常文本。matcherFailedCount 按失败 item 计数，去重后同 ID 的两个失败 item 仍计 2。跳过或整体超时记录零统计，不能从零统计判断歌曲状态。日志异步写入、最多 8 个在途写入，不排队，压力下可丢弃记录；写入/调度/诊断异常不影响响应。原 matcher 自身的常规日志行为未改变，最小诊断只收集下面指定内容。

源码、测试和回归脚本直接保存在本分支中；构建产物为 `precompiled/app.js`。部署与开关脚本位于 `scripts/`。

## 测试与回归

- 相关测试：9 套、244 项全部通过，其中 Stage 9 新增 47 项、既有 batch/XEAPI/privilege/observer 197 项。
- 覆盖精确失败签名、非法 ID、普通歌保持、最小字段回填、MD5/bitrate fallback、非 PC package、相同 ID 去重、部分成功、inner gzip on/off、HTTP identity/gzip/deflate/br、错误根结构/根 code、非目标/非 v1、损坏密文、完整性/范围头、超限、并发、超时前缀回放、异常和日志失败。未改响应断言状态、headers、密文正文逐字节一致。
- 本地 player 代理回归：6 轮 × 360 = **2160 次请求**，每轮 200 连续 + 160 并发度 8。基准是已验证 SHA `edd97a2f22757255a65c6bc05ec711200c84fccd14a4d1f8935763aa924bce10` 的 Stage 6，关闭 Stage 8 observer。Stage 9 编译产物关闭/开启/日志写失败，及源码测试进程 matcher 异常/成功均通过。成功回填在测试源码进程中注入固定 matcher；没有修改交付核心或新增生产测试开关。编译产物开启时覆盖普通歌、非法 ID、真实 matcher 失败和损坏密文等原样回退。
- observer 本地代理回归：4 轮 × 360 = **1440 次请求**。Stage 6 基准、observer 关闭/开启/写失败，状态、原始头数组、密文和上游请求全部一致。
- 两组共 **3600 次请求**；Stage 6 privilege 开关在两组中均为 true，权限补丁命中时与基准行为一致。
- 项目 build、app.js 语法检查、4 个部署脚本 sh -n 均通过。
- 全项目测试：14 套、272 项；266 通过、6 失败。5 个 bilivideo 线上 provider 测试在当前机器报证书链校验失败，1 个 spawn 测试预期 EACCES、Windows 返回 EFTYPE。它们在首次运行、加入 Stage 9 测试前就失败；未修改这些非任务范围测试，也未绕过 TLS 校验。后续实机播放结果见文首用户反馈。

复跑：在源码副本中运行 `node .yarn/releases/yarn-3.8.7.cjs test --runInBand --testPathPatterns='xeapi|privilege|batch|album-play'`、`node .yarn/releases/yarn-3.8.7.cjs build`。两组代理脚本参数为 Stage 6 app.js 的绝对路径；用 `node -r ./.pnp.cjs scripts/xeapi-player-url-regression.cjs <Stage6-app.js>` 和对应的 `scripts/album-play-regression.cjs`。

## 部署：先安装，Stage 9 保持关闭

保持核心自动更新关闭。将仓库 `precompiled/app.js` 上传为 `/tmp/app.js.stage9`。将四个 .sh 脚本上传至 /tmp，或者直接复制下方完整命令执行。脚本均为 LF 行尾。

假定核心 `/usr/share/unblockneteasemusic/core/app.js`，init `/etc/init.d/unblockneteasemusic`；Stage 8 observer 延续原 `UNM_ALBUM_PLAY_OBSERVER` 环境变量；init 中恰有一条 `procd_append_param env LOG_LEVEL=` 锚点。条件不满足会在停服务前退出。

先校验当前 Stage 8 SHA 和新文件 SHA，再分别备份 core 与完整 init，再切换。固定备份名若已经存在即退出，不覆盖旧备份。需要保存旧 run.log 时请先自行下载，服务重启可能删除它。执行：

```sh
sh /tmp/deploy-stage9.sh
```

脚本内容：

```sh
#!/bin/sh
set -eu
core=/usr/share/unblockneteasemusic/core/app.js
init=/etc/init.d/unblockneteasemusic
new=/tmp/app.js.stage9
old=cf2962cefa4f487e69058ab40b7aaf12cfd06901cab54947ea28bbd461514f9f
newsha=d8b0171e346f6655985669896197d5a65bc66afb7b783cc28af4b4c5370fdace
printf '%s  %s\n' "$old" "$core" | sha256sum -c -
printf '%s  %s\n' "$newsha" "$new" | sha256sum -c -
node --check < "$new"
test ! -e "$core.before-stage9"
test ! -e "$init.before-stage9"
test ! -e "$core.next-stage9"
test ! -e "$init.next-stage9"
test "$(grep -c 'procd_append_param env LOG_LEVEL=' "$init")" -eq 1
grep -q 'UNM_XEAPI_PRIVILEGE_PATCH=true' "$init"
if grep -q 'UNM_XEAPI_PLAYER_URL_PATCH=' "$init"; then
    echo 'Stage 9 environment already exists; inspect init before deployment.' >&2
    exit 1
fi
cp -p "$core" "$core.before-stage9"
cp -p "$init" "$init.before-stage9"
printf '%s  %s\n' "$old" "$core.before-stage9" | sha256sum -c -
cp "$new" "$core.next-stage9"
chmod 644 "$core.next-stage9"
sed -e 's/UNM_ALBUM_PLAY_OBSERVER=true/UNM_ALBUM_PLAY_OBSERVER=false/g' -e '/procd_append_param env LOG_LEVEL=/a\
procd_append_param env UNM_XEAPI_PLAYER_URL_PATCH=false UNM_XEAPI_PLAYER_URL_PATCH_LOG_FILE=/var/run/unblockneteasemusic/xeapi-player-url-patch.log # UNM_STAGE9' "$init" > "$init.next-stage9"
chmod 755 "$init.next-stage9"
sh -n "$init.next-stage9"
grep -q 'UNM_XEAPI_PRIVILEGE_PATCH=true' "$init.next-stage9"
printf '%s  %s\n' "$newsha" "$core.next-stage9" | sha256sum -c -
/etc/init.d/unblockneteasemusic stop
mv "$core.next-stage9" "$core"
mv "$init.next-stage9" "$init"
/etc/init.d/unblockneteasemusic start
printf '%s  %s\n' "$newsha" "$core" | sha256sum -c -
echo 'Stage 9 installed OFF; Stage 6 retained; observer OFF.'
```

安装完成仍保持 Stage 6=true、Stage 9=false、Stage 8 observer=false。先普通歌 B 播放一次；并检查监听与启动：

```sh
grep -E 'HTTP Server running|HTTPS Server running' /var/run/unblockneteasemusic/run.log | tail -n 5
netstat -lntp 2>/dev/null | grep -E '5200|5201'
```

## 启用 Stage 9（procd）

执行 `sh /tmp/enable-stage9.sh`，完整命令如下。单独 export 不能替代 procd 设置。

```sh
#!/bin/sh
set -eu
init=/etc/init.d/unblockneteasemusic
core=/usr/share/unblockneteasemusic/core/app.js
printf '%s  %s\n' 'd8b0171e346f6655985669896197d5a65bc66afb7b783cc28af4b4c5370fdace' "$core" | sha256sum -c -
grep -q 'UNM_XEAPI_PRIVILEGE_PATCH=true' "$init"
test "$(grep -c 'UNM_XEAPI_PLAYER_URL_PATCH=false' "$init")" -eq 1
test ! -e "$init.before-stage9-enable"
test ! -e "$init.next-stage9-enable"
cp -p "$init" "$init.before-stage9-enable"
sed 's/UNM_XEAPI_PLAYER_URL_PATCH=false/UNM_XEAPI_PLAYER_URL_PATCH=true/g' "$init" > "$init.next-stage9-enable"
chmod 755 "$init.next-stage9-enable"
sh -n "$init.next-stage9-enable"
grep -q 'UNM_XEAPI_PRIVILEGE_PATCH=true' "$init.next-stage9-enable"
mv "$init.next-stage9-enable" "$init"
/etc/init.d/unblockneteasemusic restart
```

只核对相关环境变量：

```sh
pid=$(ps w | awk '/[n]ode \/usr\/share\/unblockneteasemusic\/core\/app\.js/{print $1; exit}')
test -n "$pid"
tr '\0' '\n' < /proc/$pid/environ | grep -E '^UNM_(XEAPI_PRIVILEGE_PATCH|XEAPI_PLAYER_URL_PATCH|XEAPI_PLAYER_URL_PATCH_LOG_FILE|ALBUM_PLAY_OBSERVER)='
```

应看到 privilege=true、player=true、observer=false。保留原路由/证书设置；手机必须仍经过 UNM，未被此前临时 bypass 规则绕过。

## 只关闭 Stage 9，保留 Stage 6

执行 `sh /tmp/disable-stage9.sh`，保留 Stage 9 核心文件与 Stage 6=true，observer 仍关闭。它先创建独立配置备份，不覆盖现有备份。

```sh
#!/bin/sh
set -eu
init=/etc/init.d/unblockneteasemusic
core=/usr/share/unblockneteasemusic/core/app.js
printf '%s  %s\n' 'd8b0171e346f6655985669896197d5a65bc66afb7b783cc28af4b4c5370fdace' "$core" | sha256sum -c -
grep -q 'UNM_XEAPI_PRIVILEGE_PATCH=true' "$init"
test "$(grep -c 'UNM_XEAPI_PLAYER_URL_PATCH=true' "$init")" -eq 1
test ! -e "$init.before-stage9-disable"
test ! -e "$init.next-stage9-disable"
cp -p "$init" "$init.before-stage9-disable"
sed 's/UNM_XEAPI_PLAYER_URL_PATCH=true/UNM_XEAPI_PLAYER_URL_PATCH=false/g' "$init" > "$init.next-stage9-disable"
chmod 755 "$init.next-stage9-disable"
sh -n "$init.next-stage9-disable"
grep -q 'UNM_XEAPI_PRIVILEGE_PATCH=true' "$init.next-stage9-disable"
mv "$init.next-stage9-disable" "$init"
/etc/init.d/unblockneteasemusic restart
```

启用/关闭脚本的固定备份名各只使用一次；再次切换时若已有同名备份，先保存并重命名旧备份，脚本不会替你覆盖它。

## 完整回滚到本次部署前 Stage 8

执行 `sh /tmp/rollback-stage8.sh`，同时恢复 core 与部署前完整 init（包含 Stage 6 和原 Stage 8 observer 设置）。先验证 Stage 8 备份 SHA，再停服务切换。若部署后另行调整了其他 init 设置，完整回滚也会恢复为部署前版本；当前 init 会另存，不丢弃。

```sh
#!/bin/sh
set -eu
core=/usr/share/unblockneteasemusic/core/app.js
init=/etc/init.d/unblockneteasemusic
printf '%s  %s\n' 'd8b0171e346f6655985669896197d5a65bc66afb7b783cc28af4b4c5370fdace' "$core" | sha256sum -c -
printf '%s  %s\n' 'cf2962cefa4f487e69058ab40b7aaf12cfd06901cab54947ea28bbd461514f9f' "$core.before-stage9" | sha256sum -c -
test -f "$init.before-stage9"
sh -n "$init.before-stage9"
test ! -e "$core.stage9-before-rollback"
test ! -e "$init.stage9-before-rollback"
test ! -e "$core.next-stage9-rollback"
test ! -e "$init.next-stage9-rollback"
cp -p "$core" "$core.stage9-before-rollback"
cp -p "$init" "$init.stage9-before-rollback"
cp -p "$core.before-stage9" "$core.next-stage9-rollback"
cp -p "$init.before-stage9" "$init.next-stage9-rollback"
printf '%s  %s\n' 'cf2962cefa4f487e69058ab40b7aaf12cfd06901cab54947ea28bbd461514f9f' "$core.next-stage9-rollback" | sha256sum -c -
/etc/init.d/unblockneteasemusic stop
mv "$core.next-stage9-rollback" "$core"
mv "$init.next-stage9-rollback" "$init"
/etc/init.d/unblockneteasemusic start
printf '%s  %s\n' 'cf2962cefa4f487e69058ab40b7aaf12cfd06901cab54947ea28bbd461514f9f' "$core" | sha256sum -c -
```

## Android 9.6.05 实机验证与最小日志

1. 启用后强制关闭并重开网易云，先播放原本正常的普通歌 B，确认开始播放、进度推进，试听限制和原行为无异常。
2. 再点击已被 Stage 6 变为可点击的灰歌 A，等待开始播放；确认进度持续推进至少 15 秒并能听到对应歌曲。记录点击顺序和结果，避免将后台请求统计误当成 A/B 对应记录。
3. 若 B 异常，先执行 disable-stage9.sh，只关闭 Stage 9 保留 Stage 6，再重试 B；必要时执行完整回滚。
4. 若 A 仍不播放，保留独立 Stage 9 日志末尾及下列安全接口日志。patchedCount>0 只说明改写完成，不代表手机可以取到 package URL；matcherFailedCount>0 表示该响应的音源匹配未成功；skippedNoIdCount>0 表示缺少有效 ID。零统计/没有日志也可能是回退、跳过、缓冲或写入压力，不能据此断定接口没调用。

最小采集（在一次 B→A 操作之后运行）：

```sh
sha256sum /usr/share/unblockneteasemusic/core/app.js
tail -n 30 /var/run/unblockneteasemusic/xeapi-player-url-patch.log
grep -E 'NCM XEAPI response|NCM XEAPI observation skipped' /var/run/unblockneteasemusic/run.log | tail -n 20
pid=$(ps w | awk '/[n]ode \/usr\/share\/unblockneteasemusic\/core\/app\.js/{print $1; exit}')
test -n "$pid" && tr '\0' '\n' < /proc/$pid/environ | grep -E '^UNM_(XEAPI_PRIVILEGE_PATCH|XEAPI_PLAYER_URL_PATCH|XEAPI_PLAYER_URL_PATCH_LOG_FILE|ALBUM_PLAY_OBSERVER)='
```

同时提供 B/A 是否开始播放及等待秒数。不需要抓歌曲真实 URL、Cookie、token、完整请求头或解密响应。首次验证先保持 Stage 8 observer 关闭；如后续明确需要更细结构，可重新打开原 observer，但它看到的是最终客户端响应。日志在 /var/run 和 /tmp 下，重启前下载保存。
