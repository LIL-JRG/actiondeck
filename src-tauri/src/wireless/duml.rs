//! Tramas DUML, el protocolo de mensajes de DJI. Es el mismo por Bluetooth
//! (característica `fff5`), por el "poke" TCP 7001 y dentro del enlace UDP.
//!
//! ```text
//! 0      1-2           3      4       5         6-7   8      9        10      11..n    n+1..n+2
//! 0x55   len|ver<<10   crc8   emisor  receptor  seq   flags  cmd_set  cmd_id  payload  crc16
//! ```
//!
//! Reimplementado a partir de la documentación pública de osmosis
//! (KonradIT/osmosis, MIT) y osmo-client (luisreysan/osmo-client, MIT).

use std::fmt;

pub const SOF: u8 = 0x55;
const HEADER_LEN: usize = 11;
const MIN_LEN: usize = HEADER_LEN + 2;

/// Direcciones `(id << 5) | tipo`.
pub mod addr {
    pub const CAMERA: u8 = 0x01;
    pub const APP: u8 = 0x02;
    pub const WIFI: u8 = 0x07;
    /// Destino de la apertura de sesión y del latido por Bluetooth.
    pub const SESSION: u8 = 0xF0;
    /// Destino del comando que despierta la cámara.
    pub const WAKE: u8 = 0x1C;
}

pub mod flags {
    pub const REQUEST: u8 = 0x40;
    pub const RESPONSE: u8 = 0xC0;
}

/// CRC-8 reflejado: polinomio 0x8C, valor inicial 0x77 (bytes 0-2).
pub fn crc8(data: &[u8]) -> u8 {
    let mut crc: u8 = 0x77;
    for &b in data {
        crc ^= b;
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0x8C } else { crc >> 1 };
        }
    }
    crc
}

/// CRC-16 reflejado: polinomio 0x8408, valor inicial 0x3692 (toda la trama
/// menos los dos últimos bytes).
pub fn crc16(data: &[u8]) -> u16 {
    let mut crc: u16 = 0x3692;
    for &b in data {
        crc ^= u16::from(b);
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0x8408 } else { crc >> 1 };
        }
    }
    crc
}

#[derive(Clone, PartialEq, Eq)]
pub struct Frame {
    pub sender: u8,
    pub receiver: u8,
    /// Número de secuencia tal como viaja (little-endian). La respuesta lo repite.
    pub seq: u16,
    pub flags: u8,
    pub cmd_set: u8,
    pub cmd_id: u8,
    pub payload: Vec<u8>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum DecodeError {
    TooShort,
    BadStart,
    BadLength { declared: usize, actual: usize },
    BadHeaderCrc,
    BadCrc,
}

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooShort => write!(f, "trama demasiado corta"),
            Self::BadStart => write!(f, "la trama no empieza con 0x55"),
            Self::BadLength { declared, actual } => write!(f, "longitud declarada {declared}, recibida {actual}"),
            Self::BadHeaderCrc => write!(f, "CRC-8 de la cabecera incorrecto"),
            Self::BadCrc => write!(f, "CRC-16 incorrecto"),
        }
    }
}

impl Frame {
    pub fn request(sender: u8, receiver: u8, seq: u16, cmd_set: u8, cmd_id: u8, payload: Vec<u8>) -> Self {
        Self { sender, receiver, seq, flags: flags::REQUEST, cmd_set, cmd_id, payload }
    }

    /// Respuesta a esta petición: emisor y receptor invertidos, misma secuencia.
    pub fn reply(&self, payload: Vec<u8>) -> Self {
        Self {
            sender: self.receiver,
            receiver: self.sender,
            seq: self.seq,
            flags: flags::RESPONSE,
            cmd_set: self.cmd_set,
            cmd_id: self.cmd_id,
            payload,
        }
    }

    pub fn is_request(&self) -> bool {
        self.flags & 0x80 == 0 && self.flags & 0x40 != 0
    }

    pub fn is_response(&self) -> bool {
        self.flags & 0x80 != 0
    }

    pub fn is(&self, cmd_set: u8, cmd_id: u8) -> bool {
        self.cmd_set == cmd_set && self.cmd_id == cmd_id
    }

