//! Conexión sin cable con la cámara (fase 2): Bluetooth para emparejar y pedir
//! el Wi-Fi, Wi-Fi para listar y descargar.

pub mod ble;
pub mod config;
pub mod datalink;
pub mod download;
pub mod duml;
pub mod log;
pub mod manifest;
pub mod watch;
pub mod wifi;
