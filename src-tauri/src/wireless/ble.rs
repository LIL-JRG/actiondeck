//! Bluetooth LE: encontrar la cámara, emparejar y pedirle su Wi-Fi.
//!
//! Secuencia (osmosis/MEDIA_PROTOCOL.md §21-25, osmo-client docs/PROTOCOL.md §3.3):
//! 1. Suscribirse a `fff4` y `fff5` y escribir `01 00` en el valor de `fff4`.
//!    Sin este paso la cámara acepta las escrituras pero no contesta nada.
//! 2. `00/2B [04 00]` abre la sesión.
//! 3. `07/45` empareja; si responde `00 02`, la cámara pide aceptar en su
//!    pantalla y la aprobación llega como *petición* `07/46`, que hay que contestar.
//! 4. `53/10` despierta la cámara; `00/2B [01 01]` cada segundo la mantiene.
//! 5. `07/07` y `07/0E` devuelven el nombre y la contraseña de su red.
//!
//! Igual que Mimo, cuelga el Bluetooth en cuanto tiene la contraseña: dejarlo
//! abierto rompía la conexión Wi-Fi tras apagones cortos (dji-vcam).

use btleplug::api::{Central, Characteristic, Manager as _, Peripheral as _, ScanFilter, WriteType};
use btleplug::platform::{Manager, Peripheral};
use futures::StreamExt;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::{sleep, timeout, Instant};
use uuid::Uuid;

use super::config::WirelessConfig;
use super::duml::{self, addr, hex, Frame, Reassembler};
use super::log::{redact, Log};

pub const DJI_COMPANY_IDS: [u16; 3] = [0x08AA, 0xF7AA, 0xE5C0];
const FFF4: Uuid = Uuid::from_u128(0x0000fff4_0000_1000_8000_00805f9b34fb);
const FFF5: Uuid = Uuid::from_u128(0x0000fff5_0000_1000_8000_00805f9b34fb);

/// Espacio mínimo entre escrituras en `fff5` (sin confirmación).
const WRITE_GAP: Duration = Duration::from_millis(120);

/// Nombre del modelo según el ID que anuncia (osmosis BleConstants.kt).
pub fn model_name(id: u16) -> &'static str {
    match id {
        0x0006 => "Osmo Action",
        0x0010 => "Osmo Action 2",
        0x0012 => "Osmo Action 3",
        0x0014 => "Osmo Action 4",
        0x0015 => "Osmo Action 5 Pro",
        0x0017 => "Osmo 360",
        0x0018 => "Osmo Action 6",
        0x0019 => "Osmo Nano",
        0x0020 => "Osmo Pocket 3",
        0x0021 => "Osmo Pocket 4",
        0x0022 => "Osmo Pocket 4 Pro",
        _ => "Dispositivo DJI desconocido",
    }
}

const KNOWN_MODELS: [u16; 11] = [0x0006, 0x0010, 0x0012, 0x0014, 0x0015, 0x0017, 0x0018, 0x0019, 0x0020, 0x0021, 0x0022];

/// Modelo según el nombre anunciado (`OsmoAction5Pro675D`), para cuando aún
/// no llegan los datos del fabricante. Gana el más largo: "Osmo Action 5 Pro"
/// y no "Osmo Action".
pub fn model_from_name(name: &str) -> Option<&'static str> {
    KNOWN_MODELS
        .iter()
        .map(|&id| model_name(id))
        .filter(|model| name.starts_with(&model.replace(' ', "")))
        .max_by_key(|model| model.len())
}

#[derive(Clone, Debug)]
pub struct Advert {
    pub model_id: Option<u16>,
    /// `Some(true)` despierta, `Some(false)` dormida. Formato verificado solo
    /// en una Nano; en otros modelos puede no aplicar.
    pub awake: Option<bool>,
    pub raw: Vec<u8>,
}

