//! Análisis de clips con ffprobe, búsqueda de archivos y detección de unidades
//! que parecen una cámara (tienen `DCIM`).

use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

use crate::devices::{self, ColorMode};
use crate::tools::Tools;

/// `osv`: video 360 de la Osmo 360 (un MP4 con una pista por lente).
const VIDEO_EXT: &[&str] = &["mp4", "mov", "osv"];
const PHOTO_EXT: &[&str] = &["jpg", "jpeg", "dng"];
/// Las cámaras DJI pueden grabar una copia de baja resolución (`.LRF`) al lado
/// de cada video. No se importa por defecto, pero sirve como vista previa.
const PROXY_EXT: &str = "lrf";

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaFile {
    pub path: String,
    pub name: String,
    pub kind: MediaKind,
    pub size: u64,
    /// Fecha de modificación en milisegundos desde 1970.
    pub modified_ms: i64,
    pub proxy_path: Option<String>,
    /// Miniatura ya hecha. Por Wi-Fi es una ruta en la cámara (`0/MISC/THM/…`);
    /// en carpetas locales, `None` (la interfaz la genera con ffmpeg).
    pub thumb: Option<String>,
    /// Segundos, cuando se saben sin analizar el archivo (por Wi-Fi).
    pub duration: Option<f64>,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Video,
    Photo,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClipInfo {
    pub duration: f64,
    /// Dimensiones tal como se ven (ya aplicada la rotación del archivo).
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub codec: String,
    pub pix_fmt: String,
    pub bit_depth: u32,
    pub color_transfer: Option<String>,
    pub color_primaries: Option<String>,
    pub has_audio: bool,
    pub creation_time: Option<String>,
    /// Si WebView2 puede reproducir el archivo directamente (H.264 de 8 bits).
    pub browser_playable: bool,
    /// Cámara que lo grabó, según la etiqueta `encoder` (`DJI OsmoAction5 Pro`).
    pub device: Option<String>,
    /// Perfil de color, de los metadatos `djmd` de DJI.
    pub color_mode: Option<ColorMode>,
    /// LUT oficial que lo lleva a Rec.709, si se grabó en un perfil logarítmico.
    pub suggested_lut: Option<String>,
    /// Video 360: una pista cuadrada por lente. Entonces `width`×`height` es
    /// la vista 16:9 que se saca de él, no el tamaño de las pistas.
    pub pano: bool,
}

pub fn probe(tools: &Tools, path: &Path) -> Result<ClipInfo, String> {
    let out = tools
        .ffprobe()
        .args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams"])
        .arg(path)
        .output()
        .map_err(|e| format!("No pude ejecutar ffprobe: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "ffprobe no pudo leer {}: {}",
            path.display(),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let json: Value = serde_json::from_slice(&out.stdout)
        .map_err(|e| format!("Respuesta de ffprobe inválida: {e}"))?;
    let mut info = parse_probe(&json)?;
    if let Some(index) = djmd_stream(&json) {
        info.color_mode = read_djmd(tools, path, index).as_deref().and_then(color_mode_from_djmd).map(ColorMode::from_dvtm);
    }
    let device = info.device.as_deref().and_then(devices::by_name);
    info.suggested_lut = info.color_mode.and_then(|mode| devices::suggested_lut(device, mode)).map(str::to_string);
    Ok(info)
}

/// La versión ligera `.LRF` que la cámara graba junto a un video, si está.
pub fn lrf_beside(path: &Path) -> Option<PathBuf> {
    ["LRF", "lrf"].into_iter().map(|ext| path.with_extension(ext)).find(|p| p.is_file())
}

/// Índice de la pista de metadatos de DJI (`djmd`), si el archivo la tiene.
fn djmd_stream(json: &Value) -> Option<u64> {
    json["streams"].as_array()?.iter().find(|s| s["codec_tag_string"] == "djmd")?["index"].as_u64()
}

/// El primer paquete de la pista `djmd`: describe el clip completo.
fn read_djmd(tools: &Tools, path: &Path, index: u64) -> Option<Vec<u8>> {
    let out = tools
        .ffmpeg()
        .args(["-v", "error", "-i"])
        .arg(path)
        .args(["-map", &format!("0:{index}"), "-c", "copy", "-frames:d", "1", "-f", "data", "-"])
        .output()
        .ok()?;
    (out.status.success() && !out.stdout.is_empty()).then_some(out.stdout)
}

enum Field<'a> {
    Varint(u64),
    Bytes(&'a [u8]),
    Other,
}

fn varint(buf: &[u8], pos: &mut usize) -> Option<u64> {
    let mut value = 0u64;
    for shift in (0..64).step_by(7) {
        let byte = *buf.get(*pos)?;
        *pos += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Some(value);
        }
    }
    None
}

/// Primer campo `number` de un mensaje protobuf, sin necesitar su esquema.
fn field(message: &[u8], number: u64) -> Option<Field<'_>> {
    let mut pos = 0;
    while pos < message.len() {
        let key = varint(message, &mut pos)?;
        let value = match key & 7 {
            0 => Field::Varint(varint(message, &mut pos)?),
            1 => {
                pos += 8;
                Field::Other
            }
            2 => {
                let len = varint(message, &mut pos)? as usize;
                let bytes = message.get(pos..pos.checked_add(len)?)?;
                pos += len;
                Field::Bytes(bytes)
            }
            5 => {
                pos += 4;
                Field::Other
            }
            _ => return None,
        };
        if key >> 3 == number {
            return Some(value);
        }
    }
    None
}

/// `ProductMeta.stream_meta(2).color_mode(4).color_mode(1)`, como en
/// `dvtm_oq101.proto` de telemetry-parser; la Action 5 Pro (`dvtm_ac204`)
/// usa la misma estructura.
pub fn color_mode_from_djmd(packet: &[u8]) -> Option<u64> {
    let Field::Bytes(stream_meta) = field(packet, 2)? else { return None };
    let Field::Bytes(color_mode) = field(stream_meta, 4)? else { return None };
    match field(color_mode, 1) {
        Some(Field::Varint(mode)) => Some(mode),
        // proto3 omite el valor por defecto (0, normal).
        None => Some(0),
        _ => None,
    }
}

pub fn parse_probe(json: &Value) -> Result<ClipInfo, String> {
    let streams = json["streams"].as_array().cloned().unwrap_or_default();
    let video = streams
        .iter()
        .find(|s| s["codec_type"] == "video" && s["disposition"]["attached_pic"] != 1)
        .ok_or("El archivo no tiene pista de video")?;
    let has_audio = streams.iter().any(|s| s["codec_type"] == "audio");
    // Las lentes de un 360 son pistas HEVC cuadradas (3840², o 1920² a 100 fps).
    let lenses = streams
        .iter()
        .filter(|s| {
            s["codec_type"] == "video"
                && s["disposition"]["attached_pic"] != 1
                && s["codec_name"] == "hevc"
                && s["width"] == s["height"]
                && s["width"].as_u64().unwrap_or(0) >= 1500
        })
        .count();
    let pano = lenses >= 2;

    let str_field = |v: &Value, key: &str| v[key].as_str().map(str::to_string);
    let pix_fmt = str_field(video, "pix_fmt").unwrap_or_default();
    let codec = str_field(video, "codec_name").unwrap_or_default();
    let bit_depth = video["bits_per_raw_sample"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| depth_from_pix_fmt(&pix_fmt));

    let mut width = video["width"].as_u64().unwrap_or(0) as u32;
    let mut height = video["height"].as_u64().unwrap_or(0) as u32;
    if rotation(video).rem_euclid(180) == 90 {
        std::mem::swap(&mut width, &mut height);
    }
    if pano {
        height = (width * 9 / 16) & !1;
    }

    let duration = json["format"]["duration"]
        .as_str()
        .or_else(|| video["duration"].as_str())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.0);

    let fps = video["avg_frame_rate"]
        .as_str()
        .and_then(parse_rate)
        .or_else(|| video["r_frame_rate"].as_str().and_then(parse_rate))
        .unwrap_or(0.0);

    let creation_time = json["format"]["tags"]["creation_time"]
        .as_str()
        .or_else(|| video["tags"]["creation_time"].as_str())
        .map(str::to_string);

    Ok(ClipInfo {
        duration,
        width,
        height,
        fps,
        browser_playable: !pano && browser_playable(&codec, bit_depth),
        codec,
        pix_fmt,
        bit_depth,
        color_transfer: str_field(video, "color_transfer"),
        color_primaries: str_field(video, "color_primaries"),
        has_audio,
        creation_time,
        device: json["format"]["tags"]["encoder"].as_str().and_then(devices::by_name).map(|d| d.name.to_string()),
        color_mode: None,
        suggested_lut: None,
        pano,
    })
}

