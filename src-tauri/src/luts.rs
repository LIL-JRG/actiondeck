//! LUTs. Las oficiales de DJI que convierten el perfil logarítmico a Rec.709
//! vienen dentro de la app; las extra (los estilos creativos de DJI o
//! cualquier `.cube`) las agrega el usuario y se guardan en su carpeta de datos.
//!
//! ffmpeg las lee con rutas relativas a la caché (`luts/<id>.cube`), así no
//! hay que escapar rutas con espacios o dos puntos dentro del filtro.

use serde::Serialize;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::time::Duration;

struct Builtin {
    id: &'static str,
    name: &'static str,
    detail: &'static str,
    bytes: &'static [u8],
}

/// Descargadas de dji.com/downloads el 2026-10-24. Las de la Action 4,
/// Action 5 Pro, Pocket 3, Osmo 360 y Nano son el mismo archivo.
const BUILTIN: &[Builtin] = &[
    Builtin {
        id: "dlog-m",
        name: "D-Log M a Rec.709",
        detail: "Osmo Action 4, Action 5 Pro, Pocket 3, Osmo 360 y Nano",
        bytes: include_bytes!("../resources/luts/dlog-m.cube"),
    },
    Builtin {
        id: "action-6",
        name: "D-Log M a Rec.709",
        detail: "Osmo Action 6",
        bytes: include_bytes!("../resources/luts/action-6.cube"),
    },
    Builtin {
        id: "pocket-4",
        name: "D-Log a Rec.709",
        detail: "Osmo Pocket 4",
        bytes: include_bytes!("../resources/luts/pocket-4.cube"),
    },
    Builtin {
        id: "pocket-4-vivid",
        name: "D-Log a Rec.709 vívido",
        detail: "Osmo Pocket 4 y Pocket 4 Pro",
        bytes: include_bytes!("../resources/luts/pocket-4-vivid.cube"),
    },
    Builtin {
        id: "pocket-4-pro",
        name: "D-Log a Rec.709",
        detail: "Osmo Pocket 4 Pro",
        bytes: include_bytes!("../resources/luts/pocket-4-pro.cube"),
    },
    Builtin {
        id: "pocket-4-pro-dlog2",
        name: "D-Log2 a Rec.709",
        detail: "Osmo Pocket 4 Pro",
        bytes: include_bytes!("../resources/luts/pocket-4-pro-dlog2.cube"),
    },
    Builtin {
        id: "pocket-4-pro-dlog2-vivid",
        name: "D-Log2 a Rec.709 vívido",
        detail: "Osmo Pocket 4 Pro",
        bytes: include_bytes!("../resources/luts/pocket-4-pro-dlog2-vivid.cube"),
    },
];

/// Estilos creativos de DJI (de Rec.709 a un look), para descargar aparte.
pub struct Pack {
    pub id: &'static str,
    pub name: &'static str,
    url: &'static str,
}

const PACK_BASE: &str = "https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/AC204%E8%BD%AF%E4%BB%B6/%E5%A4%A7%E5%B8%88%E6%BB%A4%E9%95%9C";

pub const PACKS: &[Pack] = &[
    Pack {
        id: "action-5-pro",
        name: "Osmo Action 5 Pro",
        url: "DJI%20OSMO%20Action%205%20Pro%20Rec.709%20to%20Color%20Grading%20LUTs.zip",
    },
    Pack {
        id: "action-4",
        name: "Osmo Action 4",
        url: "DJI%20OSMO%20Action%204%20Rec.709%20to%20Color%20Grading%20LUTs.zip",
    },
    Pack {
        id: "pocket-3",
        name: "Osmo Pocket 3",
        url: "DJI%20OSMO%20Pocket%203%20Rec.709%20to%20Color%20Grading%20LUTs.zip",
    },
];

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LutInfo {
    pub id: String,
    pub name: String,
    pub detail: String,
    /// Viene con la app (no se puede borrar).
    pub builtin: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PackInfo {
    pub id: &'static str,
    pub name: &'static str,
    /// Ya descargado: sus LUT están entre las extra.
    pub installed: bool,
}

const EXTRA_PREFIX: &str = "extra:";

/// Comprueba que el texto sea una LUT 3D `.cube` completa y devuelve su tamaño.
pub fn validate_cube_text(text: &str) -> Result<u32, String> {
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

pub fn validate_cube(path: &Path) -> Result<u32, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("No pude leer la LUT: {e}"))?;
    validate_cube_text(&text)
}

/// Nombre seguro para un archivo y para el filtro de ffmpeg.
fn slug(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_string()
}

