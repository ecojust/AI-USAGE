//! ChatGPT account quotas and parsing of the account rate-limit response.
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindow {
    used_percent: f64,
    remaining_percent: f64,
    window_duration_mins: Option<u64>,
    resets_at: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaBucket {
    limit_id: &'static str,
    limit_name: &'static str,
    plan_type: Option<String>,
    primary: Option<QuotaWindow>,
    secondary: Option<QuotaWindow>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountQuotaSnapshot {
    buckets: Vec<QuotaBucket>,
    updated_at: u64,
}

fn parse_quota_window(window_value: &Value) -> Option<QuotaWindow> {
    let used = window_value
        .get("usedPercent")?
        .as_f64()
        .filter(|n| n.is_finite())?;
    Some(QuotaWindow {
        used_percent: used.clamp(0.0, 100.0),
        remaining_percent: (100.0 - used).clamp(0.0, 100.0),
        window_duration_mins: window_value
            .get("windowDurationMins")
            .and_then(Value::as_u64),
        resets_at: window_value.get("resetsAt").and_then(Value::as_f64),
    })
}

fn parse_account_quota(result: &Value) -> Result<AccountQuotaSnapshot, String> {
    // Account headline wins. The ID map may contain spend/credit controls with
    // different percentages: never merge these into the account's windows.
    let limits = result
        .get("rateLimits")
        .filter(|v| !v.is_null())
        .or_else(|| {
            result
                .get("rateLimitsByLimitId")
                .or_else(|| result.get("rate_limits_by_limit_id"))
                .and_then(|v| v.get("codex"))
        })
        .ok_or("账号暂未提供 ChatGPT 套餐额度")?;
    let primary = limits.get("primary").and_then(parse_quota_window);
    let secondary = limits.get("secondary").and_then(parse_quota_window);
    if primary.is_none() && secondary.is_none() {
        return Err("账号未返回可用的套餐额度窗口，请确认使用 ChatGPT 账号登录".into());
    }
    Ok(AccountQuotaSnapshot {
        buckets: vec![QuotaBucket {
            limit_id: "codex",
            limit_name: "ChatGPT",
            plan_type: limits
                .get("planType")
                .and_then(Value::as_str)
                .map(str::to_owned),
            primary,
            secondary,
        }],
        updated_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    })
}

fn locate_codex_executable() -> PathBuf {
    if let Some(path) = std::env::var_os("CODEX_BINARY") {
        return path.into();
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    let mut paths = vec![
        home.join("Applications/ChatGPT.app/Contents/Resources/codex"),
        home.join("Applications/Codex.app/Contents/Resources/codex"),
        PathBuf::from("/Applications/ChatGPT.app/Contents/Resources/codex"),
        PathBuf::from("/Applications/Codex.app/Contents/Resources/codex"),
    ];
    for suffix in [
        ".local/bin/codex",
        ".npm-global/bin/codex",
        ".volta/bin/codex",
        ".bun/bin/codex",
        ".local/share/pnpm/codex",
        "Library/pnpm/codex",
    ] {
        paths.push(home.join(suffix));
    }
    if let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) {
        let mut versions: Vec<_> = entries
            .flatten()
            .map(|e| e.path().join("bin/codex"))
            .collect();
        versions.sort();
        paths.extend(versions.into_iter().rev());
    }
    paths.extend(
        [
            "/opt/homebrew/bin/codex",
            "/usr/local/bin/codex",
            "/usr/bin/codex",
        ]
        .map(PathBuf::from),
    );
    paths
        .into_iter()
        .find(|p| p.is_file())
        .unwrap_or_else(|| "codex".into())
}

struct AppServerProcess(Child);
impl Drop for AppServerProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn write_protocol_message(writer: &mut impl Write, message: Value) -> Result<(), String> {
    serde_json::to_writer(&mut *writer, &message).map_err(|_| "无法编码额度请求")?;
    writer
        .write_all(b"\n")
        .and_then(|_| writer.flush())
        .map_err(|_| "额度服务输入已关闭".into())
}

fn request_account_quota(timeout: Duration) -> Result<Value, String> {
    let executable = locate_codex_executable();
    let mut command = Command::new(&executable);
    // Current Codex defaults to stdio; --stdio was removed.
    command
        .arg("app-server")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // npm shims use /usr/bin/env node. Finder does not inherit a shell's PATH.
    let mut paths = vec![executable
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .to_path_buf()];
    paths.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    if let Ok(path) = std::env::join_paths(paths) {
        command.env("PATH", path);
    }
    let mut server = AppServerProcess(
        command
            .spawn()
            .map_err(|e| format!("无法启动额度服务（{}）：{e}", executable.display()))?,
    );
    let mut input = server.0.stdin.take().ok_or("额度服务输入不可用")?;
    let output = server.0.stdout.take().ok_or("额度服务输出不可用")?;
    let (tx, rx) = mpsc::sync_channel(32);
    std::thread::spawn(move || {
        let mut reader = BufReader::new(output);
        loop {
            let mut line = String::new();
            match reader.by_ref().take(1_000_001).read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) if line.len() > 1_000_000 => break,
                Ok(_) => {
                    if tx.send(line).is_err() {
                        break;
                    }
                }
            }
        }
    });
    write_protocol_message(
        &mut input,
        json!({"id":1,"method":"initialize","params":{
            "clientInfo":{"name":"ai_usage_menu_bar","title":"AI Usage","version":"0.1.0"},
            "capabilities":{"experimentalApi":true,"optOutNotificationMethods":[]}
        }}),
    )?;
    let deadline = Instant::now() + timeout;
    let mut initialized = false;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let line = rx.recv_timeout(remaining).map_err(|error| match error {
            mpsc::RecvTimeoutError::Timeout => "额度读取超时，请稍后重试".into(),
            mpsc::RecvTimeoutError::Disconnected => {
                let status = server
                    .0
                    .try_wait()
                    .ok()
                    .flatten()
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| "无输出".into());
                format!("额度服务提前退出（{status}），请更新 ChatGPT/Codex 后重试")
            }
        })?;
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let id = message.get("id").and_then(Value::as_u64);
        if id == Some(1) || id == Some(3) {
            if message.get("error").is_some() {
                return Err("额度服务拒绝请求，请确认已使用 ChatGPT 账号登录".into());
            }
        }
        if id == Some(1) && !initialized {
            write_protocol_message(&mut input, json!({"method":"initialized"}))?;
            write_protocol_message(
                &mut input,
                json!({"id":3,"method":"account/rateLimits/read"}),
            )?;
            initialized = true;
        } else if id == Some(3) && initialized {
            return message
                .get("result")
                .cloned()
                .ok_or("额度响应缺少结果".into());
        }
    }
}

