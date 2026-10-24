mod camera_wifi;
mod import;
mod media;
mod render;
mod tools;
pub mod wireless;

use serde::{Deserialize, Serialize};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

use media::{CameraDrive, ClipInfo, MediaFile};
use render::{Encoder, ExportSettings, RunningExport, TimelineItem};
use tools::Tools;
use wireless::watch::Nearby;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
struct Settings {
    library_dir: Option<PathBuf>,
    ffmpeg_dir: Option<PathBuf>,
    lut_name: Option<String>,
    lut_size: Option<u32>,
}

struct AppState {
    settings: Mutex<Settings>,
    settings_path: PathBuf,
    cache_dir: PathBuf,
    default_library: PathBuf,
    import_cancel: AtomicBool,
    export: RunningExport,
    /// Resultado de probar el codificador de hardware; se borra al cambiar de ffmpeg.
    hardware: Mutex<Option<tools::Hardware>>,
    /// Cámaras encendidas cerca, según la detección por Bluetooth.
    nearby: Mutex<Nearby>,
    camera_wifi: camera_wifi::CameraWifi,
}

impl AppState {
    fn hardware(&self, tools: &Tools) -> tools::Hardware {
        *self.hardware.lock().unwrap().get_or_insert_with(|| tools::detect_hardware(tools))
    }

    fn settings(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }

    fn update(&self, change: impl FnOnce(&mut Settings)) -> Result<Settings, String> {
        let mut settings = self.settings.lock().unwrap();
        change(&mut settings);
        let json = serde_json::to_string_pretty(&*settings).map_err(|e| e.to_string())?;
        if let Some(dir) = self.settings_path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&self.settings_path, json).map_err(|e| format!("No pude guardar los ajustes: {e}"))?;
        Ok(settings.clone())
    }

    fn library(&self) -> PathBuf {
        self.settings().library_dir.unwrap_or_else(|| self.default_library.clone())
    }

    fn tools(&self) -> Result<Tools, String> {
        Tools::locate(self.settings().ffmpeg_dir.as_deref())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsView {
    library_dir: String,
    ffmpeg_dir: Option<String>,
    ffmpeg_error: Option<String>,
    lut_name: Option<String>,
    lut_size: Option<u32>,
    hardware: Option<tools::Hardware>,
    platform: &'static str,
}

fn view(state: &AppState) -> SettingsView {
    let settings = state.settings();
    let tools = state.tools();
    let hardware = tools.as_ref().ok().map(|t| state.hardware(t));
    SettingsView {
        library_dir: state.library().to_string_lossy().into_owned(),
        ffmpeg_dir: settings.ffmpeg_dir.map(|p| p.to_string_lossy().into_owned()),
        ffmpeg_error: tools.err(),
        lut_name: settings.lut_name,
        lut_size: settings.lut_size,
        hardware,
        platform: std::env::consts::OS,
    }
}

/// Ejecuta trabajo bloqueante (ffmpeg, copias) fuera del hilo de eventos.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| e.to_string())?
}

fn allow_dir(app: &AppHandle, dir: &Path) {
    let _ = app.asset_protocol_scope().allow_directory(dir, true);
}