/// WebView2 (Windows) solo reproduce H.264 de 8 bits sin extensiones extra;
/// WKWebView (macOS) también reproduce HEVC, incluido el de 10 bits.
fn browser_playable(codec: &str, bit_depth: u32) -> bool {
    let hevc_ok = cfg!(target_os = "macos") && codec == "hevc" && bit_depth <= 10;
    (codec == "h264" && bit_depth <= 8) || hevc_ok
}

fn rotation(video: &Value) -> i64 {
    let from_side_data = video["side_data_list"].as_array().and_then(|list| {
        list.iter()
            .find_map(|d| d["rotation"].as_i64().or_else(|| d["rotation"].as_f64().map(|r| r as i64)))
    });
    from_side_data
        .or_else(|| video["tags"]["rotate"].as_str().and_then(|s| s.parse().ok()))
        .unwrap_or(0)
}

fn parse_rate(rate: &str) -> Option<f64> {
    let (num, den) = rate.split_once('/')?;
    let (num, den): (f64, f64) = (num.parse().ok()?, den.parse().ok()?);
    (den != 0.0 && num != 0.0).then(|| num / den)
}

fn depth_from_pix_fmt(pix_fmt: &str) -> u32 {
    if pix_fmt.contains("12") {
        12
    } else if pix_fmt.contains("10") || pix_fmt.starts_with("p010") {
        10
    } else {
        8
    }
}

