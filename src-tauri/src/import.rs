//! Copia archivos de la cámara a la biblioteca, organizados por fecha.
//!
//! Cada archivo se escribe primero como `.part` y se renombra al terminar, así
//! una copia interrumpida nunca parece un archivo completo.

use serde::Serialize;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

const CHUNK: usize = 8 * 1024 * 1024;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
    pub file_index: usize,
    pub file_count: usize,
    pub file_name: String,
    pub copied_bytes: u64,
    pub total_bytes: u64,
}

/// `copied` y `skipped` son rutas de origen, para que la interfaz sepa qué
/// archivos de la cámara ya quedaron en la biblioteca.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub copied: Vec<String>,
    pub skipped: Vec<String>,
    pub failed: Vec<(String, String)>,
    pub cancelled: bool,
}

/// Carpeta de destino `AAAA-MM-DD` según la fecha de modificación del archivo,
/// que en la cámara es la hora de grabación.
pub fn destination_for(library: &Path, source: &Path) -> PathBuf {
    let day = source
        .metadata()
        .and_then(|m| m.modified())
        .map(|t| chrono::DateTime::<chrono::Local>::from(t).format("%Y-%m-%d").to_string())
        .unwrap_or_else(|_| "sin-fecha".into());
    library.join(day).join(source.file_name().unwrap_or_default())
}

enum Target {
    Copy(PathBuf),
    AlreadyThere,
}

/// Si en la carpeta del día ya hay otro archivo con el mismo nombre pero otro
/// tamaño (otra cámara, contador reiniciado), se copia como `nombre (2).ext`,
/// `(3)`… en vez de sobrescribirlo. Un archivo del mismo tamaño ya está importado.
fn target_for(library: &Path, source: &Path, size: u64) -> Target {
    let first = destination_for(library, source);
    let stem = first.file_stem().unwrap_or_default().to_string_lossy().into_owned();
    let ext = first.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let mut n = 1;
    loop {
        let candidate = if n == 1 { first.clone() } else { first.with_file_name(format!("{stem} ({n}){ext}")) };
        match candidate.metadata() {
            Ok(m) if m.len() == size => return Target::AlreadyThere,
            Ok(_) => n += 1,
            Err(_) => return Target::Copy(candidate),
        }
    }
}

pub fn import_files(
    sources: &[PathBuf],
    library: &Path,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(ImportProgress),
) -> ImportSummary {
    let total_bytes: u64 = sources.iter().filter_map(|p| p.metadata().ok()).map(|m| m.len()).sum();
    let mut summary = ImportSummary::default();
    let mut copied_bytes = 0u64;

    for (index, source) in sources.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            summary.cancelled = true;
            break;
        }
        let name = source.file_name().unwrap_or_default().to_string_lossy().into_owned();
        let size = source.metadata().map(|m| m.len()).unwrap_or(0);
        let dest = match target_for(library, source, size) {
            Target::AlreadyThere => {
                summary.skipped.push(source.to_string_lossy().into_owned());
                copied_bytes += size;
                continue;
            }
            Target::Copy(dest) => dest,
        };

        let base = copied_bytes;
        let result = copy_one(source, &dest, cancel, |done| {
            on_progress(ImportProgress {
                file_index: index,
                file_count: sources.len(),
                file_name: name.clone(),
                copied_bytes: base + done,
                total_bytes,
            })
        });
        match result {
            Ok(true) => summary.copied.push(source.to_string_lossy().into_owned()),
            Ok(false) => {
                summary.cancelled = true;
                break;
            }
            Err(e) => summary.failed.push((name, e)),
        }
        copied_bytes = base + size;
    }
    summary
}