    pub fn encode(&self) -> Vec<u8> {
        let len = MIN_LEN + self.payload.len();
        assert!(len < 1024, "una trama DUML no puede pasar de 1023 bytes");
        let len_field = (len as u16) | (1 << 10);
        let mut out = Vec::with_capacity(len);
        out.push(SOF);
        out.extend_from_slice(&len_field.to_le_bytes());
        out.push(crc8(&out));
        out.push(self.sender);
        out.push(self.receiver);
        out.extend_from_slice(&self.seq.to_le_bytes());
        out.push(self.flags);
        out.push(self.cmd_set);
        out.push(self.cmd_id);
        out.extend_from_slice(&self.payload);
        let crc = crc16(&out);
        out.extend_from_slice(&crc.to_le_bytes());
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, DecodeError> {
        if bytes.len() < MIN_LEN {
            return Err(DecodeError::TooShort);
        }
        if bytes[0] != SOF {
            return Err(DecodeError::BadStart);
        }
        let declared = declared_len(bytes);
        if declared != bytes.len() {
            return Err(DecodeError::BadLength { declared, actual: bytes.len() });
        }
        if crc8(&bytes[..3]) != bytes[3] {
            return Err(DecodeError::BadHeaderCrc);
        }
        let body = &bytes[..bytes.len() - 2];
        let crc = u16::from_le_bytes([bytes[bytes.len() - 2], bytes[bytes.len() - 1]]);
        if crc16(body) != crc {
            return Err(DecodeError::BadCrc);
        }
        Ok(Self {
            sender: bytes[4],
            receiver: bytes[5],
            seq: u16::from_le_bytes([bytes[6], bytes[7]]),
            flags: bytes[8],
            cmd_set: bytes[9],
            cmd_id: bytes[10],
            payload: bytes[HEADER_LEN..bytes.len() - 2].to_vec(),
        })
    }
}

fn declared_len(bytes: &[u8]) -> usize {
    (u16::from_le_bytes([bytes[1], bytes[2]]) & 0x03FF) as usize
}

impl fmt::Debug for Frame {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{:02x}/{:02x} {:02x}->{:02x} seq={:04x} flags={:02x} payload={}",
            self.cmd_set,
            self.cmd_id,
            self.sender,
            self.receiver,
            self.seq,
            self.flags,
            hex(&self.payload)
        )
    }
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Junta bytes que llegan en pedazos (notificaciones BLE, datagramas) y
/// devuelve las tramas completas. Descarta basura hasta el siguiente 0x55.
#[derive(Default)]
pub struct Reassembler {
    buf: Vec<u8>,
}

impl Reassembler {
    pub fn push(&mut self, data: &[u8]) -> Vec<Result<Frame, (DecodeError, Vec<u8>)>> {
        self.buf.extend_from_slice(data);
        let mut out = Vec::new();
        loop {
            match self.buf.iter().position(|&b| b == SOF) {
                Some(0) => {}
                Some(start) => {
                    self.buf.drain(..start);
                }
                None => {
                    self.buf.clear();
                    break;
                }
            }
            if self.buf.len() < 4 {
                break;
            }
            // Si la cabecera no cuadra, este 0x55 no inicia una trama.
            if crc8(&self.buf[..3]) != self.buf[3] || declared_len(&self.buf) < MIN_LEN {
                self.buf.drain(..1);
                continue;
            }
            let len = declared_len(&self.buf);
            if self.buf.len() < len {
                break;
            }
            let raw: Vec<u8> = self.buf.drain(..len).collect();
            out.push(Frame::decode(&raw).map_err(|e| (e, raw)));
        }
        out
    }
}

/// Campo de texto DJI: `[len u8][utf8]`.
pub fn pack_string(value: &str) -> Vec<u8> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() + 1);
    out.push(bytes.len().min(255) as u8);
    out.extend_from_slice(&bytes[..bytes.len().min(255)]);
    out
}

