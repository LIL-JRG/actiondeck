//! Análisis de clips con ffprobe, búsqueda de archivos y detección de unidades
//! que parecen una cámara (tienen `DCIM`).

use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

use crate::tools::Tools;

const VIDEO_EXT: &[&str] = &["mp4", "mov"];
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
    parse_probe(&json)
}

pub fn parse_probe(json: &Value) -> Result<ClipInfo, String> {
    let streams = json["streams"].as_array().cloned().unwrap_or_default();
    let video = streams
        .iter()
        .find(|s| s["codec_type"] == "video" && s["disposition"]["attached_pic"] != 1)
        .ok_or("El archivo no tiene pista de video")?;
    let has_audio = streams.iter().any(|s| s["codec_type"] == "audio");

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
        browser_playable: codec == "h264" && bit_depth <= 8,
        codec,
        pix_fmt,
        bit_depth,
        color_transfer: str_field(video, "color_transfer"),
        color_primaries: str_field(video, "color_primaries"),
        has_audio,
        creation_time,
    })
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
/// lector. Se omite C: para no recorrer el disco del sistema.
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

#[cfg(not(windows))]
fn is_removable(_root: &str) -> bool {
    false
}

#[cfg(not(windows))]
fn volume_label(_root: &str) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
        assert!(!info.browser_playable);
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
