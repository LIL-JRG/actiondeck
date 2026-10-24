//! Enlace de datos por UDP con la cámara, ya en su red Wi-Fi: registrarse
//! como app, entrar en modo reproducción, pedir la lista de archivos y
//! mantener el enlace vivo mientras se descarga (si se queda callado, la
//! cámara apaga su red).
//!
//! Cada datagrama es `[8 B cabecera UDP][12 B enrutamiento][trama DUML]`. Los
//! detalles vienen de osmosis (DumlTransport/CameraSession) y de OsmoOffload
//! (`net/datalink.py`, `camera/session.py`, MIT), verificados con una Action 5
//! Pro por dji-vcam. Lo más delicado: nuestra secuencia avanza de 8 en 8 desde
//! el canal de la cámara + 8, y el "ack" del enrutamiento es nuestra secuencia
//! − 8, nunca la de la cámara; si no, la cámara ignora las escrituras.
//!
//! Es bloqueante: se usa desde un hilo, no desde tareas async.

use serde::Serialize;
use std::collections::HashSet;
use std::io::Write as _;
use std::net::{SocketAddr, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use super::duml::{self, addr, Frame};
use super::log::Log;
use super::manifest::{self, MediaRecord};

const PKT_HANDSHAKE: u8 = 0x00;
const PKT_TELEMETRY: u8 = 0x01;
const PKT_ACK: u8 = 0x04;
const PKT_COMMAND: u8 = 0x05;

/// Saludo de Mimo sin los 2 primeros bytes (la secuencia base): ventana 100,
/// MTU `0x05c0` (osmosis DumlSession.handshakeFrame).
const HANDSHAKE_TAIL: [u8; 38] = [
    0x64, 0x00, 0x64, 0x00, 0xc0, 0x05, 0x14, 0x00, 0x00, 0x64, 0x00, 0x00, 0x01, 0x90, 0x01, 0xc0, 0x05, 0x14, 0x00,
    0x00, 0x64, 0x00, 0x14, 0x00, 0x64, 0x00, 0xc0, 0x05, 0x14, 0x00, 0x00, 0x64, 0x00, 0x01, 0x01, 0x04, 0x01, 0x02,
];

/// Destinos `(id << 5) | tipo`.
const DM368_1: u8 = 0x28;
const DM368_2: u8 = 0x48;
const GIMBAL: u8 = 0x03;

/// "Presencia de la app": registro y latido (`00/88`), ~1 vez por segundo.
const APP_PRESENCE: [u8; 14] = [0x17, 0x00, 0x46, 0x23, 0x7c, 0x41, 0x50, 0x50, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02];
const PARAM_SUBS: [&str; 8] = [
    "camcap_mode_profile", "camcap_video_format", "camcap_fov", "camcap_iso",
    "camcap_photo_storage_format", "camcap_color_mode", "cam_storage", "cam_status",
];

/// Petición de lista (`00/26`): contador en el byte 4, cursor en 10-13, 45 por página.
const LIST_QUERY: [u8; 42] = [
    0x4a, 0x00, 0x2a, 0x10, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x2d, 0x00, 0x0d, 0x01, 0x00,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
];
const LIST_TRIGGER: [u8; 14] = [0x4a, 0x04, 0x0e, 0x10, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00];
pub const PAGE_SIZE: usize = 45;
/// Cursores de la página más reciente: microSD y memoria interna.
const NEWEST_SD: u32 = 0x0000_0001;
const NEWEST_INTERNAL: u32 = 0x4000_0001;

fn list_query(ctr: u8, cursor: u32) -> Vec<u8> {
    let mut p = LIST_QUERY.to_vec();
    p[4] = ctr;
    p[10..14].copy_from_slice(&cursor.to_le_bytes());
    p
}

fn udp_header(kind: u8, payload_len: usize, session: u16, seq: u16) -> [u8; 8] {
    let w0 = 0x8000 | ((8 + payload_len) as u16 & 0x3FFF);
    let mut h = [0u8; 8];
    h[0..2].copy_from_slice(&w0.to_le_bytes());
    h[2..4].copy_from_slice(&session.to_le_bytes());
    h[4..6].copy_from_slice(&seq.to_le_bytes());
    h[6] = kind;
    h[7] = h[..7].iter().fold(0, |x, b| x ^ b);
    h
}

fn routing_header(seq: u16, counter: u8) -> [u8; 12] {
    let ack = seq.wrapping_sub(8);
    let mut r = [0u8; 12];
    r[0..2].copy_from_slice(&ack.to_le_bytes());
    r[2..4].copy_from_slice(&seq.to_le_bytes());
    r[8] = counter;
    r[9] = 0x01;
    r
}

fn device_info() -> Vec<u8> {
    let mut b = vec![0u8; 62];
    b[1..4].copy_from_slice(b"APP");
    b[41] = 0x02;
    b[50] = 0x02;
    b[51] = 0x08;
    b
}

fn subscription(name: &str, id: u32) -> Vec<u8> {
    let mut p = vec![0x02, 0x02, 0x00, 0x00];
    p.extend(id.to_le_bytes());
    p.extend([0, 0, 0]);
    p.extend(((name.len() + 6) as u16).to_le_bytes());
    p.extend((name.len() as u16).to_le_bytes());
    p.extend(name.as_bytes());
    p.extend([0, 0, 0, 0]);
    p
}

fn random_u16() -> u16 {
    let b = uuid::Uuid::new_v4().into_bytes();
    u16::from_le_bytes([b[0], b[1]])
}

/// Batería y almacenamiento, de los mensajes que la cámara manda sola.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CameraStatus {
    pub battery_percent: Option<u8>,
    pub playback: Option<bool>,
    pub recording: Option<bool>,
    pub sd_total_mib: Option<u32>,
    pub sd_free_mib: Option<u32>,
    pub internal_total_mib: Option<u32>,
    pub internal_free_mib: Option<u32>,
}

