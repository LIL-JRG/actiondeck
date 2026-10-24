//! Importar por Wi-Fi: despierta la cámara por Bluetooth (o la empareja la
//! primera vez), se une a su red, lista sus archivos y los descarga a la
//! biblioteca. Mientras dura, la computadora está en la red de la cámara y,
//! con un solo adaptador Wi-Fi, sin internet; por eso se sale al terminar de
//! importar o tras `IDLE` sin uso.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chrono::TimeZone;
use tauri::http::{Request, Response};
use tauri::{AppHandle, Emitter, Manager};

use crate::import::{self, ImportProgress, ImportSummary, Target};
use crate::media::{MediaFile, MediaKind};
use crate::wireless::{
    ble,
    config::{self, KnownCamera, WirelessConfig},
    datalink::{self, Datalink},
    download,
    log::Log,
    manifest::MediaRecord,
    wifi::{self, Joined},
};

/// Sin uso durante este tiempo, se sale de la red de la cámara.
const IDLE: Duration = Duration::from_secs(120);

struct Session {
    link: Datalink,
    joined: Joined,
    files: Vec<MediaRecord>,
    last_used: Instant,
}

#[derive(Default)]
pub struct CameraWifi {
    session: Mutex<Option<Session>>,
    /// Una conexión a la vez.
    connecting: tokio::sync::Mutex<()>,
    importing: AtomicBool,
}

fn phase(app: &AppHandle, text: &str) {
    let _ = app.emit("wireless-phase", text);
}

fn new_log() -> Log {
    Log::to_dir(&config::config_dir().join("diag-logs"), false)
}

/// Identificador estable de un archivo de la cámara para la interfaz.
fn id_of(r: &MediaRecord) -> String {
    format!("{}:{}", r.storage, r.file_path())
}

fn recorded_local(r: &MediaRecord) -> Option<chrono::DateTime<chrono::Local>> {
    let naive = chrono::NaiveDateTime::parse_from_str(r.recorded.as_deref()?, "%Y-%m-%dT%H:%M:%S").ok()?;
    chrono::Local.from_local_datetime(&naive).single()
}

/// Para la interfaz. `thumb` y `proxy_path` son rutas en la cámara que se
/// piden por el protocolo `camara://` (ver `serve`): la miniatura JPEG
/// `.scr` y la versión ligera `.LRF` de cada video.
fn as_media_file(r: &MediaRecord) -> MediaFile {
    let base = r.path.as_str();
    MediaFile {
        path: id_of(r),
        name: r.name.clone(),
        kind: if r.is_video() { MediaKind::Video } else { MediaKind::Photo },
        size: r.size,
        modified_ms: recorded_local(r).map(|d| d.timestamp_millis()).unwrap_or(0),
        proxy_path: r.is_video().then(|| format!("{}/{base}.LRF", r.storage)),
        thumb: r.thumb.as_ref().map(|t| format!("{}/{t}.scr", r.storage)),
        duration: r.duration.map(f64::from),
    }
}

/// Carpeta del día: la fecha de grabación, o la del nombre `DJI_AAAAMMDD…`.
fn day_of(r: &MediaRecord) -> String {
    if let Some(d) = recorded_local(r) {
        return d.format("%Y-%m-%d").to_string();
    }
    let digits: String = r.name.chars().skip_while(|c| !c.is_ascii_digit()).take(8).collect();
    if digits.len() == 8 && digits.chars().all(|c| c.is_ascii_digit()) {
        return format!("{}-{}-{}", &digits[..4], &digits[4..6], &digits[6..]);
    }
    "sin-fecha".into()
}

impl CameraWifi {
    /// Conecta (si no lo está) y devuelve los archivos de la cámara.
    pub async fn connect(&self, app: &AppHandle) -> Result<Vec<MediaFile>, String> {
        let _one = self.connecting.lock().await;
        if let Some(files) = self.touch() {
            return Ok(files.iter().map(as_media_file).collect());
        }
        let log = new_log();
        phase(app, "Buscando la cámara por Bluetooth…");
        let config_path = config::default_path();
        let mut wireless = WirelessConfig::load_or_create(&config_path)?;
        let found = ble::scan(&log, Duration::from_secs(6)).await?;
        let (mut paired, others): (Vec<_>, Vec<_>) =
            found.into_iter().partition(|c| wireless.cameras.iter().any(|k| k.name == c.name));
        let camera = paired
            .pop()
            .or_else(|| others.into_iter().next())
            .ok_or("No encontré la cámara. Enciéndela y acércala a la computadora.")?;

        phase(app, "Despertando la cámara…");
        let approval_app = app.clone();
        let creds = ble::fetch_credentials(&log, &camera, &wireless, true, move || {
            phase(&approval_app, "Acepta la conexión en la pantalla de la cámara (tienes unos 20 segundos)");
        })
        .await?;
        wireless.remember(KnownCamera {
            name: camera.name.clone(),
            model: camera.model.into(),
            ssid: creds.ssid.clone(),
            password: creds.password.clone(),
            wifi_mac: creds.wifi_mac.clone(),
        });
        wireless.save(&config_path)?;

        phase(app, "Uniéndome a la red Wi-Fi de la cámara…");
        let handle = app.clone();
        let (identifier, token) = (wireless.identifier.clone(), wireless.token.clone());
        let session = tauri::async_runtime::spawn_blocking(move || {
            open_session(&handle, &log, &creds.ssid, &creds.password, &identifier, &token)
        })
        .await
        .map_err(|e| e.to_string())??;

        let files: Vec<MediaFile> = session.files.iter().map(as_media_file).collect();
        *self.session.lock().unwrap() = Some(session);
        watch_idle(app.clone());
        phase(app, "");
        Ok(files)
    }