/// Busca videos y fotos dentro de `root` (hasta 6 niveles) y empareja cada
/// video con su `.LRF` si existe.
pub fn scan_folder(root: &Path) -> Result<Vec<MediaFile>, String> {
    if !root.is_dir() {
        return Err(format!("{} no es una carpeta", root.display()));
    }
    let mut files = Vec::new();
    let mut proxies = std::collections::HashMap::new();
    walk(root, 0, &mut |path| {
        let Some(ext) = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase) else {
            return;
        };
        if ext == PROXY_EXT {
            proxies.insert(stem_key(path), path.to_path_buf());
            return;
        }
        let kind = if VIDEO_EXT.contains(&ext.as_str()) {
            MediaKind::Video
        } else if PHOTO_EXT.contains(&ext.as_str()) {
            MediaKind::Photo
        } else {
            return;
        };
        let Ok(meta) = path.metadata() else { return };
        files.push(MediaFile {
            path: path.to_string_lossy().into_owned(),
            name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
            kind,
            size: meta.len(),
            modified_ms: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0),
            proxy_path: None,
            thumb: None,
            duration: None,
        });
    });
    for file in &mut files {
        if file.kind == MediaKind::Video {
            file.proxy_path = proxies
                .get(&stem_key(Path::new(&file.path)))
                .map(|p| p.to_string_lossy().into_owned());
        }
    }
    files.sort_by(|a, b| a.modified_ms.cmp(&b.modified_ms).then_with(|| a.name.cmp(&b.name)));
    Ok(files)
}

fn stem_key(path: &Path) -> PathBuf {
    path.with_extension("").to_string_lossy().to_lowercase().into()
}