/// Interpreta los datos del fabricante: `<modelo u16 LE> 40 <dirección 6 B> <estado>`.
pub fn parse_advert(manufacturer: &std::collections::HashMap<u16, Vec<u8>>) -> Option<Advert> {
    let raw = DJI_COMPANY_IDS.iter().find_map(|id| manufacturer.get(id))?.clone();
    let model_id = (raw.len() >= 2).then(|| u16::from_le_bytes([raw[0], raw[1]])).filter(|&m| m != 0);
    let awake = match raw.get(9) {
        Some(0x02) => Some(true),
        Some(0x03) => Some(false),
        _ => None,
    };
    Some(Advert { model_id, awake, raw })
}

/// Por datos del fabricante o, si no los anuncia, por el nombre.
pub fn looks_dji(name: &str, advert: Option<&Advert>) -> bool {
    advert.is_some() || name.starts_with("Osmo") || name.starts_with("DJI")
}

#[derive(Clone)]
pub struct FoundCamera {
    pub peripheral: Peripheral,
    pub name: String,
    pub model: &'static str,
    pub advert: Option<Advert>,
    pub rssi: Option<i16>,
}

impl FoundCamera {
    pub fn describe(&self) -> String {
        let state = match self.advert.as_ref().and_then(|a| a.awake) {
            Some(true) => "despierta",
            Some(false) => "dormida",
            None => "estado desconocido",
        };
        format!(
            "{} · {} · {} · señal {} dBm · datos {}",
            self.name,
            self.model,
            state,
            self.rssi.map(|r| r.to_string()).unwrap_or_else(|| "?".into()),
            self.advert.as_ref().map(|a| hex(&a.raw)).unwrap_or_default()
        )
    }
}

pub async fn adapter(log: &Log) -> Result<btleplug::platform::Adapter, String> {
    let manager = Manager::new().await.map_err(|e| format!("Bluetooth no disponible: {e}"))?;
    let adapters = manager.adapters().await.map_err(|e| format!("No pude listar adaptadores Bluetooth: {e}"))?;
    let adapter = adapters.into_iter().next().ok_or(
        "No hay adaptador Bluetooth. Conecta uno o enciende el Bluetooth del sistema.",
    )?;
    log.line(format!("Adaptador Bluetooth: {}", adapter.adapter_info().await.unwrap_or_default()));
    Ok(adapter)
}

/// Busca durante `duration` cámaras DJI (por datos del fabricante o por nombre).
pub async fn scan(log: &Log, duration: Duration) -> Result<Vec<FoundCamera>, String> {
    let central = adapter(log).await?;
    central.start_scan(ScanFilter::default()).await.map_err(|e| format!("No pude buscar: {e}"))?;
    log.line(format!("Buscando cámaras durante {} s…", duration.as_secs()));
    sleep(duration).await;
    let _ = central.stop_scan().await;

    // Sin permiso de Bluetooth, macOS no da error: solo no ve nada.
    let state = central.adapter_state().await.map(|s| format!("{s:?}")).unwrap_or_else(|e| e.to_string());
    let peripherals = central.peripherals().await.map_err(|e| e.to_string())?;
    log.line(format!("Estado del Bluetooth: {state} · {} dispositivos a la vista", peripherals.len()));

    let mut found = Vec::new();
    for peripheral in peripherals {
        let Ok(Some(props)) = peripheral.properties().await else { continue };
        let advert = parse_advert(&props.manufacturer_data);
        let name = props.local_name.or(props.advertisement_name).unwrap_or_default();
        if !looks_dji(&name, advert.as_ref()) {
            let ids: Vec<String> = props.manufacturer_data.keys().map(|id| format!("{id:04x}")).collect();
            log.line(format!("  otro: {} · fabricante [{}]", if name.is_empty() { "(sin nombre)" } else { &name }, ids.join(" ")));
            continue;
        }
        let model = advert.as_ref().and_then(|a| a.model_id).map(model_name).unwrap_or("Modelo no anunciado");
        let cam = FoundCamera { peripheral, name: if name.is_empty() { "(sin nombre)".into() } else { name }, model, advert, rssi: props.rssi };
        log.line(format!("Encontrada: {}", cam.describe()));
        found.push(cam);
    }
    found.sort_by_key(|c| std::cmp::Reverse(c.rssi.unwrap_or(i16::MIN)));
    Ok(found)
}