/// Respuesta de las consultas de Wi-Fi (`07/07`, `07/0E`): `[estado][len][texto]`.
pub fn parse_status_string(payload: &[u8]) -> Option<(u8, String)> {
    let (&status, rest) = payload.split_first()?;
    let (&len, text) = rest.split_first()?;
    let text = text.get(..usize::from(len))?;
    Some((status, String::from_utf8_lossy(text).into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    /// Tramas que DJI Mimo envió a una cámara real, publicadas en
    /// osmosis/MEDIA_PROTOCOL.md y dji-vcam/docs/protocol-notes.md.
    #[test]
    fn encodes_frames_captured_from_mimo() {
        let cases = [
            (Frame::request(addr::APP, addr::SESSION, 0xCB1B, 0x00, 0x2B, vec![0x04, 0x00]), "550f04a202f01bcb40002b04009ab9"),
            (Frame::request(addr::APP, addr::SESSION, 0xCB1B, 0x00, 0x2B, vec![0x01, 0x01]), "550f04a202f01bcb40002b0101abd6"),
            (Frame::request(addr::APP, addr::WAKE, 0xCB1D, 0x53, 0x10, vec![0; 4]), "55110492021c1dcb40531000000000894a"),
            (Frame::request(addr::APP, addr::WIFI, 0xA000, 0x07, 0x07, vec![]), "550d0433020700a04007077472"),
            (Frame::request(addr::APP, addr::WIFI, 0xA000, 0x07, 0x0E, vec![]), "550d0433020700a040070eb5ef"),
        ];
        for (frame, wire) in cases {
            assert_eq!(hex(&frame.encode()), wire, "{frame:?}");
            assert_eq!(Frame::decode(&unhex(wire)).unwrap(), frame);
        }
    }

    #[test]
    fn encodes_the_published_pairing_frame() {
        let mut payload = pack_string("284ae5b8d76b3375a04a6417ad71bea3");
        payload.extend(pack_string("osmo"));
        let frame = Frame::request(addr::APP, addr::WIFI, 0xA000, 0x07, 0x45, payload);
        assert_eq!(
            hex(&frame.encode()),
            "553304c2020700a0400745203238346165356238643736623333373561303461363431376164373162656133046f736d6f8c02"
        );
    }

    #[test]
    fn reply_swaps_addresses_and_keeps_seq() {
        let approval = Frame { flags: flags::REQUEST, ..Frame::request(addr::WIFI, addr::APP, 0x1234, 0x07, 0x46, vec![1]) };
        let ack = approval.reply(vec![1]);
        assert_eq!((ack.sender, ack.receiver, ack.seq, ack.flags), (addr::APP, addr::WIFI, 0x1234, flags::RESPONSE));
        assert!(approval.is_request() && ack.is_response());
    }

    #[test]
    fn decode_rejects_corruption() {
        let mut wire = unhex("550d0433020700a04007077472");
        assert_eq!(Frame::decode(&wire[..5]), Err(DecodeError::TooShort));
        wire[12] ^= 1;
        assert_eq!(Frame::decode(&wire), Err(DecodeError::BadCrc));
        wire[3] ^= 1;
        assert_eq!(Frame::decode(&wire), Err(DecodeError::BadHeaderCrc));
    }

    #[test]
    fn reassembles_split_and_glued_frames() {
        let a = Frame::request(addr::APP, addr::WIFI, 1, 0x07, 0x07, vec![]).encode();
        let b = Frame::request(addr::WIFI, addr::APP, 2, 0x07, 0x0E, vec![0, 3, b'a', b'b', b'c']).encode();
        let mut stream = vec![0x00, 0x55, 0x13]; // basura, incluido un 0x55 falso
        stream.extend(&a);
        stream.extend(&b);
        let mut r = Reassembler::default();
        let mut frames = Vec::new();
        for chunk in stream.chunks(5) {
            frames.extend(r.push(chunk).into_iter().map(Result::unwrap));
        }
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[1].seq, 2);
        assert_eq!(parse_status_string(&frames[1].payload), Some((0, "abc".into())));
    }

    #[test]
    fn parses_wifi_strings() {
        let mut ssid = vec![0x00];
        ssid.extend(pack_string("OsmoAction5Pro-2DCA"));
        assert_eq!(parse_status_string(&ssid), Some((0, "OsmoAction5Pro-2DCA".into())));
        assert_eq!(parse_status_string(&[0x00, 0x05, b'a']), None);
        assert_eq!(parse_status_string(&[]), None);
    }
}
