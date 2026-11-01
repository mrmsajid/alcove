#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

use tauri::{
    menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    webview::{DownloadEvent, NewWindowResponse, WebviewBuilder},
    window::WindowBuilder,
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WindowEvent, Wry,
};

const SIDEBAR_W: f64 = 280.0;
const TAB_PREFIX: &str = "tab-";
const PALETTE_PREFIX: &str = "palette-";

static PALETTE_SEQ: AtomicU32 = AtomicU32::new(0);

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

fn tab_webview(app: &AppHandle, id: &str) -> Result<tauri::Webview, String> {
    app.get_webview(&format!("{TAB_PREFIX}{id}"))
        .ok_or_else(|| "tab not open".to_string())
}

fn unique_path(path: PathBuf) -> PathBuf {
    if !path.exists() {
        return path;
    }
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let dir = path.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    (1..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .unwrap()
}

#[tauri::command]
fn open_tab(app: AppHandle, id: String, url: String) -> Result<(), String> {
    let window = app.get_window("main").ok_or("main window missing")?;
    let parsed = url.parse().map_err(|e| format!("bad url: {e}"))?;

    let nav_app = app.clone();
    let nav_id = id.clone();
    let new_win_app = app.clone();
    let builder = WebviewBuilder::new(format!("{TAB_PREFIX}{id}"), WebviewUrl::External(parsed))
        .disable_drag_drop_handler()
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
        })
        .on_new_window(move |url, _features| {
            let _ = new_win_app.emit("new-tab-request", serde_json::json!({ "url": url.as_str() }));
            NewWindowResponse::Deny
        })
        .on_download(|wv, event| {
            match event {
                DownloadEvent::Requested { url, destination } => {
                    let dir = wv
                        .app_handle()
                        .path()
                        .download_dir()
                        .unwrap_or_else(|_| std::env::temp_dir());
                    let name = destination
                        .file_name()
                        .map(|n| n.to_owned())
                        .unwrap_or_else(|| "download".into());
                    *destination = unique_path(dir.join(name));
                    let _ = wv.app_handle().emit(
                        "download",
                        serde_json::json!({
                            "state": "started",
                            "url": url.as_str(),
                            "path": destination.to_string_lossy(),
                        }),
                    );
                }
                DownloadEvent::Finished { url, path, success } => {
                    let _ = wv.app_handle().emit(
                        "download",
                        serde_json::json!({
                            "state": if success { "done" } else { "failed" },
                            "url": url.as_str(),
                            "path": path.map(|p| p.to_string_lossy().into_owned()),
                        }),
                    );
                }
                _ => {}
            }
            true
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
    if let Ok(wv) = tab_webview(&app, &id) {
        let _ = wv.close();
    }
}

#[tauri::command]
fn navigate(app: AppHandle, id: String, url: String) -> Result<(), String> {
    tab_webview(&app, &id)?
        .navigate(url.parse().map_err(|e| format!("bad url: {e}"))?)
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
    tab_webview(&app, &id)?.eval(js).map_err(|e| e.to_string())
}

#[tauri::command]
fn zoom(app: AppHandle, id: String, factor: f64) -> Result<(), String> {
    tab_webview(&app, &id)?
        .set_zoom(factor.clamp(0.25, 5.0))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn find(app: AppHandle, id: String, text: String, backwards: bool) -> Result<(), String> {
    let query = serde_json::to_string(&text).map_err(|e| e.to_string())?;
    let js = format!("window.find({query}, false, {backwards}, true, false, false, false)");
    tab_webview(&app, &id)?.eval(&js).map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_find(app: AppHandle, id: String) -> Result<(), String> {
    tab_webview(&app, &id)?
        .eval("getSelection().removeAllRanges()")
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn focus_ui(app: AppHandle) {
    if let Some(wv) = app.get_webview("ui") {
        let _ = wv.set_focus();
    }
}

#[tauri::command]
fn hide_palette(app: AppHandle) {
    for (label, wv) in app.webviews() {
        if label.starts_with(PALETTE_PREFIX) {
            let _ = wv.close();
        }
    }
}

// A fresh webview is created on every open so it always sits above the tab webviews.
#[tauri::command]
fn show_palette(app: AppHandle) -> Result<(), String> {
    hide_palette(app.clone());
    let window = app.get_window("main").ok_or("main window missing")?;
    let full = window_size(&app)?;
    let width = (full.width - SIDEBAR_W - 40.0).clamp(300.0, 580.0);
    let x = SIDEBAR_W + ((full.width - SIDEBAR_W - width) / 2.0).max(0.0);
    let label = format!("{PALETTE_PREFIX}{}", PALETTE_SEQ.fetch_add(1, Ordering::Relaxed));
    let wv = window
        .add_child(
            WebviewBuilder::new(label, WebviewUrl::App("palette.html".into()))
                .disable_drag_drop_handler(),
            LogicalPosition::new(x, 70.0),
            LogicalSize::new(width, 420.0_f64.min(full.height - 90.0).max(200.0)),
        )
        .map_err(|e| e.to_string())?;
    wv.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
fn reveal(path: String) {
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").args(["-R", &path]).spawn();
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("explorer")
        .arg(format!("/select,{path}"))
        .spawn();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = std::process::Command::new("xdg-open").arg(&path).spawn();
}

fn item(app: &AppHandle, id: &str, label: &str, accel: &str) -> tauri::Result<MenuItem<Wry>> {
    MenuItem::with_id(app, id, label, true, Some(accel))
}

// Native accelerators keep shortcuts working while a web page has keyboard focus.
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let sep = PredefinedMenuItem::separator(app)?;

    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &item(app, "new-tab", "New Tab", "CmdOrCtrl+T")?,
            &item(app, "reopen-tab", "Reopen Closed Tab", "CmdOrCtrl+Shift+T")?,
            &item(app, "close-tab", "Close Tab", "CmdOrCtrl+W")?,
            &sep,
            &item(app, "palette", "Command Palette", "CmdOrCtrl+K")?,
            &item(app, "focus-address", "Open Location", "CmdOrCtrl+L")?,
            &item(app, "bookmark", "Bookmark This Page", "CmdOrCtrl+D")?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &sep,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
            &sep,
            &item(app, "find", "Find in Page", "CmdOrCtrl+F")?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &item(app, "reload", "Reload", "CmdOrCtrl+R")?,
            &item(app, "back", "Back", "CmdOrCtrl+[")?,
            &item(app, "forward", "Forward", "CmdOrCtrl+]")?,
            &sep,
            &item(app, "zoom-in", "Zoom In", "CmdOrCtrl+=")?,
            &item(app, "zoom-out", "Zoom Out", "CmdOrCtrl+-")?,
            &item(app, "zoom-reset", "Actual Size", "CmdOrCtrl+0")?,
        ],
    )?;
    let library = Submenu::with_items(
        app,
        "Library",
        true,
        &[
            &item(app, "bookmarks", "Bookmarks", "CmdOrCtrl+Shift+B")?,
            &item(app, "history", "History", "CmdOrCtrl+Y")?,
            &item(app, "downloads", "Downloads", "CmdOrCtrl+Shift+J")?,
        ],
    )?;

    #[cfg(target_os = "macos")]
    let app_menu = Submenu::with_items(
        app,
        "Alcove",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &sep,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &sep,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let mut items: Vec<&dyn IsMenuItem<Wry>> = Vec::new();
    #[cfg(target_os = "macos")]
    items.push(&app_menu);
    items.extend([&file as &dyn IsMenuItem<Wry>, &edit, &view, &library]);
    Menu::with_items(app, &items)
}

fn main() {
    tauri::Builder::default()
        .menu(|app| build_menu(app))
        .on_menu_event(|app, event| {
            let _ = app.emit("shortcut", event.id().0.clone());
        })
        .invoke_handler(tauri::generate_handler![
            open_tab,
            switch_tab,
            close_tab,
            navigate,
            nav_action,
            zoom,
            find,
            clear_find,
            focus_ui,
            show_palette,
            hide_palette,
            reveal
        ])
        .setup(|app| {
            let window = WindowBuilder::new(app, "main")
                .title("Alcove")
                .inner_size(1280.0, 800.0)
                .min_inner_size(640.0, 400.0)
                .build()?;

            let size = window.inner_size()?.to_logical::<f64>(window.scale_factor()?);
            window.add_child(
                WebviewBuilder::new("ui", WebviewUrl::App("index.html".into()))
                    .disable_drag_drop_handler(),
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