fn extra_path(user_dir: &Path, id: &str) -> Option<PathBuf> {
    let name = id.strip_prefix(EXTRA_PREFIX)?;
    // El nombre es el de un archivo de la carpeta, nunca una ruta.
    (!name.contains(['/', '\\']) && name != ".." && !name.is_empty()).then(|| user_dir.join(format!("{name}.cube")))
}

/// Todas las LUT: primero las incluidas, luego las extra por nombre.
pub fn list(user_dir: &Path) -> Vec<LutInfo> {
    let mut extras: Vec<LutInfo> = std::fs::read_dir(user_dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let is_cube = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("cube"));
            let stem = path.file_stem()?.to_str()?.to_string();
            is_cube.then(|| LutInfo { id: format!("{EXTRA_PREFIX}{stem}"), name: stem, detail: "Extra".into(), builtin: false })
        })
        .collect();
    extras.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    BUILTIN
        .iter()
        .map(|b| LutInfo { id: b.id.into(), name: b.name.into(), detail: b.detail.into(), builtin: true })
        .chain(extras)
        .collect()
}

/// Copia una `.cube` a las extra. Si ya hay una con ese nombre, la reemplaza.
pub fn import(user_dir: &Path, source: &Path) -> Result<LutInfo, String> {
    validate_cube(source)?;
    let stem = source
        .file_stem()
        .and_then(|s| s.to_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("El archivo no tiene nombre")?;
    std::fs::create_dir_all(user_dir).map_err(|e| e.to_string())?;
    std::fs::copy(source, user_dir.join(format!("{stem}.cube"))).map_err(|e| format!("No pude copiar la LUT: {e}"))?;
    Ok(LutInfo { id: format!("{EXTRA_PREFIX}{stem}"), name: stem.into(), detail: "Extra".into(), builtin: false })
}

pub fn remove(user_dir: &Path, id: &str) -> Result<(), String> {
    let path = extra_path(user_dir, id).ok_or("Las LUT incluidas no se pueden quitar")?;
    std::fs::remove_file(path).map_err(|e| format!("No pude quitar la LUT: {e}"))
}

/// Deja la LUT en `<cache>/luts/` y devuelve su ruta relativa a la caché,
/// que es la carpeta desde la que corre ffmpeg.
pub fn materialize(id: &str, user_dir: &Path, cache_dir: &Path) -> Result<String, String> {
    let dir = cache_dir.join("luts");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let (file, bytes) = match BUILTIN.iter().find(|b| b.id == id) {
        Some(b) => (format!("{}.cube", b.id), b.bytes.to_vec()),
        None => {
            let path = extra_path(user_dir, id).ok_or_else(|| format!("No conozco la LUT «{id}»"))?;
            let bytes = std::fs::read(&path).map_err(|_| format!("Ya no existe la LUT «{}»", &id[EXTRA_PREFIX.len()..]))?;
            (format!("extra-{}.cube", slug(&id[EXTRA_PREFIX.len()..])), bytes)
        }
    };
    let target = dir.join(&file);
    let same = std::fs::read(&target).is_ok_and(|current| current == bytes);
    if !same {
        std::fs::write(&target, &bytes).map_err(|e| format!("No pude preparar la LUT: {e}"))?;
    }
    Ok(format!("luts/{file}"))
}

fn pack_prefix(pack: &Pack) -> String {
    format!("DJI OSMO {} ", pack.name.trim_start_matches("Osmo "))
}

pub fn packs(user_dir: &Path) -> Vec<PackInfo> {
    let names: Vec<String> = list(user_dir).into_iter().filter(|l| !l.builtin).map(|l| l.name).collect();
    PACKS
        .iter()
        .map(|p| PackInfo {
            id: p.id,
            name: p.name,
            installed: names.iter().any(|n| n.starts_with(&pack_prefix(p))),
        })
        .collect()
}

/// Descarga un paquete de estilos de DJI y agrega sus `.cube` a las extra.
pub fn download_pack(user_dir: &Path, id: &str) -> Result<Vec<LutInfo>, String> {
    let pack = PACKS.iter().find(|p| p.id == id).ok_or("No conozco ese paquete de LUTs")?;
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(10)))
        .timeout_per_read(Some(Duration::from_secs(30)))
        .build()
        .into();
    let mut response = agent
        .get(&format!("{PACK_BASE}/{}", pack.url))
        .header("User-Agent", "ActionDeck")
        .call()
        .map_err(|e| format!("No pude descargar los LUTs de DJI: {e}"))?;
    let zip = response
        .body_mut()
        .with_config()
        .limit(100 * 1024 * 1024)
        .read_to_vec()
        .map_err(|e| format!("Se cortó la descarga de los LUTs: {e}"))?;
    extract_cubes(&zip, user_dir)
}

