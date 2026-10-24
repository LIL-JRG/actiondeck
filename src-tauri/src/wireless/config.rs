//! Identidad de emparejamiento y cámaras conocidas, en `wireless.json` junto a
//! los ajustes de la app.
//!
//! La cámara recuerda la aprobación por el identificador: debe generarse una
//! sola vez y no cambiar, o pediría aceptar en pantalla en cada conexión y
//! gastaría un lugar de su memoria de emparejamientos.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KnownCamera {
    /// Nombre que anuncia por Bluetooth, p. ej. `OsmoAction5Pro-2DCA`.
    pub name: String,
    pub model: String,
    pub ssid: String,
    pub password: String,
    pub wifi_mac: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WirelessConfig {
    /// 32 caracteres; la clave con la que la cámara recuerda la aprobación.
    pub identifier: String,
    /// Texto que la cámara muestra al pedir la aprobación. El "poke" TCP 7001
    /// debe llevar el mismo con el que se emparejó por Bluetooth.
    pub token: String,
    #[serde(default)]
    pub cameras: Vec<KnownCamera>,
}

impl WirelessConfig {
    fn generate() -> Self {
        // Mismo formato que usan las apps de DJI: un UUID truncado a 32 caracteres.
        let identifier: String = uuid::Uuid::new_v4().to_string().chars().take(32).collect();
        Self { identifier, token: "osmo".into(), cameras: Vec::new() }
    }

    /// Lee la configuración o la crea (y la guarda) la primera vez.
    pub fn load_or_create(path: &Path) -> Result<Self, String> {
        if let Ok(text) = std::fs::read_to_string(path) {
            return serde_json::from_str(&text).map_err(|e| format!("{} está dañado: {e}", path.display()));
        }
        let config = Self::generate();
        config.save(path)?;
        Ok(config)
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(path, json).map_err(|e| format!("No pude guardar {}: {e}", path.display()))
    }

    pub fn remember(&mut self, camera: KnownCamera) {
        self.cameras.retain(|c| c.name != camera.name);
        self.cameras.push(camera);
    }

    pub fn find(&self, name_or_ssid: &str) -> Option<&KnownCamera> {
        self.cameras.iter().find(|c| c.name == name_or_ssid || c.ssid == name_or_ssid)
    }
}

/// Carpeta de configuración de ActionDeck, la misma que usa la app.
pub fn config_dir() -> PathBuf {
    dirs::config_dir().unwrap_or_else(std::env::temp_dir).join("com.jorge.actiondeck")
}

pub fn default_path() -> PathBuf {
    config_dir().join("wireless.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_is_created_once_and_kept() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("wireless.json");
        let first = WirelessConfig::load_or_create(&path).unwrap();
        assert_eq!(first.identifier.len(), 32);
        let again = WirelessConfig::load_or_create(&path).unwrap();
        assert_eq!(first, again);
    }

    #[test]
    fn remembering_replaces_the_same_camera() {
        let mut config = WirelessConfig::generate();
        let cam = |pass: &str| KnownCamera {
            name: "OsmoAction5Pro-2DCA".into(),
            model: "Osmo Action 5 Pro".into(),
            ssid: "OsmoAction5Pro-2DCA".into(),
            password: pass.into(),
            wifi_mac: None,
        };
        config.remember(cam("a"));
        config.remember(cam("b"));
        assert_eq!(config.cameras.len(), 1);
        assert_eq!(config.find("OsmoAction5Pro-2DCA").unwrap().password, "b");
    }
}