impl CameraStatus {
    fn update(&mut self, frame: &Frame) {
        let p = &frame.payload;
        let u32_at = |at: usize| u32::from_le_bytes([p[at], p[at + 1], p[at + 2], p[at + 3]]);
        if frame.is(0x02, 0x80) && p.len() >= 13 {
            self.playback = Some(u32_at(0) & 0x4000_0000 != 0);
            self.recording = Some(p[0] & 0x80 != 0);
        } else if frame.is(0x02, 0xDC) && p.len() >= 22 {
            self.sd_total_mib = Some(u32_at(6));
            self.sd_free_mib = Some(u32_at(10));
            if p.len() >= 32 {
                self.internal_total_mib = Some(u32_at(24));
                self.internal_free_mib = Some(u32_at(28));
            }
        } else if frame.is(0x0D, 0x02) && p.len() >= 21 {
            self.battery_percent = Some(p[20]);
        }
    }
}

/// Mensajes que llegan sin parar; no se escriben en el registro.
fn noisy(frame: &Frame) -> bool {
    frame.is(0x02, 0x80) || frame.is(0x02, 0xDC) || frame.is(0x0D, 0x02) || frame.is(0x00, 0x27)
}

struct Transport {
    sock: UdpSocket,
    camera: SocketAddr,
    session: u16,
    base: u16,
    channel: u16,
    seq: u16,
    duml_seq: u16,
    counter: u8,
    peer_cursor: u16,
    status: CameraStatus,
    log: Log,
}

impl Transport {
    fn send(&self, packet: &[u8]) -> bool {
        self.sock.send_to(packet, self.camera).is_ok()
    }

    fn send_raw(&mut self, kind: u8, payload: &[u8]) {
        let mut packet = udp_header(kind, payload.len(), self.session, self.seq).to_vec();
        packet.extend_from_slice(payload);
        if self.send(&packet) {
            self.seq = self.seq.wrapping_add(8);
        }
    }

