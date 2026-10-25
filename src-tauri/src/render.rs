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

fn one() -> f64 {
    1.0
}

fn half() -> f64 {
    0.5
}

/// Un clip de la línea de tiempo con sus ajustes. Los que faltan toman el
/// valor neutro, así un proyecto anterior sigue sirviendo.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TimelineItem {
    pub path: String,
    pub in_point: f64,
    pub out_point: f64,
    /// LUT que convierte el perfil de la cámara a Rec.709, como ruta relativa
    /// a la caché (`luts/dlog-m.cube`; ver `luts::materialize`).
    #[serde(default)]
    pub lut: Option<String>,
    /// Estilo creativo que se aplica después de la conversión, igual de relativo.
    #[serde(default)]
    pub look: Option<String>,
    pub has_audio: bool,
    /// 1 = normal, 0.25 = cuatro veces más lento, 4 = cuatro veces más rápido.
    #[serde(default = "one")]
    pub speed: f64,
    /// 0 = sin sonido, 1 = original, hasta 2 = el doble.
    #[serde(default = "one")]
    pub volume: f64,
    /// Qué parte de la imagen queda al recortar a otro formato: 0 = izquierda
    /// o arriba, 0.5 = centro, 1 = derecha o abajo.
    #[serde(default = "half")]
    pub crop_x: f64,
    #[serde(default = "half")]
    pub crop_y: f64,
    /// Video 360 (dos lentes): la vista que se elige en el editor. Sin ella
    /// el clip es un video normal.
    #[serde(default)]
    pub view: Option<View360>,
}

/// Proyección de la vista de un video 360.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ViewMode {
    /// Como una cámara normal que mira hacia un lado.
    #[default]
    Flat,
    /// Proyección estereográfica hacia abajo: un "pequeño planeta".
    Planet,
}

/// Hacia dónde mira un video 360 y con qué ángulo, en grados. Mismas
/// convenciones que el visor de la interfaz (`gl.ts`): yaw positivo gira a
/// la derecha y pitch positivo mira hacia arriba.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq)]
pub struct View360 {
    pub yaw: f64,
    pub pitch: f64,
    pub roll: f64,
    /// Campo de visión horizontal.
    pub fov: f64,
    #[serde(default)]
    pub mode: ViewMode,
}

impl Default for View360 {
    fn default() -> Self {
        View360 { yaw: 0.0, pitch: 0.0, roll: 0.0, fov: 100.0, mode: ViewMode::Flat }
    }
}

/// Campo de visión de cada lente de la Osmo 360 (grados), medido en la
/// costura de un clip real; el visor de la interfaz usa el mismo.
pub const LENS_FOV: f64 = 195.0;

/// Cómo llegan las dos lentes de un video 360.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Lenses {
    /// Dos pistas de video, una por lente (el `.OSV`).
    Tracks,
    /// Lado a lado en un solo cuadro (el `.LRF` y la vista previa).
    SideBySide,
}

/// Lleva las dos lentes de la entrada `input` a la vista elegida, de `w`×`h`.
fn pano_filter(input: usize, lenses: Lenses, view: &View360, w: u32, h: u32) -> String {
    let aspect = f64::from(w) / f64::from(h);
    let (output, h_fov, v_fov) = match view.mode {
        ViewMode::Flat => {
            let h_fov = view.fov.clamp(20.0, 170.0);
            let v_fov = 2.0 * ((h_fov / 2.0).to_radians().tan() / aspect).atan().to_degrees();
            ("flat", h_fov, v_fov)
        }
        ViewMode::Planet => {
            let h_fov = view.fov.clamp(90.0, 340.0);
            let v_fov = 4.0 * ((h_fov / 4.0).to_radians().tan() / aspect).atan().to_degrees();
            ("sg", h_fov, v_fov)
        }
    };
    let joined = match lenses {
        Lenses::Tracks => format!("[{input}:v:0][{input}:v:1]hstack=inputs=2,"),
        Lenses::SideBySide => format!("[{input}:v:0]"),
    };
    format!(
        "{joined}v360=input=dfisheye:output={output}:ih_fov={LENS_FOV}:iv_fov={LENS_FOV}:yaw={:.3}:pitch={:.3}:roll={:.3}:h_fov={h_fov:.3}:v_fov={v_fov:.3}:w={w}:h={h}:interp=cubic",
        view.yaw, view.pitch, view.roll
    )
}