fn walk(dir: &Path, depth: usize, visit: &mut dyn FnMut(&Path)) {
    if depth > 6 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            let hidden = entry.file_name().to_string_lossy().starts_with('.');
            if !hidden {
                walk(&path, depth + 1, visit);
            }
        } else if kind.is_file() {
            visit(&path);
        }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CameraDrive {
    pub root: String,
    pub dcim: String,
    pub label: String,
    pub removable: bool,
}

/// Unidades con carpeta `DCIM`: la cámara conectada por USB o su microSD en un
/// lector. En Windows se omite C: para no recorrer el disco del sistema.
#[cfg(windows)]
pub fn camera_drives() -> Vec<CameraDrive> {
    let mut drives = Vec::new();
    for letter in b'D'..=b'Z' {
        let root = format!("{}:\\", letter as char);
        let dcim = Path::new(&root).join("DCIM");
        if !dcim.is_dir() {
            continue;
        }
        drives.push(CameraDrive {
            label: volume_label(&root).unwrap_or_else(|| format!("Unidad {}:", letter as char)),
            removable: is_removable(&root),
            dcim: dcim.to_string_lossy().into_owned(),
            root,
        });
    }
    drives
}

/// macOS monta cada disco en `/Volumes/<nombre>`; Linux, en `/media/<usuario>`
/// o `/run/media/<usuario>`.
#[cfg(not(windows))]
pub fn camera_drives() -> Vec<CameraDrive> {
    let user = std::env::var("USER").unwrap_or_default();
    let mount_dirs = if cfg!(target_os = "macos") {
        vec![PathBuf::from("/Volumes")]
    } else {
        vec![PathBuf::from("/media").join(&user), PathBuf::from("/run/media").join(&user)]
    };
    let mut drives = Vec::new();
    for dir in mount_dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let root = entry.path();
            // En macOS el disco de arranque aparece como un enlace a `/`.
            if root.is_symlink() {
                continue;
            }
            let dcim = root.join("DCIM");
            if dcim.is_dir() {
                drives.push(CameraDrive {
                    label: entry.file_name().to_string_lossy().into_owned(),
                    removable: true,
                    dcim: dcim.to_string_lossy().into_owned(),
                    root: root.to_string_lossy().into_owned(),
                });
            }
        }
    }
    drives.sort_by(|a, b| a.label.cmp(&b.label));
    drives
}

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn is_removable(root: &str) -> bool {
    use windows_sys::Win32::Storage::FileSystem::GetDriveTypeW;
    const DRIVE_REMOVABLE: u32 = 2;
    unsafe { GetDriveTypeW(wide(root).as_ptr()) == DRIVE_REMOVABLE }
}