/// Guarda cada `.cube` del zip (sin sus carpetas) entre las extra.
fn extract_cubes(zip: &[u8], user_dir: &Path) -> Result<Vec<LutInfo>, String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(zip)).map_err(|e| format!("El zip de DJI no es válido: {e}"))?;
    std::fs::create_dir_all(user_dir).map_err(|e| e.to_string())?;
    let mut added = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let Some(name) = entry.enclosed_name().and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned())) else {
            continue;
        };
        // Los zips hechos en Mac traen copias `._` sin datos de la LUT.
        if !name.to_lowercase().ends_with(".cube") || name.starts_with("._") {
            continue;
        }
        let mut text = String::new();
        entry.read_to_string(&mut text).map_err(|e| format!("No pude leer {name}: {e}"))?;
        validate_cube_text(&text).map_err(|e| format!("{name}: {e}"))?;
        std::fs::write(user_dir.join(&name), text).map_err(|e| format!("No pude guardar {name}: {e}"))?;
        let stem = name[..name.len() - 5].to_string();
        added.push(LutInfo { id: format!("{EXTRA_PREFIX}{stem}"), name: stem, detail: "Extra".into(), builtin: false });
    }
    if added.is_empty() {
        return Err("El paquete de DJI no traía LUTs".into());
    }
    Ok(added)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tiny_cube() -> String {
        let mut text = String::from("TITLE \"prueba\"\nLUT_3D_SIZE 2\n");
        for _ in 0..8 {
            text.push_str("0.5 0.5 0.5\n");
        }
        text
    }

    #[test]
    fn builtin_luts_are_complete_and_their_ids_are_safe_for_ffmpeg() {
        for b in BUILTIN {
            let text = std::str::from_utf8(b.bytes).unwrap();
            assert_eq!(validate_cube_text(text), Ok(33), "{}", b.id);
            assert_eq!(slug(b.id), b.id);
        }
        // Cada LUT sugerida para una cámara existe.
        for d in crate::devices::DEVICES {
            for id in [d.dlog_m, d.dlog, d.dlog2].into_iter().flatten() {
                assert!(BUILTIN.iter().any(|b| b.id == id), "{id}");
            }
        }
    }

    #[test]
    fn imports_lists_materializes_and_removes_extras() {
        let dir = tempfile::tempdir().unwrap();
        let (user, cache) = (dir.path().join("luts"), dir.path().join("cache"));
        let source = dir.path().join("Mi look cálido (2).cube");
        std::fs::write(&source, tiny_cube()).unwrap();

        let lut = import(&user, &source).unwrap();
        assert_eq!(lut.id, "extra:Mi look cálido (2)");
        let all = list(&user);
        assert_eq!(all.len(), BUILTIN.len() + 1);
        assert!(!all.last().unwrap().builtin);

        assert_eq!(materialize(&lut.id, &user, &cache).unwrap(), "luts/extra-mi-look-c-lido-2.cube");
        assert_eq!(materialize("dlog-m", &user, &cache).unwrap(), "luts/dlog-m.cube");
        assert!(cache.join("luts/dlog-m.cube").is_file());

        assert!(remove(&user, "dlog-m").is_err());
        assert!(remove(&user, "extra:../../etc/passwd").is_err());
        remove(&user, &lut.id).unwrap();
        assert!(materialize(&lut.id, &user, &cache).is_err());
    }

    #[test]
    fn extracts_only_the_real_cubes_from_a_dji_zip() {
        let mut buffer = Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buffer);
            let options = zip::write::SimpleFileOptions::default();
            zip.add_directory("DJI OSMO Action 5 Pro Rec.709 to Color Grading LUTs/", options).unwrap();
            zip.start_file("DJI OSMO Action 5 Pro Rec.709 to Color Grading LUTs/DJI OSMO Action 5 Pro Mei.cube", options).unwrap();
            zip.write_all(tiny_cube().as_bytes()).unwrap();
            zip.start_file("__MACOSX/._DJI OSMO Action 5 Pro Mei.cube", options).unwrap();
            zip.write_all(b"basura").unwrap();
            zip.finish().unwrap();
        }
        let dir = tempfile::tempdir().unwrap();
        let added = extract_cubes(buffer.get_ref(), dir.path()).unwrap();
        assert_eq!(added.len(), 1);
        assert_eq!(added[0].name, "DJI OSMO Action 5 Pro Mei");
        let packs = packs(dir.path());
        assert!(packs.iter().find(|p| p.id == "action-5-pro").unwrap().installed);
        assert!(!packs.iter().find(|p| p.id == "pocket-3").unwrap().installed);
    }
}
