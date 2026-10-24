//! Localiza ffmpeg/ffprobe y construye comandos que no abren consola en Windows.

use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Clone, Debug)]
pub struct Tools {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
}

impl Tools {
    /// Busca primero junto al ejecutable (versión empaquetada), después en el
    /// directorio configurado y por último en el PATH.
    pub fn locate(configured_dir: Option<&Path>) -> Result<Self, String> {
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(Path::to_path_buf));
        let candidates: Vec<PathBuf> = exe_dir
            .into_iter()
            .chain(configured_dir.map(Path::to_path_buf))
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
            _ => Err("No encontré ffmpeg y ffprobe. Instálalos (winget install Gyan.FFmpeg) \
                      o indica su carpeta en Ajustes."
                .into()),
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

/// ffmpeg lista codificadores aunque la GPU no los admita; hace falta una
/// prueba real para saber si NVENC funciona en esta máquina.
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