#[derive(Clone, Debug)]
pub struct Credentials {
    pub ssid: String,
    pub password: String,
    pub wifi_mac: Option<String>,
    /// La cámara pidió aceptar en su pantalla en esta conexión.
    pub needed_approval: bool,
}

/// La trama para el registro, sin la contraseña del Wi-Fi (respuesta a `07/0E`).
fn shown(frame: &Frame) -> String {
    if frame.is(0x07, 0x0E) && frame.is_response() {
        let hidden = Frame { payload: Vec::new(), ..frame.clone() };
        format!("{hidden:?}<oculta, {} bytes>", frame.payload.len())
    } else {
        format!("{frame:?}")
    }
}

/// Canal DUML sobre `fff5` (escritura) y `fff4`/`fff5` (notificaciones).
struct Link {
    peripheral: Peripheral,
    write_char: Characteristic,
    rx: mpsc::UnboundedReceiver<Frame>,
    log: Log,
    last_write: Instant,
    approval: Option<bool>,
}

impl Link {
    async fn open(peripheral: Peripheral, log: Log) -> Result<Self, String> {
        log.line("Conectando por Bluetooth…");
        timeout(Duration::from_secs(20), peripheral.connect())
            .await
            .map_err(|_| "La cámara no respondió a la conexión en 20 s".to_string())?
            .map_err(|e| format!("No pude conectar: {e}"))?;
        peripheral.discover_services().await.map_err(|e| format!("No pude leer los servicios: {e}"))?;
        let chars = peripheral.characteristics();
        for c in &chars {
            log.line(format!("  característica {} props={:?}", c.uuid, c.properties));
        }
        let find = |uuid| chars.iter().find(|c| c.uuid == uuid).cloned();
        let fff4 = find(FFF4).ok_or("La cámara no tiene la característica fff4")?;
        let fff5 = find(FFF5).ok_or("La cámara no tiene la característica fff5")?;

        for c in [&fff4, &fff5] {
            match peripheral.subscribe(c).await {
                Ok(()) => log.line(format!("Suscrito a {}", c.uuid)),
                Err(e) => log.line(format!("No pude suscribirme a {}: {e}", c.uuid)),
            }
        }
        // Sin esto la cámara confirma las escrituras pero no contesta nada.
        peripheral
            .write(&fff4, &[0x01, 0x00], WriteType::WithResponse)
            .await
            .map_err(|e| format!("No pude preparar el canal (fff4 = 01 00): {e}"))?;
        sleep(Duration::from_millis(200)).await;

        let (tx, rx) = mpsc::unbounded_channel();
        let mut notes = peripheral.notifications().await.map_err(|e| e.to_string())?;
        let note_log = log.clone();
        tokio::spawn(async move {
            let mut by_char: std::collections::HashMap<Uuid, Reassembler> = Default::default();
            while let Some(note) = notes.next().await {
                let reassembler = by_char.entry(note.uuid).or_default();
                for result in reassembler.push(&note.value) {
                    match result {
                        Ok(frame) => {
                            note_log.line(format!("<- {}", shown(&frame)));
                            if tx.send(frame).is_err() {
                                return;
                            }
                        }
                        Err((e, raw)) => note_log.line(format!("<- trama inválida ({e}): {}", hex(&raw))),
                    }
                }
            }
        });

        Ok(Self { peripheral, write_char: fff5, rx, log, last_write: Instant::now(), approval: None })
    }

    async fn send(&mut self, frame: &Frame) -> Result<(), String> {
        let wait = WRITE_GAP.saturating_sub(self.last_write.elapsed());
        sleep(wait).await;
        self.log.line(format!("-> {frame:?}"));
        self.peripheral
            .write(&self.write_char, &frame.encode(), WriteType::WithoutResponse)
            .await
            .map_err(|e| format!("No pude escribir: {e}"))?;
        self.last_write = Instant::now();
        Ok(())
    }

