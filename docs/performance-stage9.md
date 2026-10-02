# Stage 9 路由器性能优化（2026-10-03）

优化基准为 commit 11c9ab8b94af25ee57f58283a572fdcc542ca4aa。优化构建核心 SHA256：`51a87abe4d6f53903c1b5372d24c6e1cb2d74b7186a1ab0e6b3af6301a893b17`；实机验证过的原 Stage 9 核心 SHA256：`d8b0171e346f6655985669896197d5a65bc66afb7b783cc28af4b4c5370fdace`。优化版尚未做路由器实机复验，保留原版 Release。

## 变化

- 缓存全表清理最多每分钟一次；每次命中独立检查有效期，不返回过期数据。
- 同一个缓存 key 的并发请求共享一次执行；失败不会进入缓存，后续可以重试。NO_CACHE=true 仍完全绕过缓存与合并。
- 默认关闭通用 XEAPI 请求日志与旁路响应解密；Stage 6/9 补丁处理独立运行。UNM_XEAPI_OBSERVER=true 可恢复通用诊断，需设置在 procd 环境中并重启服务。
- 既有 UNM_PRIVILEGE_OBSERVER、UNM_PRIVILEGE_VALUE_OBSERVER、UNM_ALBUM_PLAY_OBSERVER 开关仍观察原有目标接口。
- 开启 observer 时缓冲区从首个数据块按需分配，小响应通常仅分配 4 KiB，按需增长，上限保持 1 MiB。原版每个响应预先分配 1 MiB。
- 普通歌曲跳过逐项 Promise 与 JSON/data 副本分配；只对精确灰歌失败项调用 matcher，只有替换成功才复制 data。

没有更改音源优先级、成功回填字段、响应超时、并发上限、完整性/范围头跳过规则或原样回退规则。

## 本机微基准

Windows、Node.js v24.16.0、关闭日志；各场景预热 100 次，5 轮取中位数。以下只测对应代码路径，不代表端到端播放或路由器硬件的提速幅度。

| 场景                             |  原版耗时 | 优化版耗时 |
| -------------------------------- | --------: | ---------: |
| 128 条缓存，1000 次命中          |   9.40 ms |    0.42 ms |
| 4096 条缓存，1000 次命中         | 299.77 ms |    0.42 ms |
| 每响应 1 首普通歌，2000 次处理   |   0.60 ms |    0.14 ms |
| 每响应 512 首普通歌，2000 次处理 |  39.93 ms |    2.85 ms |

复跑时将基准版本 src/cache.js 与 src/xeapi-player-url-patch.js 分别保存为 cache.cjs、player.cjs，放在单独目录，然后运行：

```sh
node -r ./.pnp.cjs scripts/performance-benchmark.cjs /path/to/baseline-directory
```

## 验证

12 套相关测试、281 项断言通过，包括新增的过期命中、并发合并、失败重试、NO_CACHE、诊断关闭不接入流、原 observer 目标覆盖、缓冲扩容及普通歌不复制测试。

两组代理回归共 3600 次请求通过，验证响应状态、headers、未改响应的密文和上游请求保持一致，并验证源代码进程成功回填与 matcher 异常回退。全项目的外部音源在线测试与其他硬件平台不在此次结果中。

## 从原 Stage 9 升级

1. 将包内 app.js 上传到路由器 /tmp/app.js.stage9，将 upgrade-stage9-performance.sh 与 rollback-stage9-performance.sh 上传到 /tmp。
2. 执行 sh /tmp/upgrade-stage9-performance.sh。它严格验证原版与新版哈希，备份旧核心，仅替换核心文件；保留现有 init、证书、路由和 Stage 6/9 开关。
3. 重启手机网易云，验证普通歌、原灰歌、额外灰歌播放与服务重启后的开关。
4. 若有异常，执行 sh /tmp/rollback-stage9-performance.sh 恢复原 Stage 9 核心。

固定备份文件已经存在时脚本会退出；请先保存并重命名旧备份。关闭核心自动更新以保留指定版本。来自指定 Stage 8 的设备仍使用 deploy-stage9.sh 和 enable-stage9.sh，详见 stage9-deployment.md。