    /// Recibe durante `duration`. Actualiza el canal y el cursor de la cámara
    /// y el estado; devuelve las tramas DUML recibidas.
    fn recv_for(&mut self, duration: Duration) -> (Vec<Frame>, bool) {
        let deadline = Instant::now() + duration;
        let mut frames = Vec::new();
        let mut handshake = false;
        let mut buf = [0u8; 65536];
        while Instant::now() < deadline {
            let n = match self.sock.recv(&mut buf) {
                Ok(n) => n,
                Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => continue,
                Err(_) => break,
            };
            let d = &buf[..n];
            if n >= 8 && d[6] == PKT_HANDSHAKE {
                handshake = true;
            }
            if n >= 10 {
                let ch = u16::from_le_bytes([d[8], d[9]]);
                if ch != 0 {
                    self.channel = ch;
                }
            }
            if n == 34 && d[6] == PKT_TELEMETRY {
                self.peer_cursor = u16::from_le_bytes([d[10], d[11]]);
            }
            for frame in duml::scan(d) {
                self.status.update(&frame);
                if !noisy(&frame) {
                    self.log.line(format!("<- {frame:?}"));
                }
                frames.push(frame);
            }
        }
        (frames, handshake)
    }

    /// Confirma lo recibido; sin esto la cámara deja de mandar.
    fn send_ack(&self) {
        let group = |v: u16| {
            let [lo, hi] = v.to_le_bytes();
            [lo, hi, lo, hi, 0, 0, 0, 0]
        };
        let mut payload = Vec::with_capacity(26);
        payload.extend(group(self.peer_cursor));
        payload.extend(group(self.base));
        payload.extend(group(self.base));
        payload.extend([0, 0]);
        let mut packet = udp_header(PKT_ACK, payload.len(), self.session, 0).to_vec();
        packet.extend(payload);
        self.send(&packet);
    }

    /// `kind` 2 = petición (flags 0x40), 4 = escritura (flags 0x80).
    fn send_duml(&mut self, cmd_set: u8, cmd_id: u8, payload: Vec<u8>, receiver: u8, kind: u8) {
        self.counter = self.counter.wrapping_add(1);
        let frame = Frame {
            sender: addr::APP,
            receiver,
            seq: self.duml_seq,
            flags: kind << 5,
            cmd_set,
            cmd_id,
            payload,
        };
        self.duml_seq = self.duml_seq.wrapping_add(1);
        if !(cmd_set == 0x00 && cmd_id == 0x88) {
            self.log.line(format!("-> {frame:?}"));
        }
        let routing = routing_header(self.seq, self.counter);
        let encoded = frame.encode();
        let mut packet = udp_header(PKT_COMMAND, routing.len() + encoded.len(), self.session, self.seq).to_vec();
        packet.extend(routing);
        packet.extend(encoded);
        if self.send(&packet) {
            self.seq = self.seq.wrapping_add(8);
        }
    }

    fn presence(&mut self) {
        self.send_duml(0x00, 0x88, APP_PRESENCE.to_vec(), DM368_1, 2);
    }

    /// Recibe y confirma en tandas, como hace Mimo.
    fn drain(&mut self, duration: Duration) -> Vec<Frame> {
        let (frames, _) = self.recv_for(duration);
        self.send_ack();
        frames
    }
}

pub struct Datalink {
    transport: Arc<Mutex<Transport>>,
    beat: Option<(Arc<AtomicBool>, JoinHandle<()>)>,
    pub port: u16,
}