    /// Marca la sesión como usada y devuelve sus archivos.
    fn touch(&self) -> Option<Vec<MediaRecord>> {
        let mut guard = self.session.lock().unwrap();
        let session = guard.as_mut()?;
        session.last_used = Instant::now();
        Some(session.files.clone())
    }

    /// Como `touch`, sin copiar la lista: para cada petición de vista previa.
    fn keep_alive(&self) -> bool {
        match self.session.lock().unwrap().as_mut() {
            Some(session) => {
                session.last_used = Instant::now();
                true
            }
            None => false,
        }
    }

    /// Descarga `ids` a la biblioteca y sale de la red de la cámara.
    pub async fn import(
        &self,
        app: &AppHandle,
        ids: Vec<String>,
        library: PathBuf,
    ) -> Result<ImportSummary, String> {
        self.connect(app).await?;
        let files = self.touch().ok_or("Se perdió la conexión con la cámara")?;
        self.importing.store(true, Ordering::Relaxed);
        let handle = app.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            let state = handle.state::<crate::AppState>();
            download_all(&handle, &files, &ids, &library, &state.import_cancel)
        })
        .await
        .map_err(|e| e.to_string());
        self.importing.store(false, Ordering::Relaxed);
        self.disconnect(app).await;
        result
    }

    /// Sale de la red de la cámara y espera a que vuelva internet.
    pub async fn disconnect(&self, app: &AppHandle) {
        let Some(session) = self.session.lock().unwrap().take() else { return };
        phase(app, "Volviendo a tu red Wi-Fi…");
        let handle = app.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || close_session(session)).await;
        phase(&handle, "");
        let _ = handle.emit("wireless-closed", ());
    }
}

fn open_session(
    app: &AppHandle,
    log: &Log,
    ssid: &str,
    password: &str,
    identifier: &str,
    token: &str,
) -> Result<Session, String> {
    let joined = wifi::join_when_visible(log, ssid, password, Duration::from_secs(45))?;
    let opened = (|| -> Result<(Datalink, Vec<MediaRecord>), String> {
        if !wifi::wait_reachable(log, Duration::from_secs(25)) {
            return Err("La cámara no respondió en su red Wi-Fi".to_string());
        }
        phase(app, "Leyendo la lista de archivos…");
        let mut link = datalink::PORTS
            .iter()
            .find_map(|&(port, poke)| match Datalink::open(log, wifi::CAMERA_IP, port, poke.then_some((identifier, token))) {
                Ok(link) => Some(link),
                Err(e) => {
                    log.line(e);
                    None
                }
            })
            .ok_or("La cámara no abrió el enlace de datos")?;
        link.register();
        link.enter_playback(log);
        let mut files = match link.list_all(log) {
            Ok(files) => files,
            Err(e) => {
                link.close();
                return Err(e);
            }
        };
        link.start_keepalive();
        // La lista da 0 en archivos de más de 4 GB: se pregunta el tamaño.
        for f in files.iter_mut().filter(|f| f.size == 0) {
            f.size = download::head_size(f.storage, &f.file_path()).unwrap_or(0);
        }
        Ok((link, files))
    })();
    match opened {
        Ok((link, files)) => Ok(Session { link, joined, files, last_used: Instant::now() }),
        Err(e) => {
            let _ = wifi::leave(log, &joined);
            wifi::wait_internet(log, Duration::from_secs(30));
            Err(e)
        }
    }
}

fn close_session(session: Session) {
    let log = new_log();
    session.link.close();
    if let Err(e) = wifi::leave(&log, &session.joined) {
        log.line(format!("No pude salir de la red de la cámara: {e}"));
    }
    wifi::wait_internet(&log, Duration::from_secs(30));
}

