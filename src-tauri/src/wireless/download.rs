//! Descarga por HTTP desde la cámara: `GET /v2?storage=<0|1>&path=<ruta>` en
//! `192.168.2.1` (lighttpd, sin autenticación). Admite `Range`, así que una
//! descarga cortada se reanuda. Igual que al importar, se escribe a `.part` y
//! se renombra solo cuando el tamaño cuadra.
//!
//! Mientras dura, el enlace UDP debe seguir vivo (`Datalink::start_keepalive`)
//! o la cámara apaga su red.

use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use super::wifi::CAMERA_IP;

const RETRIES: u32 = 6;

pub fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(5)))
        .timeout_recv_response(Some(Duration::from_secs(15)))
        .timeout_per_read(Some(Duration::from_secs(15)))
        .http_status_as_error(false)
        .build()
        .into()
}

/// Codifica la ruta para la URL dejando `/` tal cual.
fn encode(path: &str) -> String {
    path.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'.' | b'-' | b'_' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

pub fn url(storage: u8, path: &str) -> String {
    format!("http://{CAMERA_IP}/v2?storage={storage}&path={}", encode(path))
}

/// Tamaño según `HEAD`, o `None` si la cámara no tiene el archivo ahí.
pub fn head_size(storage: u8, path: &str) -> Option<u64> {
    let response = agent().head(&url(storage, path)).call().ok()?;
    if response.status().as_u16() != 200 {
        return None;
    }
    response.headers().get("content-length")?.to_str().ok()?.parse().ok()
}

/// Descarga `path` a `dest`, reanudando un `.part` que haya quedado.
/// Devuelve los bytes descargados. `Ok(None)` si se canceló.
pub fn download(
    storage: u8,
    path: &str,
    dest: &Path,
    expected: Option<u64>,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(u64, u64),
) -> Result<Option<u64>, String> {
    let expected = match expected.filter(|&s| s > 0) {
        Some(s) => s,
        None => head_size(storage, path).ok_or_else(|| format!("La cámara no tiene {path}"))?,
    };
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("No pude crear {}: {e}", dir.display()))?;
    }
    let partial = dest.with_extension(format!(
        "{}.part",
        dest.extension().and_then(|e| e.to_str()).unwrap_or("")
    ));
    let mut pos = partial.metadata().map(|m| m.len()).unwrap_or(0);
    if pos > expected {
        let _ = std::fs::remove_file(&partial);
        pos = 0;
    }

    let agent = agent();
    let mut failures = 0;
    while pos < expected {
        if cancel.load(Ordering::Relaxed) {
            return Ok(None);
        }
        let attempt = (|| -> Result<(), String> {
            let mut request = agent.get(&url(storage, path));
            if pos > 0 {
                request = request.header("Range", format!("bytes={pos}-"));
            }
            let response = request.call().map_err(|e| e.to_string())?;
            let status = response.status().as_u16();
            if status == 200 && pos > 0 {
                // No respetó el Range: se empieza de cero.
                pos = 0;
            } else if status != 200 && status != 206 {
                return Err(format!("HTTP {status}"));
            }
            let mut file = OpenOptions::new()
                .create(true)
                .write(true)
                .append(pos > 0)
                .truncate(pos == 0)
                .open(&partial)
                .map_err(|e| format!("No pude escribir {}: {e}", partial.display()))?;
            let mut body = response.into_body().into_reader();
            let mut buf = vec![0u8; 1 << 20];
            loop {
                if cancel.load(Ordering::Relaxed) {
                    return Ok(());
                }
                let n = body.read(&mut buf).map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                file.write_all(&buf[..n]).map_err(|e| format!("Error escribiendo: {e}"))?;
                pos += n as u64;
                on_progress(pos, expected);
            }
            file.sync_all().map_err(|e| e.to_string())
        })();
        if let Err(e) = attempt {
            // La cámara da 404/500 pasajeros a mitad de descarga: se reintenta.
            failures += 1;
            if failures > RETRIES {
                return Err(format!("No pude descargar {path}: {e}"));
            }
            std::thread::sleep(Duration::from_secs(u64::from(failures).min(4) * 2));
        }
    }
    if cancel.load(Ordering::Relaxed) {
        return Ok(None);
    }
    if pos != expected {
        return Err(format!("Descarga incompleta: {pos} de {expected} bytes"));
    }
    std::fs::rename(&partial, dest).map_err(|e| format!("No pude renombrar la descarga: {e}"))?;
    Ok(Some(pos))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_encodes_only_what_needs_it() {
        assert_eq!(
            url(0, "DCIM/DJI_001/DJI_20261024081530_0002_D.MP4"),
            "http://192.168.2.1/v2?storage=0&path=DCIM/DJI_001/DJI_20261024081530_0002_D.MP4"
        );
        assert_eq!(encode("DCIM/Mis videos/a&b.MP4"), "DCIM/Mis%20videos/a%26b.MP4");
    }
}
