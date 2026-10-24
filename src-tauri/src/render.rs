//! Exportación (recortar, aplicar LUT, unir), cuadros de comparación y proxies
//! de vista previa, todo con ffmpeg.
//!
//! Escapar una ruta de Windows dentro de un filtro de ffmpeg (`C\:/...`) es
//! frágil, así que la LUT activa se copia a la carpeta de caché con un nombre
//! simple y ffmpeg se ejecuta con esa carpeta como directorio de trabajo.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::Mutex;

use crate::tools::Tools;

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TimelineItem {
    pub path: String,
    pub in_point: f64,
    pub out_point: f64,
    pub apply_lut: bool,
    pub has_audio: bool,
}

#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Codec {
    H264,
    Hevc,
}

#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Encoder {
    Cpu,
    Nvenc,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExportSettings {
    pub output: String,
    pub codec: Codec,
    pub encoder: Encoder,
    /// 0 (mejor) a 51; 18–23 es lo habitual.
    pub quality: u8,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    pub seconds_done: f64,
    pub seconds_total: f64,
    pub speed: Option<String>,
}

/// Nombre de la LUT activa dentro de la carpeta de caché.
pub const ACTIVE_LUT: &str = "active.cube";

/// Comprueba que el archivo sea una LUT 3D `.cube` y devuelve su tamaño.
pub fn validate_cube(path: &Path) -> Result<u32, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("No pude leer la LUT: {e}"))?;
    let size = text
        .lines()
        .map(str::trim)
        .find_map(|l| l.strip_prefix("LUT_3D_SIZE"))
        .and_then(|s| s.trim().parse::<u32>().ok())
        .ok_or("El archivo no es una LUT 3D .cube (falta LUT_3D_SIZE)")?;
    let rows = text
        .lines()
        .map(str::trim)
        .filter(|l| l.split_whitespace().count() == 3 && l.split_whitespace().all(|v| v.parse::<f64>().is_ok()))
        .count() as u64;
    let expected = u64::from(size).pow(3);
    if rows != expected {
        return Err(format!("La LUT dice tamaño {size} pero tiene {rows} de {expected} valores"));
    }
    Ok(size)
}

pub fn install_lut(source: &Path, cache_dir: &Path) -> Result<u32, String> {
    let size = validate_cube(source)?;
    std::fs::create_dir_all(cache_dir).map_err(|e| e.to_string())?;
    std::fs::copy(source, cache_dir.join(ACTIVE_LUT)).map_err(|e| format!("No pude copiar la LUT: {e}"))?;
    Ok(size)
}

fn lut_filter() -> String {
    format!("lut3d=file={ACTIVE_LUT}:interp=tetrahedral")
}

fn encoder_args(settings: &ExportSettings) -> Vec<String> {
    let q = settings.quality.min(51).to_string();
    let args: Vec<&str> = match (settings.codec, settings.encoder) {
        (Codec::H264, Encoder::Cpu) => vec!["-c:v", "libx264", "-preset", "medium", "-crf", &q, "-pix_fmt", "yuv420p"],
        (Codec::H264, Encoder::Nvenc) => vec![
            "-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", &q, "-b:v", "0", "-pix_fmt", "yuv420p",
        ],
        (Codec::Hevc, Encoder::Cpu) => vec![
            "-c:v", "libx265", "-preset", "medium", "-crf", &q, "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1",
        ],
        (Codec::Hevc, Encoder::Nvenc) => vec![
            "-c:v", "hevc_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", &q, "-b:v", "0", "-pix_fmt", "p010le",
            "-profile:v", "main10", "-tag:v", "hvc1",
        ],
    };
    args.into_iter().map(String::from).collect()
}