/// Sale de la red de la cámara si nadie la usa durante `IDLE` o si la
/// cámara deja de contestar (se apagó o se alejó).
fn watch_idle(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            let state = app.state::<crate::AppState>();
            let wifi = &state.camera_wifi;
            let idle = match wifi.session.lock().unwrap().as_ref() {
                None => return,
                Some(s) => {
                    (s.last_used.elapsed() > IDLE && !wifi.importing.load(Ordering::Relaxed)) || !s.link.is_alive()
                }
            };
            if idle {
                wifi.disconnect(&app).await;
                return;
            }
        }
    });
}

fn download_all(
    app: &AppHandle,
    files: &[MediaRecord],
    ids: &[String],
    library: &Path,
    cancel: &AtomicBool,
) -> ImportSummary {
    cancel.store(false, Ordering::Relaxed);
    let chosen: Vec<&MediaRecord> = ids.iter().filter_map(|id| files.iter().find(|f| &id_of(f) == id)).collect();
    let total_bytes: u64 = chosen.iter().map(|f| f.size).sum();
    let mut summary = ImportSummary::default();
    let mut done_bytes = 0u64;

    for (index, file) in chosen.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            summary.cancelled = true;
            break;
        }
        let id = id_of(file);
        let dest = match import::target_at(library.join(day_of(file)).join(&file.name), file.size) {
            Target::AlreadyThere => {
                summary.skipped.push(id);
                done_bytes += file.size;
                continue;
            }
            Target::Copy(dest) => dest,
        };
        let base = done_bytes;
        let result = download::download(file.storage, &file.file_path(), &dest, Some(file.size), cancel, |done, _| {
            let _ = app.emit(
                "import-progress",
                ImportProgress {
                    file_index: index,
                    file_count: chosen.len(),
                    file_name: file.name.clone(),
                    copied_bytes: base + done,
                    total_bytes,
                },
            );
        });
        match result {
            Ok(Some(_)) => {
                if let Some(when) = recorded_local(file) {
                    let _ = std::fs::File::options()
                        .write(true)
                        .open(&dest)
                        .and_then(|f| f.set_modified(when.into()));
                }
                summary.copied.push(id);
            }
            Ok(None) => {
                summary.cancelled = true;
                break;
            }
            Err(e) => summary.failed.push((file.name.clone(), e)),
        }
        done_bytes = base + file.size;
    }
    summary
}