impl Datalink {
    /// Abre el enlace: "poke" TCP 7001 (opcional) con nuestra identidad de
    /// emparejamiento, saludo UDP y sincronización de la secuencia.
    pub fn open(log: &Log, ip: &str, port: u16, poke: Option<(&str, &str)>) -> Result<Self, String> {
        let camera: SocketAddr = format!("{ip}:{port}").parse().map_err(|e| format!("Dirección inválida: {e}"))?;
        if let Some((identifier, token)) = poke {
            match tcp_poke(ip, identifier, token) {
                Ok(()) => log.line("Poke TCP 7001 enviado"),
                Err(e) => log.line(format!("Poke TCP 7001 falló ({e}); sigo")),
            }
        }
        // Mismo puerto en los dos lados, como las apps de DJI.
        let sock = UdpSocket::bind(("0.0.0.0", port))
            .or_else(|_| UdpSocket::bind(("0.0.0.0", 0)))
            .map_err(|e| format!("No pude abrir UDP: {e}"))?;
        sock.set_read_timeout(Some(Duration::from_millis(200))).map_err(|e| e.to_string())?;

        let base = (random_u16() % 0xE000 + 0x1000) & 0xFFF8;
        let mut t = Transport {
            sock,
            camera,
            session: random_u16() % 0xEFFE + 0x1000,
            base,
            channel: base,
            seq: 0,
            duml_seq: 0xA000,
            counter: 0,
            peer_cursor: 0,
            status: CameraStatus::default(),
            log: log.clone(),
        };
        log.line(format!("Saludo UDP a {camera} (sesión {:04x}, base {base:04x})", t.session));
        let mut payload = base.to_le_bytes().to_vec();
        payload.extend(HANDSHAKE_TAIL);
        let mut answered = false;
        for _ in 0..20 {
            t.send_raw(PKT_HANDSHAKE, &payload);
            if t.recv_for(Duration::from_millis(350)).1 {
                answered = true;
                break;
            }
        }
        if !answered {
            return Err(format!("La cámara no contestó el saludo en UDP {port}"));
        }
        for _ in 0..5 {
            t.drain(Duration::from_millis(400));
        }
        t.seq = t.channel.wrapping_add(8);
        log.line(format!("Enlace abierto en UDP {port}; canal {:04x}", t.channel));
        Ok(Self { transport: Arc::new(Mutex::new(t)), beat: None, port })
    }

    fn with<T>(&self, f: impl FnOnce(&mut Transport) -> T) -> T {
        f(&mut self.transport.lock().unwrap())
    }

    pub fn status(&self) -> CameraStatus {
        self.with(|t| t.status.clone())
    }

    /// Se presenta como app (información, presencia, cardán y suscripciones).
    pub fn register(&self) {
        self.with(|t| {
            t.send_duml(0x00, 0x81, device_info(), DM368_2, 4);
            t.drain(Duration::from_millis(200));
            t.presence();
            t.drain(Duration::from_millis(200));
            t.send_duml(0x03, 0xDA, vec![0x05, 0xFF, 0xFF, 0xFF, 0xFF], GIMBAL, 2);
            t.drain(Duration::from_millis(200));
            for (i, name) in PARAM_SUBS.iter().enumerate() {
                t.send_duml(0x00, 0x99, subscription(name, i as u32 + 1), DM368_1, 2);
                t.drain(Duration::from_millis(80));
            }
        });
    }

    /// Modo reproducción: sin él la cámara solo da la página más reciente.
    /// Se confirma con el bit 30 de `02/80`.
    pub fn enter_playback(&self, log: &Log) -> bool {
        let entered = self.with(|t| {
            for attempt in 1..=3 {
                t.send_duml(0x02, 0x0C, vec![0x01, 0x01, 0x00, 0x01], addr::CAMERA, 2);
                let deadline = Instant::now() + Duration::from_millis(900);
                while Instant::now() < deadline {
                    t.drain(Duration::from_millis(150));
                    if t.status.playback == Some(true) {
                        log.line(format!("Modo reproducción activo (intento {attempt})"));
                        return true;
                    }
                }
            }
            false
        });
        if entered {
            // El almacenamiento tarda ~1.7 s en estar listo tras entrar.
            self.with(|t| {
                for _ in 0..6 {
                    t.presence();
                    t.drain(Duration::from_millis(300));
                }
            });
        } else {
            log.line("La cámara no confirmó el modo reproducción; pido la lista de todos modos");
        }
        entered
    }

