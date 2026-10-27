//! LUTs. Vienen dentro de la app las oficiales de DJI que convierten el perfil
//! logarítmico a Rec.709 y la galería de estilos (generada con
//! `scripts/looks/generate.py`); las extra (los estilos creativos de DJI o
//! cualquier `.cube`) las agrega el usuario y se guardan en su carpeta de datos.
//!
//! Un estilo se puede aplicar con menos intensidad: se mezcla con la LUT
//! identidad (ver `materialize_mix`).
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

struct Look {
    id: &'static str,
    name: &'static str,
    detail: &'static str,
    category: &'static str,
    bytes: &'static [u8],
}

/// La galería, ordenada por uso: de Rec.709 a un estilo. Las recetas y sus
/// mediciones están en `scripts/looks/generate.py`.
const LOOKS: &[Look] = &[
    Look {
        id: "proyeccion",
        name: "Proyección",
        detail: "Película de cine en sala, al estilo de Kodak 2383: sombras frías, luces cálidas",
        category: "Cine",
        bytes: include_bytes!("../resources/looks/proyeccion.cube"),
    },
    Look {
        id: "blockbuster",
        name: "Blockbuster",
        detail: "Teal & orange de Hollywood: piel cálida contra fondos verde azulado",
        category: "Cine",
        bytes: include_bytes!("../resources/looks/blockbuster.cube"),
    },
    Look {
        id: "esmeralda",
        name: "Esmeralda",
        detail: "Verdes y azules fundidos en verde azulado, como el cine de suspenso",
        category: "Cine",
        bytes: include_bytes!("../resources/looks/esmeralda.cube"),
    },
    Look {
        id: "medianoche",
        name: "Medianoche",
        detail: "Noche de cine: sombras azules y luces de la calle cálidas",
        category: "Cine",
        bytes: include_bytes!("../resources/looks/medianoche.cube"),
    },
    Look {
        id: "cine-suave",
        name: "Cine suave",
        detail: "Negativo de cine de bajo contraste, al estilo de Fujifilm Eterna",
        category: "Cine",
        bytes: include_bytes!("../resources/looks/cine-suave.cube"),
    },
    Look {
        id: "bleach-bypass",
        name: "Bleach bypass",
        detail: "Revelado sin blanqueo: mucho contraste y color lavado",
        category: "Cine",
        bytes: include_bytes!("../resources/looks/bleach-bypass.cube"),
    },
    Look {
        id: "vivido",
        name: "Vívido",
        detail: "Color alto y limpio para redes, sin quemar la piel",
        category: "Vívido",
        bytes: include_bytes!("../resources/looks/vivido.cube"),
    },
    Look {
        id: "verano",
        name: "Verano",
        detail: "Vívido y cálido: agua turquesa, naranjas y sol dorado",
        category: "Vívido",
        bytes: include_bytes!("../resources/looks/verano.cube"),
    },
    Look {
        id: "aventura",
        name: "Aventura",
        detail: "Natural pero con fuerza: cielos más profundos, verdes vivos",
        category: "Vívido",
        bytes: include_bytes!("../resources/looks/aventura.cube"),
    },
    Look {
        id: "asfalto",
        name: "Asfalto",
        detail: "Motoblog urbano: asfalto frío y duro; el rojo y el naranja de la moto destacan",
        category: "Motos",
        bytes: include_bytes!("../resources/looks/asfalto.cube"),
    },
    Look {
        id: "ruta",
        name: "Ruta",
        detail: "Viaje en carretera: contraste fuerte, cielo profundo y luz dorada",
        category: "Motos",
        bytes: include_bytes!("../resources/looks/ruta.cube"),
    },
    Look {
        id: "neon",
        name: "Neón",
        detail: "Noche en moto: negros profundos y neones magenta y cian",
        category: "Motos",
        bytes: include_bytes!("../resources/looks/neon.cube"),
    },
    Look {
        id: "bosque",
        name: "Bosque",
        detail: "Verdes profundos hacia esmeralda, tierra cálida y sol suave",
        category: "Senderismo",
        bytes: include_bytes!("../resources/looks/bosque.cube"),
    },
    Look {
        id: "cumbre",
        name: "Cumbre",
        detail: "Aire de montaña: cielo profundo, nieve limpia y nítida",
        category: "Senderismo",
        bytes: include_bytes!("../resources/looks/cumbre.cube"),
    },
    Look {
        id: "hora-dorada",
        name: "Hora dorada",
        detail: "Amanecer o atardecer: luz cálida y sombras algo frías",
        category: "Senderismo",
        bytes: include_bytes!("../resources/looks/hora-dorada.cube"),
    },
    Look {
        id: "nordico",
        name: "Nórdico",
        detail: "Frío y sobrio, para nieve, niebla y días nublados",
        category: "Senderismo",
        bytes: include_bytes!("../resources/looks/nordico.cube"),
    },
    Look {
        id: "retrato",
        name: "Retrato",
        detail: "Negativo de retrato, al estilo de Kodak Portra: cálido, suave y favorecedor",
        category: "Película",
        bytes: include_bytes!("../resources/looks/retrato.cube"),
    },
    Look {
        id: "diapositiva",
        name: "Diapositiva",
        detail: "Diapositiva clásica, al estilo de Kodachrome: rojos ricos y azules profundos",
        category: "Película",
        bytes: include_bytes!("../resources/looks/diapositiva.cube"),
    },
    Look {
        id: "reportaje",
        name: "Reportaje",
        detail: "Color sobrio y tonalidad dura, al estilo de Classic Chrome de Fujifilm",
        category: "Película",
        bytes: include_bytes!("../resources/looks/reportaje.cube"),
    },
    Look {
        id: "paisaje",
        name: "Paisaje",
        detail: "Diapositiva de paisaje, al estilo de Fujifilm Velvia: cielos y verdes intensos",
        category: "Película",
        bytes: include_bytes!("../resources/looks/paisaje.cube"),
    },
    Look {
        id: "bn-clasico",
        name: "B/N clásico",
        detail: "Blanco y negro pancromático con contraste firme, al estilo de Kodak Tri-X",
        category: "B/N",
        bytes: include_bytes!("../resources/looks/bn-clasico.cube"),
    },
    Look {
        id: "bn-selenio",
        name: "B/N selenio",
        detail: "Blanco y negro suave con un viraje cálido",
        category: "B/N",
        bytes: include_bytes!("../resources/looks/bn-selenio.cube"),
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

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// Oficial de DJI: de un perfil LOG a Rec.709.
    Conversion,
    /// De la galería, incluido en la app.
    Look,
    /// Agregada por el usuario (se puede quitar).
    Extra,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LutInfo {
    pub id: String,
    pub name: String,
    pub detail: String,
    pub kind: Kind,
    /// Grupo de la galería ("Cine", "Película"…), solo en los estilos.
    pub category: Option<String>,
}

fn extra_info(stem: &str) -> LutInfo {
    LutInfo { id: format!("{EXTRA_PREFIX}{stem}"), name: stem.into(), detail: "Extra".into(), kind: Kind::Extra, category: None }
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

/// Todas las LUT: las de conversión, la galería y luego las extra por nombre.
pub fn list(user_dir: &Path) -> Vec<LutInfo> {
    let mut extras: Vec<LutInfo> = std::fs::read_dir(user_dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let is_cube = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("cube"));
            let stem = path.file_stem()?.to_str()?.to_string();
            is_cube.then(|| extra_info(&stem))
        })
        .collect();
    extras.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    BUILTIN
        .iter()
        .map(|b| LutInfo { id: b.id.into(), name: b.name.into(), detail: b.detail.into(), kind: Kind::Conversion, category: None })
        .chain(LOOKS.iter().map(|l| LutInfo {
            id: l.id.into(),
            name: l.name.into(),
            detail: l.detail.into(),
            kind: Kind::Look,
            category: Some(l.category.into()),
        }))
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
    Ok(extra_info(stem))
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
    let included = BUILTIN.iter().map(|b| (b.id, b.bytes)).chain(LOOKS.iter().map(|l| (l.id, l.bytes)));
    let (file, bytes) = match included.into_iter().find(|(builtin, _)| *builtin == id) {
        Some((id, bytes)) => (format!("{id}.cube"), bytes.to_vec()),
        None => {
            let path = extra_path(user_dir, id).ok_or_else(|| format!("No conozco la LUT «{id}»"))?;
            let bytes = std::fs::read(&path).map_err(|_| format!("Ya no existe la LUT «{}»", &id[EXTRA_PREFIX.len()..]))?;
            (format!("extra-{}.cube", slug(&id[EXTRA_PREFIX.len()..])), bytes)
        }
    };
    write_if_changed(&dir.join(&file), &bytes)?;
    Ok(format!("luts/{file}"))
}

fn write_if_changed(target: &Path, bytes: &[u8]) -> Result<(), String> {
    if !std::fs::read(target).is_ok_and(|current| current == bytes) {
        std::fs::write(target, bytes).map_err(|e| format!("No pude preparar la LUT: {e}"))?;
    }
    Ok(())
}

/// Como `materialize`, pero con la intensidad (`amount`, 0–1) ya aplicada:
/// cada punto de la LUT se mezcla con el de la identidad. Da lo mismo que
/// mezclar la imagen con y sin la LUT, que es lo que hace la vista previa,
/// porque la interpolación de la identidad es exacta. Se redondea al 1 %.
pub fn materialize_mix(id: &str, amount: f64, user_dir: &Path, cache_dir: &Path) -> Result<String, String> {
    let full = materialize(id, user_dir, cache_dir)?;
    let percent = (amount.clamp(0.0, 1.0) * 100.0).round() as u32;
    if percent >= 100 {
        return Ok(full);
    }
    let text = std::fs::read_to_string(cache_dir.join(&full)).map_err(|e| format!("No pude leer la LUT: {e}"))?;
    let mixed = mix_with_identity(&text, f64::from(percent) / 100.0)?;
    let file = format!("{}-{percent}.cube", full.trim_end_matches(".cube"));
    write_if_changed(&cache_dir.join(&file), mixed.as_bytes())?;
    Ok(file)
}

/// Mezcla una LUT 3D con la identidad de su mismo dominio.
fn mix_with_identity(text: &str, amount: f64) -> Result<String, String> {
    let size = validate_cube_text(text)? as usize;
    let mut domain = ([0.0f64; 3], [1.0f64; 3]);
    for line in text.lines().map(str::trim) {
        for (key, slot) in [("DOMAIN_MIN", &mut domain.0), ("DOMAIN_MAX", &mut domain.1)] {
            if let Some(rest) = line.strip_prefix(key) {
                let values: Vec<f64> = rest.split_whitespace().filter_map(|v| v.parse().ok()).collect();
                if values.len() == 3 {
                    slot.copy_from_slice(&values);
                }
            }
        }
    }
    let mut out = format!("LUT_3D_SIZE {size}\nDOMAIN_MIN {} {} {}\nDOMAIN_MAX {} {} {}\n", domain.0[0], domain.0[1], domain.0[2], domain.1[0], domain.1[1], domain.1[2]);
    let step = |axis: usize, i: usize| domain.0[axis] + (domain.1[axis] - domain.0[axis]) * i as f64 / (size - 1) as f64;
    let rows = text.lines().map(str::trim).filter(|l| l.split_whitespace().count() == 3 && l.split_whitespace().all(|v| v.parse::<f64>().is_ok()));
    for (n, row) in rows.enumerate() {
        // Orden .cube: el rojo cambia más rápido.
        let (r, g, b) = (n % size, (n / size) % size, n / (size * size));
        let identity = [step(0, r), step(1, g), step(2, b)];
        let values: Vec<String> = row
            .split_whitespace()
            .zip(identity)
            .map(|(v, id)| format!("{:.6}", id + (v.parse::<f64>().unwrap() - id) * amount))
            .collect();
        out.push_str(&values.join(" "));
        out.push('\n');
    }
    Ok(out)
}

fn pack_prefix(pack: &Pack) -> String {
    format!("DJI OSMO {} ", pack.name.trim_start_matches("Osmo "))
}

pub fn packs(user_dir: &Path) -> Vec<PackInfo> {
    let names: Vec<String> = list(user_dir).into_iter().filter(|l| l.kind == Kind::Extra).map(|l| l.name).collect();
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
        added.push(extra_info(&stem));
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
    fn the_gallery_is_complete_and_its_ids_are_safe_for_ffmpeg() {
        let dir = tempfile::tempdir().unwrap();
        for l in LOOKS {
            let text = std::str::from_utf8(l.bytes).unwrap();
            assert_eq!(validate_cube_text(text), Ok(33), "{}", l.id);
            assert_eq!(slug(l.id), l.id);
            assert!(!BUILTIN.iter().any(|b| b.id == l.id));
            assert_eq!(materialize(l.id, dir.path(), dir.path()).unwrap(), format!("luts/{}.cube", l.id));
        }
        let looks: Vec<_> = list(dir.path()).into_iter().filter(|l| l.kind == Kind::Look).collect();
        assert_eq!(looks.len(), LOOKS.len());
        assert!(looks.iter().all(|l| l.category.is_some()));
    }

    #[test]
    fn intensity_mixes_the_lut_with_the_identity() {
        let mut text = String::from("LUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n");
        for _ in 0..8 {
            text.push_str("0.5 0.5 0.5\n");
        }
        let rows = |t: &str| -> Vec<Vec<f64>> {
            t.lines().filter(|l| l.split_whitespace().count() == 3 && !l.starts_with("DOMAIN")).map(|l| l.split_whitespace().map(|v| v.parse().unwrap()).collect()).collect()
        };
        // 0: la identidad, con el rojo cambiando más rápido.
        let none = rows(&mix_with_identity(&text, 0.0).unwrap());
        assert_eq!(none[1], vec![1.0, 0.0, 0.0]);
        assert_eq!(none[2], vec![0.0, 1.0, 0.0]);
        assert_eq!(none[4], vec![0.0, 0.0, 1.0]);
        // A la mitad, entre la identidad y la LUT.
        let half = rows(&mix_with_identity(&text, 0.5).unwrap());
        assert_eq!(half[7], vec![0.75, 0.75, 0.75]);
        assert_eq!(half[0], vec![0.25, 0.25, 0.25]);

        let dir = tempfile::tempdir().unwrap();
        assert_eq!(materialize_mix("retrato", 1.0, dir.path(), dir.path()).unwrap(), "luts/retrato.cube");
        let file = materialize_mix("retrato", 0.6, dir.path(), dir.path()).unwrap();
        assert_eq!(file, "luts/retrato-60.cube");
        assert_eq!(validate_cube_text(&std::fs::read_to_string(dir.path().join(file)).unwrap()), Ok(33));
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
        assert_eq!(all.len(), BUILTIN.len() + LOOKS.len() + 1);
        assert_eq!(all.last().unwrap().kind, Kind::Extra);

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