    /// Espera una respuesta a `cmd_set/cmd_id`. Mientras tanto contesta la
    /// aprobación `07/46` si llega; las demás peticiones de la cámara se
    /// ignoran, igual que hace Mimo por Bluetooth.
    async fn wait_response(&mut self, cmd_set: u8, cmd_id: u8, limit: Duration) -> Result<Option<Frame>, String> {
        let deadline = Instant::now() + limit;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let frame = match timeout(left, self.rx.recv()).await {
                Err(_) => return Ok(None),
                Ok(None) => return Err("Se cortó la conexión Bluetooth".into()),
                Ok(Some(frame)) => frame,
            };
            if frame.is(0x07, 0x46) && frame.is_request() {
                self.answer_approval(&frame).await?;
                if (cmd_set, cmd_id) == (0x07, 0x46) {
                    return Ok(Some(frame));
                }
                continue;
            }
            if frame.is(cmd_set, cmd_id) && frame.is_response() {
                return Ok(Some(frame));
            }
        }
    }

    async fn answer_approval(&mut self, request: &Frame) -> Result<(), String> {
        let approved = request.payload.first() == Some(&0x01);
        self.log.line(if approved { "La cámara aprobó el emparejamiento" } else { "La cámara rechazó el emparejamiento o se agotó el tiempo" });
        self.approval = Some(approved);
        // osmosis contesta repitiendo el payload; otra documentación dice `00`.
        // Se usa lo que funciona en osmosis.
        let reply = request.reply(request.payload.clone());
        self.send(&reply).await
    }
}

/// Empareja (si hace falta), despierta la cámara y devuelve su Wi-Fi.
pub async fn fetch_credentials(
    log: &Log,
    camera: &FoundCamera,
    config: &WirelessConfig,
    wake: bool,
    on_needs_approval: impl Fn(),
) -> Result<Credentials, String> {
    let mut link = Link::open(camera.peripheral.clone(), log.clone()).await?;
    let result = run_session(&mut link, config, wake, on_needs_approval).await;
    log.line("Cerrando Bluetooth (como Mimo, una vez que tiene el Wi-Fi)");
    let _ = link.peripheral.disconnect().await;
    result
}

async fn run_session(
    link: &mut Link,
    config: &WirelessConfig,
    wake: bool,
    on_needs_approval: impl Fn(),
) -> Result<Credentials, String> {
    link.send(&Frame::request(addr::APP, addr::SESSION, 0x802B, 0x00, 0x2B, vec![0x04, 0x00])).await?;

    let mut pair_payload = duml::pack_string(&config.identifier);
    pair_payload.extend(duml::pack_string(&config.token));
    let pair = Frame::request(addr::APP, addr::WIFI, 0x8092, 0x07, 0x45, pair_payload);
    let mut status = None;
    for attempt in 1..=3 {
        link.send(&pair).await?;
        if let Some(reply) = link.wait_response(0x07, 0x45, Duration::from_millis(2500)).await? {
            status = reply.payload.get(1).copied();
            break;
        }
        link.log.line(format!("Sin respuesta al emparejamiento (intento {attempt} de 3)"));
    }
    let needed_approval = match status {
        Some(0x01) => {
            link.log.line("Ya estaba emparejada con esta app");
            false
        }
        Some(0x02) => {
            link.log.line("La cámara pide aprobar: acepta en su pantalla (tienes ~20 s)");
            on_needs_approval();
            if link.approval.is_none() {
                link.wait_response(0x07, 0x46, Duration::from_secs(35)).await?;
            }
            match link.approval {
                Some(true) => true,
                Some(false) => return Err("La cámara rechazó el emparejamiento o se agotó el tiempo".into()),
                None => return Err("No llegó la aprobación de la cámara en 35 s".into()),
            }
        }
        Some(other) => return Err(format!("Respuesta de emparejamiento inesperada: {other:02x}")),
        None => return Err("La cámara no respondió al emparejamiento".into()),
    };

    // Latido cada segundo mientras dure la sesión Bluetooth.
    let keepalive = {
        let peripheral = link.peripheral.clone();
        let characteristic = link.write_char.clone();
        let frame = Frame::request(addr::APP, addr::SESSION, 0x802B, 0x00, 0x2B, vec![0x01, 0x01]).encode();
        tokio::spawn(async move {
            loop {
                sleep(Duration::from_secs(1)).await;
                if peripheral.write(&characteristic, &frame, WriteType::WithoutResponse).await.is_err() {
                    break;
                }
            }
        })
    };

    let result = async {
        if wake {
            link.send(&Frame::request(addr::APP, addr::WAKE, 0x8053, 0x53, 0x10, vec![0; 4])).await?;
            match link.wait_response(0x53, 0x10, Duration::from_millis(1500)).await? {
                Some(reply) => link.log.line(format!("Despertar respondió {}", hex(&reply.payload))),
                None => link.log.line("Despertar no respondió (en algunos modelos es normal)"),
            }
        }
        sleep(Duration::from_millis(700)).await;
        let ssid = query_string(link, 0x07, 0x8007, "nombre de la red").await?;
        sleep(Duration::from_millis(400)).await;
        let password = match query_string(link, 0x0E, 0x800E, "contraseña").await {
            Ok(p) => p,
            Err(_) => {
                sleep(Duration::from_millis(800)).await;
                query_string(link, 0x0E, 0x800E, "contraseña (reintento)").await?
            }
        };
        link.send(&Frame::request(addr::APP, addr::WIFI, 0x800C, 0x07, 0x0C, vec![])).await?;
        let wifi_mac = link
            .wait_response(0x07, 0x0C, Duration::from_millis(1500))
            .await?
            .map(|f| hex(&f.payload));
        link.log.line(format!("Red: {ssid} · contraseña {} · MAC {}", redact(&password), wifi_mac.as_deref().unwrap_or("?")));
        Ok(Credentials { ssid, password, wifi_mac, needed_approval })
    }
    .await;
    keepalive.abort();
    result
}