    /// Tres peticiones: la más reciente de la microSD (contador 1), el
    /// disparador y la página de `cursor` (contador 2). Devuelve lo que
    /// contestó a cada contador; `None` si no contestó nada.
    fn query(&self, log: &Log, cursor: u32) -> Option<(Vec<MediaRecord>, Vec<MediaRecord>, bool)> {
        self.with(|t| {
            let mut frames = Vec::new();
            t.send_duml(0x00, 0x26, list_query(1, NEWEST_SD), addr::CAMERA, 2);
            let mut last_count = None;
            let mut stable = 0;
            for batch in 0..15 {
                frames.extend(t.drain(Duration::from_millis(800)).into_iter().filter(|f| f.is(0x00, 0x27)));
                t.presence();
                match batch {
                    1 => t.send_duml(0x00, 0x26, LIST_TRIGGER.to_vec(), addr::CAMERA, 2),
                    2 => t.send_duml(0x00, 0x26, list_query(2, cursor), addr::CAMERA, 2),
                    _ => {}
                }
                if batch == 4 && !manifest::answered(&frames) {
                    log.line("La cámara no contestó la lista");
                    return None;
                }
                if batch >= 3 && manifest::ended(&frames, 1) && manifest::ended(&frames, 2) {
                    break;
                }
                let count = manifest::decode(&manifest::reassemble(&frames, None)).len();
                if batch >= 4 && count > 0 && Some(count) == last_count {
                    stable += 1;
                    if stable >= 2 {
                        break;
                    }
                } else {
                    stable = 0;
                }
                last_count = Some(count);
            }
            let split = manifest::echoes(&frames, 1) || manifest::echoes(&frames, 2);
            let first = manifest::decode(&manifest::reassemble(&frames, Some(1)));
            let second = manifest::decode(&manifest::reassemble(&frames, Some(2)));
            if split {
                Some((first, second, true))
            } else {
                Some((Vec::new(), manifest::decode(&manifest::reassemble(&frames, None)), false))
            }
        })
    }

    /// Todos los archivos, más recientes primero, de la microSD y de la
    /// memoria interna, página por página.
    pub fn list_all(&self, log: &Log) -> Result<Vec<MediaRecord>, String> {
        let (sd, internal, split) = self.query(log, NEWEST_INTERNAL).ok_or("La cámara no contestó la lista de archivos")?;
        let mut seen = HashSet::new();
        let mut all = Vec::new();
        let mut add = |page: Vec<MediaRecord>, storage: Option<u8>| -> Vec<MediaRecord> {
            let mut fresh = Vec::new();
            for mut r in page {
                if let Some(s) = storage {
                    r.storage = s;
                }
                if seen.insert((r.storage, r.path.clone())) {
                    all.push(r.clone());
                    fresh.push(r);
                }
            }
            fresh
        };
        log.line(format!("Página más reciente: {} en microSD, {} en memoria interna", sd.len(), internal.len()));
        let first_pages = if split {
            vec![(add(sd, Some(0)), 0), (add(internal, Some(1)), 1)]
        } else {
            vec![(add(internal, None), 2)]
        };

        // Página siguiente: cursor = el handle más viejo de la página anterior.
        for (mut page, storage) in first_pages {
            let mut pages = 1;
            while page.len() >= PAGE_SIZE - 1 && pages < 200 {
                let Some(cursor) = page.iter().map(|r| r.handle).filter(|&h| h != 0).min() else { break };
                let Some((_, older, _)) = self.query(log, cursor) else { break };
                page = add(older, (storage < 2).then_some(storage));
                pages += 1;
                log.line(format!("Página {pages}: {} archivos nuevos", page.len()));
            }
        }
        Ok(all)
    }

    /// Mantiene el enlace (y la red de la cámara) vivo: presencia y
    /// confirmación cada segundo, hasta `close`.
    pub fn start_keepalive(&mut self) {
        if self.beat.is_some() {
            return;
        }
        let stop = Arc::new(AtomicBool::new(false));
        let transport = self.transport.clone();
        let flag = stop.clone();
        let handle = std::thread::spawn(move || {
            while !flag.load(Ordering::Relaxed) {
                {
                    let mut t = transport.lock().unwrap();
                    t.presence();
                    t.drain(Duration::from_millis(150));
                }
                std::thread::sleep(Duration::from_millis(850));
            }
        });
        self.beat = Some((stop, handle));
    }

