//! Registro de diagnóstico: cada línea va a la consola y a un archivo, con los
//! milisegundos desde el inicio, para poder revisar después qué respondió la
//! cámara y cuándo.

use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[derive(Clone)]
pub struct Log {
    start: Instant,
    file: Option<Arc<Mutex<File>>>,
    path: Option<PathBuf>,
    echo: bool,
}

impl Log {
    /// Registro en un archivo nuevo dentro de `dir`, con fecha y hora en el nombre.
    pub fn to_dir(dir: &Path, echo: bool) -> Self {
        let name = chrono::Local::now().format("diag-%Y%m%d-%H%M%S.log").to_string();
        let path = dir.join(name);
        let file = std::fs::create_dir_all(dir).ok().and_then(|_| File::create(&path).ok());
        Self { start: Instant::now(), path: file.as_ref().map(|_| path), file: file.map(|f| Arc::new(Mutex::new(f))), echo }
    }

    /// Solo consola (pruebas).
    pub fn console() -> Self {
        Self { start: Instant::now(), file: None, path: None, echo: true }
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    pub fn line(&self, msg: impl AsRef<str>) {
        let line = format!("[{:>7} ms] {}", self.start.elapsed().as_millis(), msg.as_ref());
        if self.echo {
            println!("{line}");
        }
        if let Some(file) = &self.file {
            let _ = writeln!(file.lock().unwrap(), "{line}");
        }
    }
}

/// Oculta una contraseña en el registro, dejando ver solo su largo.
pub fn redact(secret: &str) -> String {
    format!("<oculta, {} caracteres>", secret.chars().count())
}