async fn query_string(link: &mut Link, cmd_id: u8, seq: u16, what: &str) -> Result<String, String> {
    link.send(&Frame::request(addr::APP, addr::WIFI, seq, 0x07, cmd_id, vec![])).await?;
    let reply = link
        .wait_response(0x07, cmd_id, Duration::from_secs(3))
        .await?
        .ok_or_else(|| format!("La cámara no devolvió el {what}"))?;
    match duml::parse_status_string(&reply.payload) {
        Some((0, text)) if !text.is_empty() => Ok(text),
        Some((status, _)) => Err(format!("La cámara no entregó el {what} (estado {status:02x})")),
        None => Err(format!("Respuesta ilegible para el {what}: {}", hex(&reply.payload))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn parses_action_5_pro_advert() {
        // Modelo 0x0015, 0x40, dirección, estado 02 (despierta).
        let mut data = HashMap::new();
        data.insert(0x08AA, vec![0x15, 0x00, 0x40, 1, 2, 3, 4, 5, 6, 0x02]);
        let advert = parse_advert(&data).unwrap();
        assert_eq!(advert.model_id, Some(0x0015));
        assert_eq!(model_name(0x0015), "Osmo Action 5 Pro");
        assert_eq!(advert.awake, Some(true));
    }

    #[test]
    fn wifi_password_reply_is_hidden_in_the_log() {
        let request = Frame::request(duml::addr::APP, duml::addr::WIFI, 1, 0x07, 0x0E, Vec::new());
        let reply = request.reply(vec![0x00, 0x04, b'a', b'b', b'c', b'd']);
        let line = shown(&reply);
        assert!(!line.contains("61626364") && line.contains("<oculta, 6 bytes>"), "{line}");
    }

    #[test]
    fn model_from_advertised_name() {
        assert_eq!(model_from_name("OsmoAction5Pro675D"), Some("Osmo Action 5 Pro"));
        assert_eq!(model_from_name("OsmoAction-1234"), Some("Osmo Action"));
        assert_eq!(model_from_name("OsmoPocket4Pro-AB12"), Some("Osmo Pocket 4 Pro"));
        assert_eq!(model_from_name("iPhone"), None);
    }

    #[test]
    fn ignores_other_manufacturers_and_missing_fields() {
        let mut data = HashMap::new();
        data.insert(0x004C, vec![0x15, 0x00]); // Apple
        assert!(parse_advert(&data).is_none());
        data.insert(0xF7AA, vec![0x00, 0x00]);
        let advert = parse_advert(&data).unwrap();
        assert_eq!((advert.model_id, advert.awake), (None, None));
    }
}