    pub fn close(mut self) {
        if let Some((stop, handle)) = self.beat.take() {
            stop.store(true, Ordering::Relaxed);
            let _ = handle.join();
        }
        self.with(|t| {
            t.send_duml(0x02, 0x0C, vec![0x01, 0x01, 0x00, 0x00], addr::CAMERA, 2);
            t.recv_for(Duration::from_millis(100));
        });
    }
}

fn tcp_poke(ip: &str, identifier: &str, token: &str) -> Result<(), String> {
    let addr: SocketAddr = format!("{ip}:7001").parse().map_err(|e| format!("{e}"))?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(1200)).map_err(|e| e.to_string())?;
    let mut payload = duml::pack_string(identifier);
    payload.extend(duml::pack_string(token));
    let frame = Frame::request(addr::APP, addr::WIFI, 0x8092, 0x07, 0x45, payload);
    stream.write_all(&frame.encode()).map_err(|e| e.to_string())?;
    std::thread::sleep(Duration::from_millis(400));
    Ok(())
}

/// Puertos a probar: la Action 5 Pro original usa 9004 con poke; la Xtra
/// Edge Pro (la misma cámara con otra marca) usa 10004 sin poke.
pub const PORTS: [(u16, bool); 2] = [(9004, true), (10004, false)];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handshake_matches_the_reference_frame() {
        // Saludo de osmosis/dji-vcam con base 0: 40 bytes en total.
        let mut payload = 0u16.to_le_bytes().to_vec();
        payload.extend(HANDSHAKE_TAIL);
        assert_eq!(duml::hex(&payload), "000064006400c005140000640000019001c005140000640014006400c00514000064000101040102");
    }

    #[test]
    fn udp_header_checksum_and_routing_ack() {
        let h = udp_header(PKT_COMMAND, 20, 0x1234, 0xB890);
        assert_eq!(h[..7], [0x1c, 0x80, 0x34, 0x12, 0x90, 0xb8, 0x05]);
        assert_eq!(h[7], h[..7].iter().fold(0, |x, b| x ^ b));
        let r = routing_header(0xB890, 3);
        assert_eq!(r, [0x88, 0xb8, 0x90, 0xb8, 0, 0, 0, 0, 3, 1, 0, 0]);
    }

    #[test]
    fn list_query_carries_counter_and_cursor() {
        let q = list_query(2, 0x4004_0010);
        assert_eq!(q.len(), 42);
        assert_eq!((q[4], &q[10..14], q[14]), (2, &[0x10, 0x00, 0x04, 0x40][..], 0x2d));
    }

    #[test]
    fn status_reads_storage_and_battery_seen_on_the_camera() {
        // Tramas reales de la Osmo Action 5 Pro (2026-10-24).
        let mut status = CameraStatus::default();
        let frame = |set, id, hex: &str| Frame {
            sender: 1, receiver: 2, seq: 0, flags: 0, cmd_set: set, cmd_id: id,
            payload: (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect(),
        };
        status.update(&frame(0x02, 0x80, "0102800001f3b803008461020000000000023400000000000000000000000000005f0000010000000000000000000000000000000000000000010000"));
        status.update(&frame(0x02, 0xDC, "001202000001f3b80300846102000000000002340000010154bf00001a9b0000000000003c0d0000"));
        status.update(&frame(0x0D, 0x02, "00ce1000009bfeffff00000000000000007201005e00000000000020000000000001"));
        assert_eq!(status.playback, Some(false));
        assert_eq!((status.sd_total_mib, status.sd_free_mib), (Some(0x0003_b8f3), Some(0x0002_6184)));
        assert_eq!(status.battery_percent, Some(94));
    }
}
