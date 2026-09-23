# ChatGPT 剩余额度口径

## 数据来源

优先 `CODEX_BINARY` 显式路径，其次 ChatGPT/Codex 桌面应用自带的 Codex 可执行文件，最后才查找用户安装的 CLI。启动 `codex app-server`，使用默认 stdio 传输，不附加已移除的 `--stdio` 参数。初始化后只调用 `account/rateLimits/read`。

请求放到后台线程，超时 20 秒。成功、失败或超时均清理子进程。代码不读取或输出凭据，不生成任务、不消耗推理额度。

## 正确解析账号主额度

1. 优先使用非 null 的 `result.rateLimits`。
2. 仅当它缺失或为 null，回退到 `rateLimitsByLimitId.codex`（兼容 `rate_limits_by_limit_id`）。
3. 不遍历或合并其他 limit ID。分桶映射可能包含消费控制或 Credits，数值不一定与账号主额度一致。
4. 分别读取 `primary`、`secondary` 的 `usedPercent`。缺少这个数值的窗口不可用，不当成 100% 剩余。
5. 剩余百分比为 `clamp(100 - usedPercent, 0, 100)`，保留小数参与判断。只有最终文本显示才格式化到最多一位小数。
6. 周期名称来自 `windowDurationMins`，不把 `primary` 固定视为 5 小时。`resetsAt` 保持 Unix 秒，与前端毫秒时钟比较时乘 1000。

例如同一响应的 `rateLimits.secondary.usedPercent = 11`，而映射表的 `codex.primary.usedPercent = 16`，应显示 **89% 剩余**，不是 84%。该冲突是回归测试覆盖的关键情况。

## 菜单栏显示与面板标记

菜单栏固定按 `5h 60% 7d 80%` 展示两个周期的剩余百分比，缺失或已过重置时刻的窗口显示 `—`。

面板的「当前限制」标记剔除缺失数值和已过重置时刻的窗口。平时选择有效周期最短的窗口；当任一窗口剩余 ≤ 15%，选择告急窗口中余量最低的窗口，并列时保留短周期优先。面板和菜单栏使用同一快照。刷新失败保留上次数据并标记失败；重置到期的旧数据不再作为当前额度。

本工具显示 ChatGPT 套餐内的 Codex 官方配额，不根据本地 Token 数量估算套餐余量。

## 验证

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib
# 只读检查本机已登录账号，输出归一化配额，不输出原始账号响应：
cargo test --manifest-path src-tauri/Cargo.toml --lib live_account_quota -- --ignored --nocapture
```