/// Tope por respuesta: el reproductor pide el resto en otras peticiones.
const SERVE_CHUNK: u64 = 2 * 1024 * 1024;

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = bytes.get(i + 1..i + 3).and_then(|h| std::str::from_utf8(h).ok()).and_then(|h| u8::from_str_radix(h, 16).ok());
        match (bytes[i], hex) {
            (b'%', Some(b)) => {
                out.push(b);
                i += 3;
            }
            (b, _) => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `bytes=a-b`, `bytes=a-` o `bytes=-n` acotado a `SERVE_CHUNK`, listo para
/// pedírselo a la cámara.
fn bounded_range(header: Option<&str>) -> String {
    let spec = header.and_then(|h| h.trim().strip_prefix("bytes=")).and_then(|r| r.split(',').next());
    let Some((a, b)) = spec.and_then(|r| r.trim().split_once('-')) else {
        return format!("bytes=0-{}", SERVE_CHUNK - 1);
    };
    match (a.parse::<u64>().ok(), b.parse::<u64>().ok()) {
        (Some(start), end) => {
            let last = start + SERVE_CHUNK - 1;
            format!("bytes={start}-{}", end.map_or(last, |e| e.min(last)))
        }
        (None, Some(suffix)) => format!("bytes=-{}", suffix.min(SERVE_CHUNK)),
        (None, None) => format!("bytes=0-{}", SERVE_CHUNK - 1),
    }
}

/// Protocolo `camara://localhost/<storage>/<ruta>`: miniaturas y vistas
/// previas directo de la cámara mientras la app está en su red. Pasa los
/// `Range` del reproductor a la cámara, que los admite, para saltar a
/// cualquier punto sin descargar el video.
pub fn serve(app: &AppHandle, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let plain = |status: u16, text: &str| {
        Response::builder().status(status).header("Content-Type", "text/plain").body(text.as_bytes().to_vec()).unwrap()
    };
    if !app.state::<crate::AppState>().camera_wifi.keep_alive() {
        return plain(503, "Sin conexión con la cámara");
    }
    let decoded = percent_decode(request.uri().path().trim_start_matches('/'));
    let Some((storage, path)) = decoded.split_once('/') else { return plain(400, "Ruta inválida") };
    let Ok(storage) = storage.parse::<u8>() else { return plain(400, "Ruta inválida") };
    if !(path.starts_with("DCIM/") || path.starts_with("MISC/")) || path.contains("..") {
        return plain(403, "Ruta no permitida");
    }
    let asked = request.headers().get("range").and_then(|v| v.to_str().ok());
    let range = bounded_range(asked);
    let response = match download::agent().get(&download::url(storage, path)).header("Range", &range).call() {
        Ok(r) => r,
        Err(e) => return plain(502, &e.to_string()),
    };
    let status = response.status().as_u16();
    if status != 200 && status != 206 {
        return plain(status, "La cámara no tiene ese archivo");
    }
    let content_range = response.headers().get("content-range").and_then(|v| v.to_str().ok()).map(String::from);
    let mut body = Vec::new();
    use std::io::Read as _;
    if let Err(e) = response.into_body().into_reader().take(SERVE_CHUNK).read_to_end(&mut body) {
        return plain(502, &e.to_string());
    }
    let lower = path.to_ascii_lowercase();
    let kind = if lower.ends_with(".scr") || lower.ends_with(".jpg") { "image/jpeg" } else { "video/mp4" };
    let total = content_range.as_deref().and_then(|c| c.rsplit('/').next()).and_then(|t| t.parse::<u64>().ok());
    // Una petición sin Range que cupo entera se contesta como 200.
    let whole = asked.is_none() && total.is_none_or(|t| t == body.len() as u64);
    let mut builder = Response::builder()
        .status(if whole { 200 } else { 206 })
        .header("Content-Type", kind)
        .header("Accept-Ranges", "bytes")
        .header("Access-Control-Allow-Origin", "*")
        .header("Content-Length", body.len().to_string());
    if !whole {
        if let Some(c) = &content_range {
            builder = builder.header("Content-Range", c);
        }
    }
    builder.body(body).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(name: &str, recorded: Option<&str>) -> MediaRecord {
        MediaRecord {
            path: format!("DCIM/DJI_001/{}", name.rsplit_once('.').unwrap().0),
            name: name.into(),
            thumb: None,
            handle: 0x0004_0010,
            size: 10,
            duration: Some(16),
            recorded: recorded.map(String::from),
            storage: 0,
        }
    }

    #[test]
    fn player_ranges_are_capped_for_the_camera() {
        assert_eq!(bounded_range(Some("bytes=0-1")), "bytes=0-1");
        assert_eq!(bounded_range(Some("bytes=100-")), format!("bytes=100-{}", 100 + SERVE_CHUNK - 1));
        assert_eq!(bounded_range(Some("bytes=0-99999999")), format!("bytes=0-{}", SERVE_CHUNK - 1));
        assert_eq!(bounded_range(Some("bytes=-500")), "bytes=-500");
        assert_eq!(bounded_range(None), format!("bytes=0-{}", SERVE_CHUNK - 1));
        assert_eq!(percent_decode("0%2FDCIM%2FDJI_001%2FA%20B.LRF"), "0/DCIM/DJI_001/A B.LRF");
    }

    #[test]
    fn camera_files_carry_their_thumbnail_and_preview() {
        let mut r = record("DJI_20261017203926_0043_D.MP4", Some("2026-10-17T20:39:26"));
        r.thumb = Some("MISC/THM/DJI_001/DJI_20261017203926_0043_D".into());
        let file = as_media_file(&r);
        assert_eq!(file.thumb.as_deref(), Some("0/MISC/THM/DJI_001/DJI_20261017203926_0043_D.scr"));
        assert_eq!(file.proxy_path.as_deref(), Some("0/DCIM/DJI_001/DJI_20261017203926_0043_D.LRF"));
        assert_eq!(file.duration, Some(16.0));
    }

    #[test]
    fn files_go_to_their_recording_day() {
        let r = record("DJI_20261017203926_0043_D.MP4", Some("2026-10-17T20:39:26"));
        assert_eq!(day_of(&r), "2026-10-17");
        assert_eq!(id_of(&r), "0:DCIM/DJI_001/DJI_20261017203926_0043_D.MP4");
        assert_eq!(day_of(&record("DJI_20261019074609_0049_D.MP4", None)), "2026-10-19");
        assert_eq!(day_of(&record("IMG.JPG", None)), "sin-fecha");
        let file = as_media_file(&r);
        assert_eq!((file.kind, file.size), (MediaKind::Video, 10));
        assert!(file.modified_ms > 0);
    }

    #[test]
    fn downloads_skip_what_the_library_already_has() {
        let lib = tempfile::tempdir().unwrap();
        let r = record("DJI_20261017203926_0043_D.MP4", Some("2026-10-17T20:39:26"));
        let first = lib.path().join("2026-10-17").join(&r.name);
        std::fs::create_dir_all(first.parent().unwrap()).unwrap();
        std::fs::write(&first, vec![0u8; 10]).unwrap();
        assert!(matches!(import::target_at(first, r.size), Target::AlreadyThere));
    }
}