pub fn read_account_quota() -> Result<AccountQuotaSnapshot, String> {
    parse_account_quota(&request_account_quota(Duration::from_secs(20))?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_headline_beats_conflicting_credit_buckets() {
        let result = json!({
            "rateLimits":{"primary":null,"secondary":{"usedPercent":11,"windowDurationMins":10080}},
            "rateLimitsByLimitId":{
                "codex":{"primary":{"usedPercent":16,"windowDurationMins":10080}},
                "credits":{"primary":{"usedPercent":99}}
            }
        });
        let snapshot = parse_account_quota(&result).unwrap();
        assert_eq!(snapshot.buckets.len(), 1);
        assert!(snapshot.buckets[0].primary.is_none());
        assert_eq!(
            snapshot.buckets[0]
                .secondary
                .as_ref()
                .unwrap()
                .remaining_percent,
            89.0
        );
    }

    #[test]
    fn fallback_only_uses_codex_and_preserves_weekly_duration() {
        for key in ["rateLimitsByLimitId", "rate_limits_by_limit_id"] {
            let mut result = json!({"rateLimits":null});
            result[key] = json!({"codex":{"primary":{"usedPercent":25.25,"windowDurationMins":10080}},"other":{"primary":{"usedPercent":99}}});
            let snapshot = parse_account_quota(&result).unwrap();
            let window = snapshot.buckets[0].primary.as_ref().unwrap();
            assert_eq!(window.remaining_percent, 74.75);
            assert_eq!(window.window_duration_mins, Some(10080));
        }
    }

    #[test]
    fn missing_usage_is_not_full_and_empty_headline_does_not_use_other_buckets() {
        assert!(parse_quota_window(&json!({"resetsAt":123})).is_none());
        assert!(parse_account_quota(
            &json!({"rateLimits":{},"rateLimitsByLimitId":{"codex":{"primary":{"usedPercent":50}}}})
        )
        .is_err());
        assert_eq!(
            parse_quota_window(&json!({"usedPercent":120}))
                .unwrap()
                .remaining_percent,
            0.0
        );
    }

    #[test]
    #[ignore = "reads the signed-in account via local Codex app-server"]
    fn live_account_quota() {
        let response = request_account_quota(Duration::from_secs(20)).unwrap();
        let snapshot = parse_account_quota(&response).unwrap();
        // Print only normalized usage, never raw account responses or credentials.
        println!("{}", serde_json::to_string(&snapshot).unwrap());
        assert_eq!(snapshot.buckets.len(), 1);
    }
}