fn cache_key(path: &Path, extra: &str) -> String {
    let meta = path.metadata().ok();
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    meta.as_ref().map(|m| m.len()).hash(&mut hasher);
    meta.and_then(|m| m.modified().ok()).hash(&mut hasher);
    extra.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

#[tauri::command]
async fn get_settings(state: State<'_, AppState>) -> Result<SettingsView, String> {
    Ok(view(&state))
}

#[tauri::command]
async fn set_library_dir(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<SettingsView, String> {
    let dir = PathBuf::from(path);
    std::fs::create_dir_all(&dir).map_err(|e| format!("No pude usar esa carpeta: {e}"))?;
    allow_dir(&app, &dir);
    state.update(|s| s.library_dir = Some(dir))?;
    Ok(view(&state))
}

#[tauri::command]
async fn set_ffmpeg_dir(state: State<'_, AppState>, path: Option<String>) -> Result<SettingsView, String> {
    state.update(|s| s.ffmpeg_dir = path.map(PathBuf::from))?;
    *state.hardware.lock().unwrap() = None;
    Ok(view(&state))
}

#[tauri::command]
async fn set_lut(state: State<'_, AppState>, path: String) -> Result<SettingsView, String> {
    let source = PathBuf::from(&path);
    let size = render::install_lut(&source, &state.cache_dir)?;
    let name = source.file_name().unwrap_or_default().to_string_lossy().into_owned();
    state.update(|s| {
        s.lut_name = Some(name);
        s.lut_size = Some(size);
    })?;
    Ok(view(&state))
}

#[tauri::command]
async fn clear_lut(state: State<'_, AppState>) -> Result<SettingsView, String> {
    let _ = std::fs::remove_file(state.cache_dir.join(render::ACTIVE_LUT));
    state.update(|s| {
        s.lut_name = None;
        s.lut_size = None;
    })?;
    Ok(view(&state))
}

#[tauri::command]
fn list_camera_drives() -> Vec<CameraDrive> {
    media::camera_drives()
}

#[tauri::command]
async fn scan_folder(app: AppHandle, path: String) -> Result<Vec<MediaFile>, String> {
    let dir = PathBuf::from(path);
    allow_dir(&app, &dir);
    blocking(move || media::scan_folder(&dir)).await
}

#[tauri::command]
async fn library_files(app: AppHandle, state: State<'_, AppState>) -> Result<Vec<MediaFile>, String> {
    let dir = state.library();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    allow_dir(&app, &dir);
    blocking(move || media::scan_folder(&dir)).await
}

#[tauri::command]
async fn probe_clip(state: State<'_, AppState>, path: String) -> Result<ClipInfo, String> {
    let tools = state.tools()?;
    blocking(move || media::probe(&tools, Path::new(&path))).await
}

#[tauri::command]
async fn start_import(app: AppHandle, state: State<'_, AppState>, paths: Vec<String>) -> Result<import::ImportSummary, String> {
    state.import_cancel.store(false, Ordering::Relaxed);
    let library = state.library();
    let sources: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    let handle = app.clone();
    blocking(move || {
        let state = handle.state::<AppState>();
        Ok(import::import_files(&sources, &library, &state.import_cancel, |progress| {
            let _ = handle.emit("import-progress", progress);
        }))
    })
    .await
}

#[tauri::command]
fn cancel_import(state: State<'_, AppState>) {
    state.import_cancel.store(true, Ordering::Relaxed);
}

#[tauri::command]
async fn thumbnail(state: State<'_, AppState>, path: String) -> Result<String, String> {
    let tools = state.tools()?;
    let cache = state.cache_dir.clone();
    blocking(move || {
        let source = PathBuf::from(&path);
        let out = cache.join("thumbs").join(format!("{}.jpg", cache_key(&source, "thumb360")));
        if !out.is_file() {
            std::fs::create_dir_all(out.parent().unwrap()).map_err(|e| e.to_string())?;
            let at = media::probe(&tools, &source).map(|i| (i.duration / 3.0).min(2.0)).unwrap_or(0.0);
            render::extract_frame(&tools, &cache, &source, at, false, 360, &out)?;
        }
        Ok(out.to_string_lossy().into_owned())
    })
    .await
}

#[derive(Serialize)]
struct FramePair {
    before: String,
    after: Option<String>,
}

#[tauri::command]
async fn compare_frames(state: State<'_, AppState>, path: String, at: f64) -> Result<FramePair, String> {
    let tools = state.tools()?;
    let cache = state.cache_dir.clone();
    let has_lut = state.settings().lut_name.is_some();
    blocking(move || {
        let source = PathBuf::from(&path);
        let dir = cache.join("frames");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let key = cache_key(&source, &format!("{at:.2}"));
        let before = dir.join(format!("{key}-a.jpg"));
        render::extract_frame(&tools, &cache, &source, at, false, 720, &before)?;
        let after = if has_lut {
            let out = dir.join(format!("{key}-b.jpg"));
            render::extract_frame(&tools, &cache, &source, at, true, 720, &out)?;
            Some(out.to_string_lossy().into_owned())
        } else {
            None
        };
        Ok(FramePair { before: before.to_string_lossy().into_owned(), after })
    })
    .await
}

/// Devuelve un archivo que la vista previa puede reproducir: el original si el
/// visor lo admite, si no una copia liviana generada una sola vez. La interfaz
/// pide `force_proxy` cuando el visor no logró reproducir el original.
#[tauri::command]
async fn preview_source(state: State<'_, AppState>, path: String, force_proxy: Option<bool>) -> Result<String, String> {
    let tools = state.tools()?;
    let cache = state.cache_dir.clone();
    let hardware = state.hardware(&tools);
    blocking(move || {
        let source = PathBuf::from(&path);
        let info = media::probe(&tools, &source)?;
        if info.browser_playable && !force_proxy.unwrap_or(false) {
            return Ok(path);
        }
        let out = cache.join("proxies").join(format!("{}.mp4", cache_key(&source, "proxy")));
        if !out.is_file() {
            std::fs::create_dir_all(out.parent().unwrap()).map_err(|e| e.to_string())?;
            let encoder = if hardware.h264 { hardware.encoder } else { Encoder::Cpu };
            render::make_proxy(&tools, &source, encoder, &out)?;
        }
        Ok(out.to_string_lossy().into_owned())
    })
    .await
}

#[tauri::command]
async fn start_export(
    app: AppHandle,
    state: State<'_, AppState>,
    items: Vec<TimelineItem>,
    settings: ExportSettings,
) -> Result<String, String> {
    if state.export.0.lock().unwrap().is_some() {
        return Err("Ya hay una exportación en curso".into());
    }
    let tools = state.tools()?;
    let cache = state.cache_dir.clone();
    let handle = app.clone();
    blocking(move || {
        let state = handle.state::<AppState>();
        render::run_export(&tools, &cache, &items, &settings, &state.export, |progress| {
            let _ = handle.emit("export-progress", progress);
        })
        .map(|p| p.to_string_lossy().into_owned())
    })
    .await
}

#[tauri::command]
async fn wireless_connect(app: AppHandle, state: State<'_, AppState>) -> Result<Vec<MediaFile>, String> {
    state.camera_wifi.connect(&app).await
}

#[tauri::command]
async fn wireless_import(app: AppHandle, state: State<'_, AppState>, paths: Vec<String>) -> Result<import::ImportSummary, String> {
    let library = state.library();
    state.camera_wifi.import(&app, paths, library).await
}

#[tauri::command]
async fn wireless_disconnect(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.camera_wifi.disconnect(&app).await;
    Ok(())
}

#[tauri::command]
fn nearby_cameras(state: State<'_, AppState>) -> Nearby {
    state.nearby.lock().unwrap().clone()
}

#[tauri::command]
fn cancel_export(state: State<'_, AppState>) -> bool {
    render::cancel_export(&state.export)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Miniaturas y vistas previas de la cámara por Wi-Fi (camera_wifi::serve).
        .register_asynchronous_uri_scheme_protocol("camara", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            std::thread::spawn(move || responder.respond(camera_wifi::serve(&app, &request)));
        })
        .setup(|app| {
            let paths = app.path();
            let settings_path = paths.app_config_dir()?.join("settings.json");
            let cache_dir = paths.app_cache_dir()?;
            let default_library = paths
                .video_dir()
                .unwrap_or_else(|_| paths.home_dir().unwrap_or_default())
                .join("ActionDeck");
            let settings: Settings = std::fs::read_to_string(&settings_path)
                .ok()
                .and_then(|t| serde_json::from_str(&t).ok())
                .unwrap_or_default();

            std::fs::create_dir_all(&cache_dir)?;
            allow_dir(app.handle(), &cache_dir);
            allow_dir(app.handle(), settings.library_dir.as_deref().unwrap_or(&default_library));

            app.manage(AppState {
                settings: Mutex::new(settings),
                settings_path,
                cache_dir,
                default_library,
                import_cancel: AtomicBool::new(false),
                export: RunningExport::default(),
                hardware: Mutex::new(None),
                nearby: Mutex::new(Nearby::default()),
                camera_wifi: camera_wifi::CameraWifi::default(),
            });

            // Como Mimo: detecta la cámara en cuanto se enciende.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(wireless::watch::watch(move |nearby| {
                *handle.state::<AppState>().nearby.lock().unwrap() = nearby.clone();
                let _ = handle.emit("nearby-cameras", nearby);
            }));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            set_library_dir,
            set_ffmpeg_dir,
            set_lut,
            clear_lut,
            list_camera_drives,
            scan_folder,
            library_files,
            probe_clip,
            start_import,
            cancel_import,
            thumbnail,
            compare_frames,
            preview_source,
            start_export,
            cancel_export,
            nearby_cameras,
            wireless_connect,
            wireless_import,
            wireless_disconnect,
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar ActionDeck");
}