impl TimelineItem {
    /// Duración en el video final, ya con la velocidad aplicada.
    pub fn output_duration(&self) -> f64 {
        (self.out_point - self.in_point) / self.speed
    }
}

/// Cómo cabe un clip en un formato distinto al suyo.
#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Fit {
    /// Llena el cuadro y corta lo que sobra (lo habitual para vertical).
    #[default]
    Crop,
    /// Muestra todo con barras negras.
    Pad,
}

#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Codec {
    H264,
    Hevc,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Encoder {
    Cpu,
    /// GPU NVIDIA (Windows y Linux).
    Nvenc,
    /// Codificador de hardware de Apple (macOS).
    VideoToolbox,
}

/// VideoToolbox usa `-q:v` de 1 a 100 (más alto = mejor), al revés que CRF.
/// La equivalencia es aproximada: CRF 20 ≈ q 70.
fn videotoolbox_quality(crf: u8) -> String {
    (110 - 2 * i32::from(crf.min(51))).clamp(1, 100).to_string()
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
    #[serde(default)]
    pub fit: Fit,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    pub seconds_done: f64,
    pub seconds_total: f64,
    pub speed: Option<String>,
}

/// `file` es relativa a la caché, desde donde corre ffmpeg: sin espacios ni
/// dos puntos que haya que escapar dentro del filtro.
fn lut_filter(file: &str) -> String {
    format!("lut3d=file={file}:interp=tetrahedral")
}

fn item_luts(item: &TimelineItem) -> impl Iterator<Item = &String> {
    item.lut.iter().chain(item.look.iter())
}