/// Devuelve `Ok(false)` si se canceló a la mitad.
fn copy_one(
    source: &Path,
    dest: &Path,
    cancel: &AtomicBool,
    mut on_chunk: impl FnMut(u64),
) -> Result<bool, String> {
    let parent = dest.parent().ok_or("Destino sin carpeta")?;
    std::fs::create_dir_all(parent).map_err(|e| format!("No pude crear {}: {e}", parent.display()))?;
    let partial = dest.with_extension(format!(
        "{}.part",
        dest.extension().and_then(|e| e.to_str()).unwrap_or("")
    ));

    let outcome = (|| -> Result<bool, String> {
        let mut input = File::open(source).map_err(|e| format!("No pude abrir el original: {e}"))?;
        let mut output = File::create(&partial).map_err(|e| format!("No pude crear la copia: {e}"))?;
        let mut buf = vec![0u8; CHUNK];
        let mut done = 0u64;
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Ok(false);
            }
            let n = input.read(&mut buf).map_err(|e| format!("Error leyendo: {e}"))?;
            if n == 0 {
                break;
            }
            output.write_all(&buf[..n]).map_err(|e| format!("Error escribiendo: {e}"))?;
            done += n as u64;
            on_chunk(done);
        }
        output.sync_all().map_err(|e| format!("Error guardando: {e}"))?;
        let expected = source.metadata().map(|m| m.len()).unwrap_or(done);
        if done != expected {
            return Err(format!("Copia incompleta: {done} de {expected} bytes"));
        }
        Ok(true)
    })();

    match outcome {
        Ok(true) => {
            std::fs::rename(&partial, dest).map_err(|e| format!("No pude renombrar la copia: {e}"))?;
            if let Ok(modified) = source.metadata().and_then(|m| m.modified()) {
                let _ = File::options().write(true).open(dest).and_then(|f| f.set_modified(modified));
            }
            Ok(true)
        }
        other => {
            let _ = std::fs::remove_file(&partial);
            other
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_then_skips_identical_files() {
        let src_dir = tempfile::tempdir().unwrap();
        let lib = tempfile::tempdir().unwrap();
        let source = src_dir.path().join("DJI_0001.MP4");
        std::fs::write(&source, vec![7u8; 3 * CHUNK + 5]).unwrap();
        let cancel = AtomicBool::new(false);

        let mut last = None;
        let first = import_files(&[source.clone()], lib.path(), &cancel, |p| last = Some(p));
        assert_eq!(first.copied.len(), 1, "{first:?}");
        let progress = last.unwrap();
        assert_eq!(progress.copied_bytes, progress.total_bytes);

        let dest = destination_for(lib.path(), &source);
        assert_eq!(std::fs::read(&dest).unwrap().len(), 3 * CHUNK + 5);
        assert_eq!(
            dest.metadata().unwrap().modified().unwrap(),
            source.metadata().unwrap().modified().unwrap()
        );

        let second = import_files(&[source], lib.path(), &cancel, |_| {});
        assert_eq!((second.copied.len(), second.skipped.len()), (0, 1));
    }

    #[test]
    fn same_name_different_clip_is_kept_alongside() {
        let lib = tempfile::tempdir().unwrap();
        let (card_a, card_b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let a = card_a.path().join("DJI_0001.MP4");
        let b = card_b.path().join("DJI_0001.MP4");
        std::fs::write(&a, vec![1u8; 10]).unwrap();
        std::fs::write(&b, vec![2u8; 20]).unwrap();
        // Mismo día de grabación, así caen en la misma carpeta.
        let day = a.metadata().unwrap().modified().unwrap();
        File::options().write(true).open(&b).unwrap().set_modified(day).unwrap();
        let cancel = AtomicBool::new(false);

        import_files(&[a.clone()], lib.path(), &cancel, |_| {});
        let second = import_files(&[b.clone()], lib.path(), &cancel, |_| {});
        assert_eq!(second.copied, [b.to_string_lossy().into_owned()]);

        let first_dest = destination_for(lib.path(), &a);
        assert_eq!(std::fs::read(&first_dest).unwrap(), vec![1u8; 10]);
        assert_eq!(std::fs::read(first_dest.with_file_name("DJI_0001 (2).MP4")).unwrap(), vec![2u8; 20]);

        let again = import_files(&[a, b], lib.path(), &cancel, |_| {});
        assert_eq!((again.copied.len(), again.skipped.len()), (0, 2));
    }

    #[test]
    fn cancelled_copy_leaves_no_partial_file() {
        let src_dir = tempfile::tempdir().unwrap();
        let lib = tempfile::tempdir().unwrap();
        let source = src_dir.path().join("DJI_0002.MP4");
        std::fs::write(&source, vec![1u8; 2 * CHUNK]).unwrap();
        let cancel = AtomicBool::new(false);

        let summary = import_files(&[source.clone()], lib.path(), &cancel, |_| {
            cancel.store(true, Ordering::Relaxed)
        });
        assert!(summary.cancelled);
        let dest = destination_for(lib.path(), &source);
        let leftovers: Vec<_> = std::fs::read_dir(dest.parent().unwrap()).unwrap().flatten().collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }
}