/// Arma los argumentos de ffmpeg para exportar la línea de tiempo a `output`.
/// Cada clip se recorta al leerlo, se le aplica la LUT si corresponde, se
/// lleva a la resolución y cuadros por segundo de salida, y después se unen.
pub fn build_export_args(items: &[TimelineItem], settings: &ExportSettings, output: &Path) -> Result<Vec<String>, String> {
    if items.is_empty() {
        return Err("La línea de tiempo está vacía".into());
    }
    if settings.width == 0 || settings.height == 0 || settings.width % 2 == 1 || settings.height % 2 == 1 {
        return Err("La resolución de salida debe ser par y mayor que cero".into());
    }
    if !(settings.fps > 0.0) {
        return Err("Los cuadros por segundo deben ser mayores que cero".into());
    }

    let mut args: Vec<String> = ["-hide_banner", "-y", "-nostats", "-progress", "pipe:1", "-loglevel", "error"]
        .map(String::from)
        .into();
    let (w, h) = (settings.width, settings.height);
    let mut graph = Vec::new();
    let mut concat_inputs = String::new();

    for (i, item) in items.iter().enumerate() {
        let duration = item.out_point - item.in_point;
        if !(duration > 0.0) {
            return Err(format!("El clip {} tiene el final antes del inicio", i + 1));
        }
        args.extend(["-ss".into(), secs(item.in_point), "-t".into(), secs(duration), "-i".into(), item.path.clone()]);

        let mut video = Vec::new();
        if item.apply_lut {
            video.push(lut_filter());
        }
        video.push(format!("scale={w}:{h}:force_original_aspect_ratio=decrease:flags=lanczos"));
        video.push(format!("pad={w}:{h}:(ow-iw)/2:(oh-ih)/2"));
        video.push("setsar=1".into());
        video.push(format!("fps={}", settings.fps));
        // ffmpeg toma las etiquetas de color de los cuadros, no de las opciones
        // de salida; sin esto el archivo queda con primarios y curva "unknown".
        video.push("setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv".into());
        graph.push(format!("[{i}:v:0]{}[v{i}]", video.join(",")));

        if item.has_audio {
            graph.push(format!("[{i}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a{i}]"));
        } else {
            graph.push(format!("anullsrc=r=48000:cl=stereo,atrim=duration={}[a{i}]", secs(duration)));
        }
        concat_inputs.push_str(&format!("[v{i}][a{i}]"));
    }
    graph.push(format!("{concat_inputs}concat=n={}:v=1:a=1[vout][aout]", items.len()));

    args.extend(["-filter_complex".into(), graph.join(";")]);
    args.extend(["-map", "[vout]", "-map", "[aout]"].map(String::from));
    args.extend(encoder_args(settings));
    // Con LUT el resultado queda en Rec.709; sin LUT se conservan los colores
    // originales, que en las cámaras DJI también se etiquetan como BT.709.
    args.extend(
        ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"]
            .map(String::from),
    );
    args.extend(["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"].map(String::from));
    args.push(output.to_string_lossy().into_owned());
    Ok(args)
}

fn secs(value: f64) -> String {
    format!("{value:.3}")
}

/// Proceso de exportación en curso, para poder cancelarlo.
#[derive(Default)]
pub struct RunningExport(pub Mutex<Option<Child>>);

pub fn run_export(
    tools: &Tools,
    cache_dir: &Path,
    items: &[TimelineItem],
    settings: &ExportSettings,
    running: &RunningExport,
    mut on_progress: impl FnMut(ExportProgress),
) -> Result<PathBuf, String> {
    let output = PathBuf::from(&settings.output);
    if items.iter().any(|i| i.apply_lut) && !cache_dir.join(ACTIVE_LUT).is_file() {
        return Err("Elige una LUT en Ajustes antes de exportar con color corregido".into());
    }
    let parent = output.parent().ok_or("Ruta de salida inválida")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let stem = output.file_stem().unwrap_or_default().to_string_lossy();
    let ext = output.extension().unwrap_or_default().to_string_lossy();
    let partial = parent.join(format!("{stem}.exportando.{ext}"));

    let args = build_export_args(items, settings, &partial)?;
    let total: f64 = items.iter().map(|i| i.out_point - i.in_point).sum();

    let mut child = tools
        .ffmpeg()
        .args(&args)
        .current_dir(cache_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("No pude iniciar ffmpeg: {e}"))?;
    let stdout = child.stdout.take().ok_or("ffmpeg sin salida")?;
    let stderr = child.stderr.take().ok_or("ffmpeg sin salida de errores")?;
    *running.0.lock().unwrap() = Some(child);

    let errors = std::thread::spawn(move || {
        let mut text = String::new();
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            text.push_str(&line);
            text.push('\n');
        }
        text
    });

    let mut speed = None;
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if let Some(v) = line.strip_prefix("speed=") {
            speed = Some(v.trim().to_string());
        } else if let Some(v) = line.strip_prefix("out_time_us=") {
            if let Ok(us) = v.trim().parse::<f64>() {
                on_progress(ExportProgress { seconds_done: (us / 1e6).min(total), seconds_total: total, speed: speed.clone() });
            }
        }
    }

    let child = running.0.lock().unwrap().take();
    let status = match child {
        Some(mut c) => c.wait().map_err(|e| e.to_string())?,
        None => {
            let _ = std::fs::remove_file(&partial);
            return Err("Exportación cancelada".into());
        }
    };
    let stderr_text = errors.join().unwrap_or_default();
    if !status.success() {
        let _ = std::fs::remove_file(&partial);
        return Err(format!("ffmpeg falló: {}", stderr_text.trim()));
    }
    if output.exists() {
        std::fs::remove_file(&output).map_err(|e| format!("No pude reemplazar {}: {e}", output.display()))?;
    }
    std::fs::rename(&partial, &output).map_err(|e| e.to_string())?;
    on_progress(ExportProgress { seconds_done: total, seconds_total: total, speed });
    Ok(output)
}

