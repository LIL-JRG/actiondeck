//! Localiza ffmpeg/ffprobe y construye comandos que no abren consola en Windows.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::render::Encoder;

/// Una app de macOS abierta desde el Finder no hereda el PATH de la terminal,
/// así que no vería el ffmpeg de Homebrew sin estas rutas.
#[cfg(target_os = "macos")]
const SYSTEM_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin"];
#[cfg(target_os = "linux")]
const SYSTEM_DIRS: &[&str] = &["/usr/bin", "/usr/local/bin"];
#[cfg(windows)]
const SYSTEM_DIRS: &[&str] = &[];

#[cfg(target_os = "macos")]
const INSTALL_HINT: &str = "brew install ffmpeg";
#[cfg(windows)]
const INSTALL_HINT: &str = "winget install Gyan.FFmpeg";
#[cfg(target_os = "linux")]
const INSTALL_HINT: &str = "con el gestor de paquetes de tu distribución";

#[derive(Clone, Debug)]
pub struct Tools {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
}

impl Tools {
    /// Busca primero junto al ejecutable (versión empaquetada), después en el
    /// directorio configurado, en las carpetas habituales del sistema y por
    /// último en el PATH.
    pub fn locate(configured_dir: Option<&Path>) -> Result<Self, String> {
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(Path::to_path_buf));
        let candidates: Vec<PathBuf> = exe_dir
            .into_iter()
            .chain(configured_dir.map(Path::to_path_buf))
            .chain(SYSTEM_DIRS.iter().map(PathBuf::from))
            .collect();

        let find = |name: &str| -> Option<PathBuf> {
            let file = format!("{name}{}", std::env::consts::EXE_SUFFIX);
            candidates
                .iter()
                .map(|dir| dir.join(&file))
                .find(|p| p.is_file())
                .or_else(|| find_in_path(&file))
        };

        match (find("ffmpeg"), find("ffprobe")) {
            (Some(ffmpeg), Some(ffprobe)) => Ok(Self { ffmpeg, ffprobe }),
            _ => Err(format!(
                "No encontré ffmpeg y ffprobe. Instálalos ({INSTALL_HINT}) o indica su carpeta en Ajustes."
            )),
        }
    }

    pub fn ffmpeg(&self) -> Command {
        quiet(&self.ffmpeg)
    }

    pub fn ffprobe(&self) -> Command {
        quiet(&self.ffprobe)
    }
}

fn find_in_path(file: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(file))
            .find(|p| p.is_file())
    })
}

fn quiet(program: &Path) -> Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Lista los codificadores disponibles en este ffmpeg (p. ej. `h264_nvenc`).
pub fn available_encoders(tools: &Tools) -> Vec<String> {
    let Ok(out) = tools.ffmpeg().args(["-hide_banner", "-encoders"]).output() else {
        return Vec::new();
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let flags = parts.next()?;
            let name = parts.next()?;
            (flags.starts_with('V') && flags.len() == 6).then(|| name.to_string())
        })
        .collect()
}

/// Codificador de hardware de esta plataforma y qué formatos admite de verdad.
#[derive(serde::Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Hardware {
    pub encoder: Encoder,
    pub h264: bool,
    pub hevc: bool,
}

pub fn detect_hardware(tools: &Tools) -> Hardware {
    #[cfg(target_os = "macos")]
    let (encoder, h264, hevc) = (Encoder::VideoToolbox, "h264_videotoolbox", "hevc_videotoolbox");
    #[cfg(not(target_os = "macos"))]
    let (encoder, h264, hevc) = (Encoder::Nvenc, "h264_nvenc", "hevc_nvenc");

    let names = available_encoders(tools);
    let works = |enc: &str, fmt: &str| names.iter().any(|n| n == enc) && encoder_works(tools, enc, fmt);
    Hardware { encoder, h264: works(h264, "yuv420p"), hevc: works(hevc, "p010le") }
}

/// ffmpeg lista codificadores aunque la GPU no los admita; hace falta una
/// prueba real para saber si NVENC o VideoToolbox funcionan en esta máquina.
pub fn encoder_works(tools: &Tools, encoder: &str, pix_fmt: &str) -> bool {
    tools
        .ffmpeg()
        .args([
            "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
            "color=c=black:s=256x256:d=0.1", "-pix_fmt", pix_fmt, "-c:v", encoder,
            "-frames:v", "1", "-f", "null", "-",
        ])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}
