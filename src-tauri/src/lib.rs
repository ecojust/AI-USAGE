mod quota;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    Manager,
};

#[tauri::command]
async fn get_usage() -> Result<quota::AccountQuotaSnapshot, String> {
    tauri::async_runtime::spawn_blocking(quota::read_account_quota)
        .await
        .map_err(|_| "读取额度任务意外结束".to_string())?
}

#[tauri::command]
fn fit_settings_window(window: tauri::WebviewWindow, content_height: f64) -> Result<(), String> {
    if !content_height.is_finite() || !(120.0..=1200.0).contains(&content_height) {
        return Err("设置面板高度无效".into());
    }

    window
        .set_size(tauri::LogicalSize::new(310.0, content_height))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_tray_display(
    app: tauri::AppHandle,
    title: String,
    rgba: Vec<u8>,
    width: u32,
    height: u32,
) -> Result<(), String> {
    if width == 0
        || width > 2048
        || height == 0
        || height > 128
        || rgba.len() != width as usize * height as usize * 4
    {
        return Err("菜单栏图像尺寸无效".into());
    }
    if let Some(tray) = app.tray_by_id("usage") {
        tray.set_icon(Some(tauri::image::Image::new_owned(rgba, width, height)))
            .map_err(|e| e.to_string())?;
        tray.set_icon_as_template(true).map_err(|e| e.to_string())?;
        tray.set_tooltip(Some(&title)).map_err(|e| e.to_string())?;
        tray.set_title(Some("")).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_usage,
            set_tray_display,
            fit_settings_window
        ])
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
            }
            tauri::WindowEvent::Focused(false) => {
                let _ = window.hide();
            }
            _ => {}
        })
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                app.set_dock_visibility(false);
            }

            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&quit_item])?;
            let tray = TrayIconBuilder::with_id("usage")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .title("5小时 — 本周 —")
                .tooltip("ChatGPT Codex 套餐额度")
                .on_menu_event(|app, event| {
                    if event.id().as_ref() == "quit" {
                        app.exit(0);
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        rect,
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let visible = window.is_visible().unwrap_or(false);
                            if visible {
                                let _ = window.hide();
                            } else {
                                if let (Ok(scale), Ok(physical_size)) =
                                    (window.scale_factor(), window.outer_size())
                                {
                                    let origin = rect.position.to_logical::<f64>(scale);
                                    let tray_size = rect.size.to_logical::<f64>(scale);
                                    let width = physical_size.width as f64 / scale;
                                    let x = origin.x + tray_size.width - width;
                                    let y = origin.y + tray_size.height + 4.0;
                                    let _ = window.set_position(tauri::Position::Logical(
                                        tauri::LogicalPosition::new(x, y),
                                    ));
                                }
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;
            let _ = tray.set_title(Some("5小时 — 本周 —"));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("启动 AI Usage 失败");
}