#[cfg(windows)]
fn volume_label(root: &str) -> Option<String> {
    use windows_sys::Win32::Storage::FileSystem::GetVolumeInformationW;
    let mut name = [0u16; 261];
    let ok = unsafe {
        GetVolumeInformationW(
            wide(root).as_ptr(),
            name.as_mut_ptr(),
            name.len() as u32,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
        )
    };
    let len = name.iter().position(|&c| c == 0).unwrap_or(0);
    (ok != 0 && len > 0).then(|| format!("{} ({})", String::from_utf16_lossy(&name[..len]), &root[..2]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Primer paquete `djmd` de un clip real de la Action 5 Pro grabado en D-Log M.
    const ACTION_5_PRO_DJMD: &str = "0a710a5a0a106476746d5f61633230342e70726f746f120830322e30312e30311a05322e302e312a0e38324a584e434730304532395153320b31302e30302e31362e313348d8c1b20c5213444a49204f736d6f416374696f6e352050726f1204080110014a02080172040a021c0a7a0082010012260a071a05766964656f1a1308801e10c0161d9cc2ef422001280a30044001220208132a020802";

    fn from_hex(hex: &str) -> Vec<u8> {
        (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect()
    }

    #[test]
    fn reads_the_color_profile_from_dji_metadata() {
        let packet = from_hex(ACTION_5_PRO_DJMD);
        assert_eq!(color_mode_from_djmd(&packet), Some(19));
        assert_eq!(ColorMode::from_dvtm(19), ColorMode::DLogM);
        assert_eq!(color_mode_from_djmd(&packet[..40]), None, "cortado no debe fallar");
        assert_eq!(color_mode_from_djmd(&[]), None);
    }

    #[test]
    fn two_square_lens_tracks_are_a_360_video() {
        let lens = json!({ "codec_type": "video", "codec_name": "hevc", "width": 3840, "height": 3840, "pix_fmt": "yuv420p10le", "avg_frame_rate": "25/1" });
        let probe = json!({
            "streams": [lens, lens, { "codec_type": "audio" }, { "codec_type": "video", "codec_name": "mjpeg", "width": 344, "height": 612, "disposition": { "attached_pic": 0 } }],
            "format": { "duration": "23.4", "tags": { "encoder": "Osmo 360" } }
        });
        let info = parse_probe(&probe).unwrap();
        assert!(info.pano && !info.browser_playable);
        assert_eq!((info.width, info.height), (3840, 2160));
        assert_eq!(info.device.as_deref(), Some("Osmo 360"));
    }

    #[test]
    fn recognizes_the_camera_from_the_encoder_tag() {
        let probe = json!({
            "streams": [{ "codec_type": "video", "codec_name": "hevc", "width": 3840, "height": 2160, "pix_fmt": "yuv420p10le" }],
            "format": { "duration": "16.4", "tags": { "encoder": "DJI OsmoAction5 Pro" } }
        });
        assert_eq!(parse_probe(&probe).unwrap().device.as_deref(), Some("Osmo Action 5 Pro"));
    }

    #[test]
    fn parses_10bit_hevc_with_rotation() {
        let probe = json!({
            "streams": [
                {"codec_type": "video", "codec_name": "hevc", "pix_fmt": "yuv420p10le",
                 "width": 3840, "height": 2160, "avg_frame_rate": "60000/1001",
                 "color_transfer": "bt709", "color_primaries": "bt709",
                 "side_data_list": [{"rotation": -90}]},
                {"codec_type": "audio", "codec_name": "aac"}
            ],
            "format": {"duration": "12.512000", "tags": {"creation_time": "2026-10-20T10:00:00Z"}}
        });
        let info = parse_probe(&probe).unwrap();
        assert_eq!((info.width, info.height), (2160, 3840));
        assert_eq!(info.bit_depth, 10);
        assert!((info.fps - 59.94).abs() < 0.01);
        assert!((info.duration - 12.512).abs() < 1e-9);
        assert!(info.has_audio);
        assert_eq!(info.browser_playable, cfg!(target_os = "macos"));
    }

    #[test]
    fn h264_8bit_is_browser_playable() {
        let probe = json!({
            "streams": [{"codec_type": "video", "codec_name": "h264", "pix_fmt": "yuv420p",
                         "width": 1920, "height": 1080, "avg_frame_rate": "30/1"}],
            "format": {"duration": "3.0"}
        });
        let info = parse_probe(&probe).unwrap();
        assert!(info.browser_playable);
        assert!(!info.has_audio);
    }

    #[test]
    fn scan_pairs_lrf_proxies_and_ignores_other_files() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("DCIM").join("DJI_001");
        std::fs::create_dir_all(&sub).unwrap();
        for name in ["DJI_20261020_0001_D.MP4", "DJI_20261020_0001_D.LRF", "DJI_0002.JPG", "notes.txt"] {
            std::fs::write(sub.join(name), b"x").unwrap();
        }
        let files = scan_folder(dir.path()).unwrap();
        assert_eq!(files.len(), 2);
        let video = files.iter().find(|f| f.kind == MediaKind::Video).unwrap();
        assert!(video.proxy_path.as_deref().unwrap().ends_with("DJI_20261020_0001_D.LRF"));
    }
}

