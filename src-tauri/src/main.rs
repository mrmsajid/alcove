#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    webview::WebviewBuilder, window::WindowBuilder, AppHandle, Emitter, LogicalPosition,
    LogicalSize, Manager, WebviewUrl, WindowEvent,
};

const SIDEBAR_W: f64 = 280.0;
const TAB_PREFIX: &str = "tab-";

fn window_size(app: &AppHandle) -> Result<LogicalSize<f64>, String> {
    let win = app.get_window("main").ok_or("main window missing")?;
    let scale = win.scale_factor().map_err(|e| e.to_string())?;
    Ok(win.inner_size().map_err(|e| e.to_string())?.to_logical(scale))
}

fn content_size(app: &AppHandle) -> Result<LogicalSize<f64>, String> {
    let s = window_size(app)?;
    Ok(LogicalSize::new((s.width - SIDEBAR_W).max(1.0), s.height))
}

fn layout(app: &AppHandle) {
    let (Ok(full), Ok(content)) = (window_size(app), content_size(app)) else {
        return;
    };
    for (label, wv) in app.webviews() {
        if label == "ui" {
            let _ = wv.set_size(LogicalSize::new(SIDEBAR_W, full.height));
        } else if label.starts_with(TAB_PREFIX) {
            let _ = wv.set_position(LogicalPosition::new(SIDEBAR_W, 0.0));
            let _ = wv.set_size(content);
        }
    }
}

fn show_only(app: &AppHandle, id: Option<&str>) {
    let active = id.map(|i| format!("{TAB_PREFIX}{i}"));
    for (label, wv) in app.webviews() {
        if !label.starts_with(TAB_PREFIX) {
            continue;
        }
        if Some(&label) == active.as_ref() {
            let _ = wv.show();
        } else {
            let _ = wv.hide();
        }
    }
}

#[tauri::command]
fn open_tab(app: AppHandle, id: String, url: String) -> Result<(), String> {
    let window = app.get_window("main").ok_or("main window missing")?;
    let parsed = url.parse().map_err(|e| format!("bad url: {e}"))?;

    let nav_app = app.clone();
    let nav_id = id.clone();
    let builder = WebviewBuilder::new(format!("{TAB_PREFIX}{id}"), WebviewUrl::External(parsed))
        .on_navigation(move |u| {
            let _ = nav_app.emit(
                "tab-url",
                serde_json::json!({ "id": nav_id, "url": u.as_str() }),
            );
            true
        })
        .on_document_title_changed(|wv, title| {
            let id = wv.label().trim_start_matches(TAB_PREFIX).to_string();
            let _ = wv
                .app_handle()
                .emit("tab-title", serde_json::json!({ "id": id, "title": title }));
        });

    window
        .add_child(builder, LogicalPosition::new(SIDEBAR_W, 0.0), content_size(&app)?)
        .map_err(|e| e.to_string())?;
    show_only(&app, Some(&id));
    Ok(())
}

#[tauri::command]
fn switch_tab(app: AppHandle, id: Option<String>) {
    show_only(&app, id.as_deref());
}

#[tauri::command]
fn close_tab(app: AppHandle, id: String) {
    if let Some(wv) = app.get_webview(&format!("{TAB_PREFIX}{id}")) {
        let _ = wv.close();
    }
}

#[tauri::command]
fn navigate(app: AppHandle, id: String, url: String) -> Result<(), String> {
    let wv = app
        .get_webview(&format!("{TAB_PREFIX}{id}"))
        .ok_or("tab not open")?;
    wv.navigate(url.parse().map_err(|e| format!("bad url: {e}"))?)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn nav_action(app: AppHandle, id: String, action: String) -> Result<(), String> {
    let js = match action.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        _ => return Err("unknown action".into()),
    };
    app.get_webview(&format!("{TAB_PREFIX}{id}"))
        .ok_or("tab not open")?
        .eval(js)
        .map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            open_tab, switch_tab, close_tab, navigate, nav_action
        ])
        .setup(|app| {
            let window = WindowBuilder::new(app, "main")
                .title("Alcove")
                .inner_size(1280.0, 800.0)
                .min_inner_size(640.0, 400.0)
                .build()?;

            let size = window.inner_size()?.to_logical::<f64>(window.scale_factor()?);
            window.add_child(
                WebviewBuilder::new("ui", WebviewUrl::App("index.html".into())),
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(SIDEBAR_W, size.height),
            )?;

            let handle = app.handle().clone();
            window.on_window_event(move |e| {
                if matches!(e, WindowEvent::Resized(_)) {
                    layout(&handle);
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Alcove");
}
