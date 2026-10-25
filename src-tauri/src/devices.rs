//! Cámaras DJI que la app conoce: cómo se anuncian por Bluetooth, cómo se
//! llaman en los metadatos de sus videos, si se pueden conectar por Wi-Fi y
//! qué LUT oficial les devuelve el color.

use serde::Serialize;

/// Qué tan probada está la conexión por Wi-Fi (el protocolo de la Action 5 Pro).
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Wifi {
    /// Probada con esta app.
    Tested,
    /// Mismo protocolo, verificado por Osmosis (KonradIT) en una cámara real.
    Compatible,
    /// Debería funcionar, pero nadie lo ha confirmado.
    Untested,
    /// No expone sus archivos por Wi-Fi de esta forma (o no se sabe cómo).
    Unsupported,
}

/// Forma de la cámara, para dibujarla.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Family {
    Action,
    Pocket,
    Pano,
}

/// Perfil de color con el que se grabó un clip (`ColorMode` de los metadatos `djmd`).
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ColorMode {
    Normal,
    DCinelike,
    DLog,
    DLogM,
    DLog2,
    Hlg,
}

impl ColorMode {
    /// Valores de `dvtm_library.proto` (telemetry-parser de Gyroflow).
    pub fn from_dvtm(value: u64) -> ColorMode {
        match value {
            1 => ColorMode::DCinelike,
            2 => ColorMode::DLog,
            9 => ColorMode::Hlg,
            19 => ColorMode::DLogM,
            22 => ColorMode::DLog2,
            _ => ColorMode::Normal,
        }
    }

    pub fn is_log(self) -> bool {
        matches!(self, ColorMode::DLog | ColorMode::DLogM | ColorMode::DLog2)
    }
}

pub struct Device {
    pub name: &'static str,
    /// ID de modelo en los datos del fabricante del anuncio Bluetooth (osmosis BleConstants.kt).
    pub ble_id: u16,
    pub family: Family,
    pub wifi: Wifi,
    /// LUT oficial para cada perfil logarítmico que graba.
    pub dlog_m: Option<&'static str>,
    pub dlog: Option<&'static str>,
    pub dlog2: Option<&'static str>,
}

const fn device(name: &'static str, ble_id: u16, family: Family, wifi: Wifi) -> Device {
    Device { name, ble_id, family, wifi, dlog_m: None, dlog: None, dlog2: None }
}

pub const DEVICES: &[Device] = &[
    device("Osmo Action", 0x0006, Family::Action, Wifi::Unsupported),
    device("Osmo Action 2", 0x0010, Family::Action, Wifi::Unsupported),
    device("Osmo Action 3", 0x0012, Family::Action, Wifi::Untested),
    Device { dlog_m: Some("dlog-m"), ..device("Osmo Action 4", 0x0014, Family::Action, Wifi::Untested) },
    Device { dlog_m: Some("dlog-m"), ..device("Osmo Action 5 Pro", 0x0015, Family::Action, Wifi::Tested) },
    // Osmosis la empareja, pero la cámara no levanta su red Wi-Fi.
    Device { dlog_m: Some("dlog-m"), ..device("Osmo 360", 0x0017, Family::Pano, Wifi::Unsupported) },
    Device { dlog_m: Some("action-6"), ..device("Osmo Action 6", 0x0018, Family::Action, Wifi::Compatible) },
    Device { dlog_m: Some("dlog-m"), ..device("Osmo Nano", 0x0019, Family::Action, Wifi::Compatible) },
    Device { dlog_m: Some("dlog-m"), ..device("Osmo Pocket 3", 0x0020, Family::Pocket, Wifi::Compatible) },
    Device { dlog: Some("pocket-4"), ..device("Osmo Pocket 4", 0x0021, Family::Pocket, Wifi::Untested) },
    Device {
        dlog: Some("pocket-4-pro"),
        dlog2: Some("pocket-4-pro-dlog2"),
        ..device("Osmo Pocket 4 Pro", 0x0022, Family::Pocket, Wifi::Untested)
    },
];

pub fn by_ble_id(id: u16) -> Option<&'static Device> {
    DEVICES.iter().find(|d| d.ble_id == id)
}

/// Solo letras y números, en minúsculas y sin el prefijo "DJI".
fn normalize(text: &str) -> String {
    let flat: String = text.chars().filter(char::is_ascii_alphanumeric).collect::<String>().to_ascii_lowercase();
    flat.strip_prefix("dji").map(str::to_string).unwrap_or(flat)
}

/// Busca el modelo en un nombre Bluetooth (`OsmoAction5Pro675D`) o en la
/// etiqueta `encoder` de un video (`DJI OsmoAction5 Pro`). Gana el nombre
/// más largo: "Osmo Action 5 Pro" y no "Osmo Action".
pub fn by_name(text: &str) -> Option<&'static Device> {
    let text = normalize(text);
    DEVICES
        .iter()
        .filter(|d| text.starts_with(&normalize(d.name)))
        .max_by_key(|d| d.name.len())
}

/// La LUT oficial que convierte este clip a Rec.709, si se grabó en un perfil logarítmico.
pub fn suggested_lut(device: Option<&Device>, mode: ColorMode) -> Option<&'static str> {
    match (device, mode) {
        (Some(d), ColorMode::DLogM) => d.dlog_m.or(Some("dlog-m")),
        (Some(d), ColorMode::DLog) => d.dlog,
        (Some(d), ColorMode::DLog2) => d.dlog2,
        // Sin saber la cámara, D-Log M es el de casi todos los Osmo.
        (None, ColorMode::DLogM) => Some("dlog-m"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_from_bluetooth_and_from_video_metadata() {
        assert_eq!(by_name("OsmoAction5Pro675D").unwrap().name, "Osmo Action 5 Pro");
        assert_eq!(by_name("DJI OsmoAction5 Pro").unwrap().name, "Osmo Action 5 Pro");
        assert_eq!(by_name("OsmoAction-1234").unwrap().name, "Osmo Action");
        assert_eq!(by_name("OsmoPocket4Pro-AB12").unwrap().name, "Osmo Pocket 4 Pro");
        assert_eq!(by_name("DJI OsmoPocket3").unwrap().name, "Osmo Pocket 3");
        assert_eq!(by_name("Osmo360-77AA").unwrap().name, "Osmo 360");
        assert!(by_name("iPhone").is_none());
    }

    #[test]
    fn every_device_has_a_distinct_bluetooth_id() {
        for d in DEVICES {
            assert_eq!(by_ble_id(d.ble_id).unwrap().name, d.name);
        }
    }

    #[test]
    fn suggests_the_official_lut_only_for_log_footage() {
        let oa5 = by_name("OsmoAction5Pro").unwrap();
        let oa6 = by_name("OsmoAction6").unwrap();
        let p4p = by_name("OsmoPocket4Pro").unwrap();
        assert_eq!(suggested_lut(Some(oa5), ColorMode::DLogM), Some("dlog-m"));
        assert_eq!(suggested_lut(Some(oa6), ColorMode::DLogM), Some("action-6"));
        assert_eq!(suggested_lut(Some(p4p), ColorMode::DLog2), Some("pocket-4-pro-dlog2"));
        assert_eq!(suggested_lut(Some(oa5), ColorMode::Normal), None);
        assert_eq!(suggested_lut(Some(oa5), ColorMode::Hlg), None);
        assert_eq!(suggested_lut(None, ColorMode::DLogM), Some("dlog-m"));
    }
}