fn encoder_args(settings: &ExportSettings) -> Vec<String> {
    let q = settings.quality.min(51).to_string();
    let vt = videotoolbox_quality(settings.quality);
    let args: Vec<&str> = match (settings.codec, settings.encoder) {
        (Codec::H264, Encoder::VideoToolbox) => vec!["-c:v", "h264_videotoolbox", "-q:v", &vt, "-pix_fmt", "yuv420p"],
        (Codec::Hevc, Encoder::VideoToolbox) => vec![
            "-c:v", "hevc_videotoolbox", "-q:v", &vt, "-pix_fmt", "p010le", "-profile:v", "main10", "-tag:v", "hvc1",
        ],
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

/// `atempo` solo acepta de 0.5 a 2: velocidades fuera de ese rango se encadenan.
fn atempo_chain(speed: f64) -> Vec<String> {
    let mut left = speed;
    let mut chain = Vec::new();
    while left > 2.0 {
        chain.push("atempo=2".to_string());
        left /= 2.0;
    }
    while left < 0.5 {
        chain.push("atempo=0.5".to_string());
        left /= 0.5;
    }
    if (left - 1.0).abs() > 1e-6 {
        chain.push(format!("atempo={left:.4}"));
    }
    chain
}

/// Arma los argumentos de ffmpeg para exportar la línea de tiempo a `output`.
/// Cada clip se recorta al leerlo, se le aplica la LUT si corresponde, se
/// encuadra al formato de salida (recortando o con barras), se cambia su
/// velocidad y volumen, se lleva a los cuadros por segundo de salida y
/// después se unen.
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

    let aspect = f64::from(w) / f64::from(h);
    for (i, item) in items.iter().enumerate() {
        let duration = item.out_point - item.in_point;
        if !(duration > 0.0) {
            return Err(format!("El clip {} tiene el final antes del inicio", i + 1));
        }
        if !(0.1..=16.0).contains(&item.speed) {
            return Err(format!("La velocidad del clip {} debe estar entre 0.1× y 16×", i + 1));
        }
        args.extend(hw_decode().iter().map(|a| a.to_string()));
        args.extend(["-ss".into(), secs(item.in_point), "-t".into(), secs(duration), "-i".into(), item.path.clone()]);

        let mut video = Vec::new();
        // Un 360 ya sale del tamaño final al elegir su vista: no se recorta.
        let head = match &item.view {
            Some(view) => format!("{},", pano_filter(i, Lenses::Tracks, view, w, h)),
            None => format!("[{i}:v:0]"),
        };
        video.extend(item_luts(item).map(|f| lut_filter(f)));
        match settings.fit {
            _ if item.view.is_some() => {}
            Fit::Crop => {
                // El mayor rectángulo del formato de salida que cabe en el clip,
                // movido según crop_x/crop_y.
                let (px, py) = (item.crop_x.clamp(0.0, 1.0), item.crop_y.clamp(0.0, 1.0));
                video.push(format!(
                    "crop=w='min(iw,ih*{aspect:.6})':h='min(ih,iw/{aspect:.6})':x='(iw-ow)*{px:.4}':y='(ih-oh)*{py:.4}'"
                ));
                video.push(format!("scale={w}:{h}:flags=lanczos"));
            }
            Fit::Pad => {
                video.push(format!("scale={w}:{h}:force_original_aspect_ratio=decrease:flags=lanczos"));
                video.push(format!("pad={w}:{h}:(ow-iw)/2:(oh-ih)/2"));
            }
        }
        video.push("setsar=1".into());
        if (item.speed - 1.0).abs() > 1e-6 {
            // En cámara lenta, un clip de 120 fps conserva todos sus cuadros.
            video.push(format!("setpts=(PTS-STARTPTS)/{:.6}", item.speed));
        }
        video.push(format!("fps={}", settings.fps));
        // ffmpeg toma las etiquetas de color de los cuadros, no de las opciones
        // de salida; sin esto el archivo queda con primarios y curva "unknown".
        video.push("setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv".into());
        graph.push(format!("{head}{}[v{i}]", video.join(",")));

        let gain = item.volume.clamp(0.0, 2.0);
        if item.has_audio && gain > 0.0 {
            let mut audio = vec!["asetpts=PTS-STARTPTS".to_string()];
            audio.extend(atempo_chain(item.speed));
            if (gain - 1.0).abs() > 1e-6 {
                audio.push(format!("volume={gain:.3}"));
            }
            audio.push("aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo".into());
            graph.push(format!("[{i}:a:0]{}[a{i}]", audio.join(",")));
        } else {
            graph.push(format!("anullsrc=r=48000:cl=stereo,atrim=duration={}[a{i}]", secs(item.output_duration())));
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

/// Decodificar con la GPU: en una Mac, las dos lentes HEVC de 10 bits de un
/// 360 se leen 5 veces más rápido. Si no se puede, ffmpeg sigue por software.
fn hw_decode() -> &'static [&'static str] {
    if cfg!(target_os = "macos") {
        &["-hwaccel", "videotoolbox"]
    } else {
        &[]
    }
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
    if let Some(missing) = items.iter().flat_map(item_luts).find(|f| !cache_dir.join(f).is_file()) {
        return Err(format!("Falta la LUT {missing}"));
    }
    let parent = output.parent().ok_or("Ruta de salida inválida")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let stem = output.file_stem().unwrap_or_default().to_string_lossy();
    let ext = output.extension().unwrap_or_default().to_string_lossy();
    let partial = parent.join(format!("{stem}.exportando.{ext}"));

    let args = build_export_args(items, settings, &partial)?;
    let total: f64 = items.iter().map(TimelineItem::output_duration).sum();

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
    luts: &[String],
    pano: Option<(Lenses, &View360)>,
    max_height: u32,
    output: &Path,
) -> Result<(), String> {
    if let Some(missing) = luts.iter().find(|f| !cache_dir.join(f).is_file()) {
        return Err(format!("Falta la LUT {missing}"));
    }
    // Un 360 se ve con la vista elegida, en 16:9.
    let head = match pano {
        Some((lenses, view)) => {
            let h = max_height - max_height % 2;
            format!("{},", pano_filter(0, lenses, view, (h * 16 / 9) & !1, h))
        }
        None => "[0:v:0]".into(),
    };
    let mut steps: Vec<String> = luts.iter().map(|f| lut_filter(f)).collect();
    if pano.is_none() {
        steps.push(format!("scale=-2:'min({max_height},ih)'"));
    }
    if steps.is_empty() {
        steps.push("null".into());
    }
    let graph = format!("{head}{}[out]", steps.join(","));
    let out = tools
        .ffmpeg()
        .current_dir(cache_dir)
        .args(["-hide_banner", "-loglevel", "error", "-y"])
        .args(hw_decode())
        .args(["-ss", &secs(at.max(0.0)), "-i"])
        .arg(source)
        .args(["-frames:v", "1", "-filter_complex", &graph, "-map", "[out]", "-q:v", "3"])
        .arg(output)
        .output()
        .map_err(|e| format!("No pude ejecutar ffmpeg: {e}"))?;
    if !out.status.success() || !output.is_file() {
        return Err(format!("No pude extraer el cuadro: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(())
}

/// Versión liviana de un video 360 con las dos lentes lado a lado (como el
/// `.LRF` de la cámara), para verlo en la app con la vista que se elija.
pub fn make_pano_proxy(tools: &Tools, source: &Path, encoder: Encoder, output: &Path) -> Result<(), String> {
    make_proxy_with(tools, source, encoder, "[0:v:0][0:v:1]hstack=inputs=2,scale=2048:1024,format=yuv420p", output)
}

/// Versión liviana en H.264 de 8 bits para reproducir en la app videos que
/// WebView2 no reproduce (HEVC de 10 bits).
pub fn make_proxy(tools: &Tools, source: &Path, encoder: Encoder, output: &Path) -> Result<(), String> {
    make_proxy_with(tools, source, encoder, "[0:v:0]scale=-2:'min(540,ih)',format=yuv420p", output)
}

fn make_proxy_with(tools: &Tools, source: &Path, encoder: Encoder, graph: &str, output: &Path) -> Result<(), String> {
    let partial = output.with_extension("part.mp4");
    let video_codec: &[&str] = match encoder {
        Encoder::Nvenc => &["-c:v", "h264_nvenc", "-preset", "p3", "-cq", "28"],
        Encoder::VideoToolbox => &["-c:v", "h264_videotoolbox", "-q:v", "55"],
        Encoder::Cpu => &["-c:v", "libx264", "-preset", "veryfast", "-crf", "28"],
    };
    let out = tools
        .ffmpeg()
        .args(["-hide_banner", "-loglevel", "error", "-y"])
        .args(hw_decode())
        .arg("-i")
        .arg(source)
        .args(["-filter_complex", &format!("{graph}[v]"), "-map", "[v]", "-map", "0:a:0?"])
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
            fit: Fit::Pad,
        }
    }

    fn item(path: &str, lut: bool, has_audio: bool) -> TimelineItem {
        TimelineItem {
            path: path.into(),
            in_point: 1.0,
            out_point: 3.5,
            lut: lut.then(|| "luts/dlog-m.cube".into()),
            look: None,
            has_audio,
            speed: 1.0,
            volume: 1.0,
            crop_x: 0.5,
            crop_y: 0.5,
            view: None,
        }
    }

    #[test]
    fn a_360_clip_joins_its_lenses_and_takes_the_chosen_view() {
        let view = View360 { yaw: 90.0, pitch: -10.0, ..View360::default() };
        let pano = TimelineItem { view: Some(view), ..item("CAM_0003_D.OSV", true, true) };
        let vertical = ExportSettings { width: 1080, height: 1920, fit: Fit::Crop, ..settings() };
        let args = build_export_args(&[pano], &vertical, Path::new("out.mp4")).unwrap();
        let graph = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert!(
            graph.starts_with("[0:v:0][0:v:1]hstack=inputs=2,v360=input=dfisheye:output=flat:ih_fov=195:iv_fov=195:yaw=90.000:pitch=-10.000"),
            "{graph}"
        );
        // Vertical: el campo horizontal es el elegido y el vertical, el que le toca.
        assert!(graph.contains(":h_fov=100.000:v_fov=129.") && graph.contains(":w=1080:h=1920:"), "{graph}");
        // Sin recorte: la vista ya es del tamaño final; la LUT va después.
        assert!(!graph.contains("crop=") && graph.contains("interp=cubic,lut3d=file=luts/dlog-m.cube"), "{graph}");

        let planet = View360 { mode: ViewMode::Planet, pitch: -90.0, fov: 260.0, ..View360::default() };
        let filter = pano_filter(0, Lenses::SideBySide, &planet, 1920, 1080);
        assert!(filter.starts_with("[0:v:0]v360=input=dfisheye:output=sg:") && filter.contains(":h_fov=260.000:"), "{filter}");
    }

    #[test]
    fn speed_volume_and_vertical_crop() {
        let slow = TimelineItem { speed: 0.25, volume: 0.5, crop_x: 0.0, ..item("a.mp4", false, true) };
        let fast_muted = TimelineItem { speed: 4.0, volume: 0.0, ..item("b.mp4", false, true) };
        let vertical = ExportSettings { width: 1080, height: 1920, fit: Fit::Crop, ..settings() };
        let args = build_export_args(&[slow.clone(), fast_muted.clone()], &vertical, Path::new("o.mp4")).unwrap();
        let graph = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert!(graph.contains("crop=w='min(iw,ih*0.562500)':h='min(ih,iw/0.562500)':x='(iw-ow)*0.0000'"), "{graph}");
        assert!(graph.contains("scale=1080:1920:flags=lanczos"));
        assert!(graph.contains("setpts=(PTS-STARTPTS)/0.250000"));
        assert!(graph.contains("atempo=0.5,atempo=0.5000,volume=0.500"), "{graph}");
        // Sin volumen, silencio con la duración ya acelerada: 2.5 s / 4.
        assert!(graph.contains("anullsrc=r=48000:cl=stereo,atrim=duration=0.625[a1]"), "{graph}");
        assert!((slow.output_duration() - 10.0).abs() < 1e-9);

        let too_fast = TimelineItem { speed: 20.0, ..item("c.mp4", false, true) };
        assert!(build_export_args(&[too_fast], &settings(), Path::new("o.mp4")).is_err());
    }

    #[test]
    fn atempo_chains_beyond_its_range() {
        assert_eq!(atempo_chain(1.0), Vec::<String>::new());
        assert_eq!(atempo_chain(1.5), ["atempo=1.5000"]);
        assert_eq!(atempo_chain(4.0), ["atempo=2", "atempo=2.0000"]);
        assert_eq!(atempo_chain(0.1), ["atempo=0.5", "atempo=0.5", "atempo=0.5", "atempo=0.8000"]);
    }

    #[test]
    fn graph_trims_applies_lut_and_concats() {
        let items = [item(r"C:\Videos\a b.MP4", true, true), item(r"C:\Videos\c.MP4", false, false)];
        let args = build_export_args(&items, &settings(), Path::new("out.mp4")).unwrap();
        let graph = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert!(graph.starts_with("[0:v:0]lut3d=file=luts/dlog-m.cube:interp=tetrahedral,"));
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
    fn hardware_hevc_keeps_10_bit() {
        for encoder in [Encoder::Nvenc, Encoder::VideoToolbox] {
            let s = ExportSettings { codec: Codec::Hevc, encoder, ..settings() };
            let args = encoder_args(&s);
            assert!(args.windows(2).any(|w| w == ["-pix_fmt", "p010le"]), "{encoder:?}");
            assert!(args.windows(2).any(|w| w == ["-profile:v", "main10"]), "{encoder:?}");
        }
    }

    #[test]
    fn videotoolbox_quality_runs_opposite_to_crf() {
        assert_eq!(videotoolbox_quality(20), "70");
        assert_eq!(videotoolbox_quality(14), "82");
        assert_eq!(videotoolbox_quality(51), "8");
        assert_eq!(videotoolbox_quality(0), "100");
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
        let cache = dir.path().join("cache con espacios");
        std::fs::create_dir_all(cache.join("luts")).unwrap();
        std::fs::write(cache.join("luts/prueba.cube"), lut).unwrap();
        let lut = || Some("luts/prueba.cube".to_string());

        let items = [
            TimelineItem { path: p("dlog.mp4"), in_point: 0.5, out_point: 2.5, lut: lut(), ..item("", false, true) },
            TimelineItem { path: p("vertical.mp4"), in_point: 0.0, out_point: 1.5, ..item("", false, false) },
        ];
        let settings = ExportSettings {
            output: p("salida final.mp4"),
            codec: Codec::Hevc,
            encoder: Encoder::Cpu,
            quality: 28,
            width: 1920,
            height: 1080,
            fps: 30.0,
            fit: Fit::Pad,
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
        extract_frame(&tools, &cache, Path::new(&p("dlog.mp4")), 1.0, &[lut().unwrap()], None, 360, &frame).unwrap();
        let tinted_frame = pixel_at(&tools, &frame, None);
        assert!(tinted_frame[0].abs_diff(204) < 12, "{tinted_frame:?}");

        let proxy = dir.path().join("proxy.mp4");
        make_proxy(&tools, Path::new(&p("dlog.mp4")), Encoder::Cpu, &proxy).unwrap();
        let proxy_info = crate::media::probe(&tools, &proxy).unwrap();
        assert!(proxy_info.browser_playable && proxy_info.height == 540, "{proxy_info:?}");
    }

    /// Cámara lenta, acelerado y vertical con ffmpeg real: `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn exports_slow_motion_and_vertical_crop() {
        let tools = Tools::locate(None).expect("ffmpeg en el PATH");
        let dir = tempfile::tempdir().unwrap();
        let p = |name: &str| dir.path().join(name).to_string_lossy().into_owned();
        // 2 s a 120 fps con sonido, como un clip de cámara lenta de la Action 5 Pro.
        ffmpeg_ok(&tools, &[
            "-f", "lavfi", "-i", "testsrc2=s=1280x960:r=120:d=2", "-f", "lavfi", "-i", "sine=f=440:d=2",
            "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", &p("rapido.mp4"),
        ]);
        let items = [
            TimelineItem { path: p("rapido.mp4"), in_point: 0.0, out_point: 1.0, speed: 0.25, crop_x: 0.0, ..item("", false, true) },
            TimelineItem { path: p("rapido.mp4"), in_point: 0.0, out_point: 2.0, speed: 4.0, volume: 0.0, ..item("", false, true) },
        ];
        let settings = ExportSettings {
            output: p("vertical.mp4"),
            encoder: Encoder::Cpu,
            width: 720,
            height: 1280,
            fps: 30.0,
            fit: Fit::Crop,
            ..settings()
        };
        let running = RunningExport::default();
        let out = run_export(&tools, dir.path(), &items, &settings, &running, |_| {}).unwrap();
        let info = crate::media::probe(&tools, &out).unwrap();
        assert_eq!((info.width, info.height), (720, 1280));
        // 1 s a 0.25× = 4 s, más 2 s a 4× = 0.5 s.
        assert!((info.duration - 4.5).abs() < 0.15, "duración {}", info.duration);
        assert!(info.has_audio);
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
        let items = [TimelineItem { path: src.to_string_lossy().into_owned(), in_point: 0.0, out_point: 40.0, ..item("", false, false) }];
        let settings = ExportSettings {
            output: dir.path().join("cancelado.mp4").to_string_lossy().into_owned(),
            codec: Codec::Hevc,
            encoder: Encoder::Cpu,
            quality: 20,
            width: 1920,
            height: 1080,
            fps: 30.0,
            fit: Fit::Pad,
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
}