pub fn cancel_export(running: &RunningExport) -> bool {
    match running.0.lock().unwrap().take() {
        Some(mut child) => {
            let _ = child.kill();
            let _ = child.wait();
            true
        }
        None => false,
    }
}

/// Extrae un cuadro como JPG, con o sin la LUT, para comparar antes y después.
pub fn extract_frame(
    tools: &Tools,
    cache_dir: &Path,
    source: &Path,
    at: f64,
    apply_lut: bool,
    max_height: u32,
    output: &Path,
) -> Result<(), String> {
    if apply_lut && !cache_dir.join(ACTIVE_LUT).is_file() {
        return Err("No hay LUT elegida".into());
    }
    let mut filters = Vec::new();
    if apply_lut {
        filters.push(lut_filter());
    }
    filters.push(format!("scale=-2:'min({max_height},ih)'"));
    let out = tools
        .ffmpeg()
        .current_dir(cache_dir)
        .args(["-hide_banner", "-loglevel", "error", "-y", "-ss", &secs(at.max(0.0)), "-i"])
        .arg(source)
        .args(["-frames:v", "1", "-vf", &filters.join(","), "-q:v", "3"])
        .arg(output)
        .output()
        .map_err(|e| format!("No pude ejecutar ffmpeg: {e}"))?;
    if !out.status.success() || !output.is_file() {
        return Err(format!("No pude extraer el cuadro: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(())
}

/// Versión liviana en H.264 de 8 bits para reproducir en la app videos que
/// WebView2 no reproduce (HEVC de 10 bits).
pub fn make_proxy(tools: &Tools, source: &Path, encoder: Encoder, output: &Path) -> Result<(), String> {
    let partial = output.with_extension("part.mp4");
    let video_codec: &[&str] = match encoder {
        Encoder::Nvenc => &["-c:v", "h264_nvenc", "-preset", "p3", "-cq", "28"],
        Encoder::Cpu => &["-c:v", "libx264", "-preset", "veryfast", "-crf", "28"],
    };
    let out = tools
        .ffmpeg()
        .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
        .arg(source)
        .args(["-vf", "scale=-2:'min(540,ih)',format=yuv420p"])
        .args(video_codec)
        .args(["-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"])
        .arg(&partial)
        .output()
        .map_err(|e| format!("No pude ejecutar ffmpeg: {e}"))?;
    if !out.status.success() {
        let _ = std::fs::remove_file(&partial);
        return Err(format!("No pude crear la vista previa: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    std::fs::rename(&partial, output).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> ExportSettings {
        ExportSettings {
            output: "out.mp4".into(),
            codec: Codec::H264,
            encoder: Encoder::Cpu,
            quality: 20,
            width: 1920,
            height: 1080,
            fps: 30.0,
        }
    }

    fn item(path: &str, apply_lut: bool, has_audio: bool) -> TimelineItem {
        TimelineItem { path: path.into(), in_point: 1.0, out_point: 3.5, apply_lut, has_audio }
    }

    #[test]
    fn graph_trims_applies_lut_and_concats() {
        let items = [item(r"C:\Videos\a b.MP4", true, true), item(r"C:\Videos\c.MP4", false, false)];
        let args = build_export_args(&items, &settings(), Path::new("out.mp4")).unwrap();
        let graph = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert!(graph.starts_with("[0:v:0]lut3d=file=active.cube"));
        assert!(!graph.contains("[1:v:0]lut3d"));
        assert!(graph.contains("anullsrc=r=48000:cl=stereo,atrim=duration=2.500[a1]"));
        assert!(graph.ends_with("[v0][a0][v1][a1]concat=n=2:v=1:a=1[vout][aout]"));
        let first_input = args.iter().position(|a| a == "-i").unwrap();
        assert_eq!(&args[first_input - 4..=first_input + 1], ["-ss", "1.000", "-t", "2.500", "-i", r"C:\Videos\a b.MP4"]);
    }

    #[test]
    fn rejects_bad_ranges_and_odd_sizes() {
        let mut bad = item("a.mp4", false, true);
        bad.out_point = 0.5;
        assert!(build_export_args(&[bad], &settings(), Path::new("o.mp4")).is_err());
        let odd = ExportSettings { width: 1919, ..settings() };
        assert!(build_export_args(&[item("a.mp4", false, true)], &odd, Path::new("o.mp4")).is_err());
        assert!(build_export_args(&[], &settings(), Path::new("o.mp4")).is_err());
    }

    #[test]
    fn hevc_nvenc_keeps_10_bit() {
        let s = ExportSettings { codec: Codec::Hevc, encoder: Encoder::Nvenc, ..settings() };
        let args = encoder_args(&s);
        assert!(args.windows(2).any(|w| w == ["-pix_fmt", "p010le"]));
        assert!(args.windows(2).any(|w| w == ["-profile:v", "main10"]));
    }

    fn ffmpeg_ok(tools: &Tools, args: &[&str]) {
        let out = tools.ffmpeg().args(["-hide_banner", "-loglevel", "error", "-y"]).args(args).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    }

    /// Color promedio (RGB) de un cuadro del archivo. Con `at = None` lee una
    /// imagen, donde `-ss` descartaría su único cuadro.
    fn pixel_at(tools: &Tools, file: &Path, at: Option<f64>) -> [u8; 3] {
        let mut cmd = tools.ffmpeg();
        cmd.args(["-hide_banner", "-loglevel", "error"]);
        if let Some(at) = at {
            cmd.args(["-ss", &secs(at)]);
        }
        let out = cmd
            .arg("-i")
            .arg(file)
            .args(["-frames:v", "1", "-vf", "scale=1:1:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
            .output()
            .unwrap();
        assert!(out.stdout.len() >= 3, "sin datos en {}: {}", file.display(), String::from_utf8_lossy(&out.stderr));
        out.stdout[..3].try_into().unwrap()
    }

    /// Prueba completa con ffmpeg real: `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn exports_real_files_with_lut_only_where_requested() {
        let tools = Tools::locate(None).expect("ffmpeg en el PATH");
        let dir = tempfile::tempdir().unwrap();
        let p = |name: &str| dir.path().join(name).to_string_lossy().into_owned();

        // Clip 1: HEVC 10 bits con audio, como graba la cámara en D-Log M.
        ffmpeg_ok(&tools, &[
            "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=60:d=3", "-f", "lavfi", "-i", "sine=f=440:d=3",
            "-pix_fmt", "yuv420p10le", "-c:v", "libx265", "-x265-params", "log-level=error", "-c:a", "aac",
            "-shortest", &p("dlog.mp4"),
        ]);
        // Clip 2: H.264 vertical sin audio.
        ffmpeg_ok(&tools, &[
            "-f", "lavfi", "-i", "testsrc2=s=720x1280:r=30:d=2", "-pix_fmt", "yuv420p", "-c:v", "libx264",
            &p("vertical.mp4"),
        ]);
        // LUT que pinta todo de un color fijo: muestra si se aplicó.
        let mut lut = String::from("LUT_3D_SIZE 2\n");
        for _ in 0..8 {
            lut.push_str("0.8 0.4 0.1\n");
        }
        let lut_path = dir.path().join("Mi LUT (prueba).cube");
        std::fs::write(&lut_path, lut).unwrap();
        let cache = dir.path().join("cache con espacios");
        install_lut(&lut_path, &cache).unwrap();

        let items = [
            TimelineItem { path: p("dlog.mp4"), in_point: 0.5, out_point: 2.5, apply_lut: true, has_audio: true },
            TimelineItem { path: p("vertical.mp4"), in_point: 0.0, out_point: 1.5, apply_lut: false, has_audio: false },
        ];
        let settings = ExportSettings {
            output: p("salida final.mp4"),
            codec: Codec::Hevc,
            encoder: Encoder::Cpu,
            quality: 28,
            width: 1920,
            height: 1080,
            fps: 30.0,
        };
        let running = RunningExport::default();
        let mut updates = Vec::new();
        let out = run_export(&tools, &cache, &items, &settings, &running, |u| updates.push(u)).unwrap();

        let info = crate::media::probe(&tools, &out).unwrap();
        assert_eq!((info.width, info.height, info.codec.as_str(), info.bit_depth), (1920, 1080, "hevc", 10));
        assert_eq!(
            (info.color_transfer.as_deref(), info.color_primaries.as_deref()),
            (Some("bt709"), Some("bt709"))
        );
        assert!((info.duration - 3.5).abs() < 0.15, "duración {}", info.duration);
        assert!(info.has_audio);
        assert!((updates.last().unwrap().seconds_done - 3.5).abs() < 1e-6);
        assert!(!dir.path().join("salida final.exportando.mp4").exists());

        let tinted = pixel_at(&tools, &out, Some(1.0));
        assert!(tinted[0].abs_diff(204) < 12 && tinted[1].abs_diff(102) < 12 && tinted[2].abs_diff(26) < 12, "{tinted:?}");
        // El clip vertical queda centrado con barras negras y sin la LUT.
        let untouched = pixel_at(&tools, &out, Some(2.8));
        assert!(untouched.iter().all(|&c| c < 150), "{untouched:?}");

        let frame = dir.path().join("cuadro.jpg");
        extract_frame(&tools, &cache, Path::new(&p("dlog.mp4")), 1.0, true, 360, &frame).unwrap();
        let tinted_frame = pixel_at(&tools, &frame, None);
        assert!(tinted_frame[0].abs_diff(204) < 12, "{tinted_frame:?}");

        let proxy = dir.path().join("proxy.mp4");
        make_proxy(&tools, Path::new(&p("dlog.mp4")), Encoder::Cpu, &proxy).unwrap();
        let proxy_info = crate::media::probe(&tools, &proxy).unwrap();
        assert!(proxy_info.browser_playable && proxy_info.height == 540, "{proxy_info:?}");
    }

    #[test]
    #[ignore]
    fn cancelling_removes_partial_output() {
        let tools = Tools::locate(None).expect("ffmpeg en el PATH");
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("largo.mp4");
        ffmpeg_ok(&tools, &[
            "-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=30:d=40", "-c:v", "libx264", "-preset", "ultrafast",
            src.to_str().unwrap(),
        ]);
        let items = [TimelineItem {
            path: src.to_string_lossy().into_owned(), in_point: 0.0, out_point: 40.0, apply_lut: false, has_audio: false,
        }];
        let settings = ExportSettings {
            output: dir.path().join("cancelado.mp4").to_string_lossy().into_owned(),
            codec: Codec::Hevc,
            encoder: Encoder::Cpu,
            quality: 20,
            width: 1920,
            height: 1080,
            fps: 30.0,
        };
        let running = std::sync::Arc::new(RunningExport::default());
        let canceller = {
            let running = running.clone();
            std::thread::spawn(move || {
                while running.0.lock().unwrap().is_none() {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                std::thread::sleep(std::time::Duration::from_millis(800));
                assert!(cancel_export(&running));
            })
        };
        let result = run_export(&tools, dir.path(), &items, &settings, &running, |_| {});
        canceller.join().unwrap();
        assert_eq!(result.unwrap_err(), "Exportación cancelada");
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains("cancelado"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[test]
    fn validates_cube_files() {
        let dir = tempfile::tempdir().unwrap();
        let good = dir.path().join("good.cube");
        let mut text = String::from("TITLE \"identity\"\nLUT_3D_SIZE 2\n");
        for b in 0..2 {
            for g in 0..2 {
                for r in 0..2 {
                    text.push_str(&format!("{r} {g} {b}\n"));
                }
            }
        }
        std::fs::write(&good, &text).unwrap();
        assert_eq!(validate_cube(&good).unwrap(), 2);

        let truncated = dir.path().join("bad.cube");
        std::fs::write(&truncated, "LUT_3D_SIZE 2\n0 0 0\n").unwrap();
        assert!(validate_cube(&truncated).is_err());
        std::fs::write(&truncated, "not a lut").unwrap();
        assert!(validate_cube(&truncated).is_err());
    }
}
