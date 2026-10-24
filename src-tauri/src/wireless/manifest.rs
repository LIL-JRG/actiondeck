//! Lista de archivos de la cámara. La petición `00/26` se contesta con tramas
//! `00/27` en pedazos; se juntan y se decodifican (formato "CompositePack").
//!
//! Formato de osmosis MEDIA_PROTOCOL.md §1 y algoritmo de OsmoOffload
//! (`camera/manifest.py`, MIT). Cada pedazo es `[4a sub ? ? ctr ? seq seq ? ?][datos]`
//! con `sub` = `04` inicio, `01` datos, `03` fin, y `ctr` el contador de la
//! petición. Cada registro se ancla en su ruta `DCIM/…`:
//!
//! ```text
//! 1a <total> 00 00 00 01 <ascii>   ruta sin extensión (DCIM/DJI_001/DJI_…)
//! 1a <total> 00 00 00 02 <ascii>   miniatura (MISC/THM/…)
//! 0d <len> <ascii>                 nombre con extensión
//! … [ff|fe] 19 06                  marca T: fecha T-18, tamaño T-14, handle T-10,
//!                                  duración T-6, tipo T-2 (03 = video)
//! ```

use serde::Serialize;

use super::duml::Frame;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaRecord {
    /// Ruta sin extensión, p. ej. `DCIM/DJI_001/DJI_20261024081500_0001_D`.
    pub path: String,
    /// Nombre con extensión, p. ej. `DJI_20261024081500_0001_D.MP4`.
    pub name: String,
    /// Identificador del archivo en la cámara; también sirve para paginar.
    pub handle: u32,
    /// Bytes; vale 0 en archivos de más de 4 GB (hay que pedirlo con HEAD).
    pub size: u64,
    /// Segundos, solo en videos.
    pub duration: Option<u32>,
    /// Fecha de grabación según el reloj de la cámara, `AAAA-MM-DDTHH:MM:SS`.
    pub recorded: Option<String>,
    /// `0` microSD, `1` memoria interna: el `storage=` de la descarga.
    pub storage: u8,
}

impl MediaRecord {
    /// Ruta con extensión, la que pide la descarga.
    pub fn file_path(&self) -> String {
        match self.path.rsplit_once('/') {
            Some((dir, _)) => format!("{dir}/{}", self.name),
            None => self.name.clone(),
        }
    }

    pub fn is_video(&self) -> bool {
        let upper = self.name.to_ascii_uppercase();
        upper.ends_with(".MP4") || upper.ends_with(".MOV")
    }
}

fn list_chunks(frames: &[Frame]) -> impl Iterator<Item = &[u8]> {
    frames.iter().filter(|f| f.is(0x00, 0x27) && f.payload.len() >= 5 && f.payload[0] == 0x4A).map(|f| f.payload.as_slice())
}

/// ¿La cámara contestó algo a la lista? Distingue "vacía" de "sin respuesta".
pub fn answered(frames: &[Frame]) -> bool {
    list_chunks(frames).next().is_some()
}

/// ¿Llegó el final de la respuesta a la petición `ctr`?
pub fn ended(frames: &[Frame], ctr: u8) -> bool {
    list_chunks(frames).any(|p| p[1] == 0x03 && p[4] == ctr)
}

/// ¿Alguna respuesta trae `ctr` en su sub-cabecera?
pub fn echoes(frames: &[Frame], ctr: u8) -> bool {
    list_chunks(frames).any(|p| p[4] == ctr)
}

/// Junta los datos de las respuestas, en orden de llegada. Con `ctr`, solo
/// los de esa petición.
pub fn reassemble(frames: &[Frame], ctr: Option<u8>) -> Vec<u8> {
    let mut out = Vec::new();
    for p in list_chunks(frames) {
        if p.len() > 10 && p[1] == 0x01 && ctr.is_none_or(|c| p[4] == c) {
            out.extend_from_slice(&p[10..]);
        }
    }
    out
}

fn read_path<'a>(buf: &'a [u8], i: usize, sub: u8, prefix: &[u8]) -> Option<(&'a [u8], usize)> {
    if buf.get(i) != Some(&0x1A) || buf.get(i + 2..i + 5)? != [0, 0, 0] || buf.get(i + 5) != Some(&sub) {
        return None;
    }
    let len = usize::from(buf[i + 1]).checked_sub(6)?;
    let value = buf.get(i + 6..i + 6 + len)?;
    value.starts_with(prefix).then_some((value, i + 6 + len))
}

fn u32_at(buf: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(buf.get(at..at + 4)?.try_into().ok()?))
}

/// Fecha FAT/DOS: día en la palabra alta, hora en la baja, segundos de 2 en 2.
fn fat_datetime(v: u32) -> Option<String> {
    let (date, time) = (v >> 16, v & 0xFFFF);
    let (year, month, day) = (1980 + (date >> 9), (date >> 5) & 0x0F, date & 0x1F);
    let (hour, minute, second) = (time >> 11, (time >> 5) & 0x3F, (time & 0x1F) * 2);
    let valid = (1..=12).contains(&month) && (1..=31).contains(&day) && hour < 24 && minute < 60 && second < 60;
    valid.then(|| format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}"))
}

/// Decodifica la lista ya reunida. Cada campo se busca solo entre el registro
/// anterior y el siguiente, porque el orden de campos cambia de modelo a modelo.
pub fn decode(buf: &[u8]) -> Vec<MediaRecord> {
    let mut medias = Vec::new(); // (inicio, fin, ruta)
    let mut i = 0;
    while i < buf.len() {
        match read_path(buf, i, 1, b"DCIM/") {
            Some((value, end)) => {
                medias.push((i, end, String::from_utf8_lossy(value).into_owned()));
                i = end;
            }
            None => i += 1,
        }
    }

    let mut files = Vec::new();
    for (k, (pos, _, path)) in medias.iter().enumerate() {
        let lo = if k > 0 { medias[k - 1].1 } else { 0 };
        let hi = medias.get(k + 1).map(|m| m.0).unwrap_or(buf.len());
        let base = path.rsplit('/').next().unwrap_or(path);

        // Extensión, del campo `0d` con el nombre completo.
        let needle = format!("{base}.");
        let ext = (lo..hi.saturating_sub(2)).find_map(|j| {
            let len = usize::from(buf[j + 1]);
            if buf[j] != 0x0D || !buf[j + 2..].starts_with(needle.as_bytes()) {
                return None;
            }
            let field = buf.get(j + 2 + needle.len()..j + 2 + len)?;
            Some(String::from_utf8_lossy(field).to_ascii_uppercase())
        });

        // La marca `[fe|ff] 19 06` antes de la ruta; los demás campos cuelgan de ella.
        let marker = (lo.max(1)..pos.saturating_sub(1)).find(|&p| buf[p] == 0x19 && buf[p + 1] == 0x06 && matches!(buf[p - 1], 0xFE | 0xFF));
        let (mut handle, mut size, mut duration, mut recorded) = (0, 0, None, None);
        if let Some(t) = marker.filter(|&t| t >= 18) {
            handle = u32_at(buf, t - 10).unwrap_or(0);
            size = u32_at(buf, t - 14).unwrap_or(0);
            recorded = u32_at(buf, t - 18).and_then(fat_datetime);
            if buf[t - 2] == 0x03 {
                duration = Some(u32::from(u16::from_le_bytes([buf[t - 6], buf[t - 5]])));
            }
        }

        files.push(MediaRecord {
            path: path.clone(),
            name: ext.map(|e| format!("{base}.{e}")).unwrap_or_else(|| base.to_string()),
            handle,
            size: u64::from(size),
            duration,
            recorded,
            storage: u8::from(handle & 0x4000_0000 != 0),
        });
    }
    files
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::wireless::duml::addr;

    fn tlv(sub: u8, text: &str) -> Vec<u8> {
        let mut out = vec![0x1A, (text.len() + 6) as u8, 0, 0, 0, sub];
        out.extend(text.as_bytes());
        out
    }

    /// Un registro en el orden de la Action 5 Pro: cabecera con la marca,
    /// ruta, miniatura, bloque de valores y nombre.
    pub fn record(base: &str, ext: &str, handle: u32, size: u32, seconds: u16) -> Vec<u8> {
        // 2026-10-24 08:15:30 en formato FAT.
        let fat: u32 = ((2026 - 1980) << 25) | (10 << 21) | (24 << 16) | (8 << 11) | (15 << 5) | 15;
        let kind = if ext == "MP4" { 0x03 } else { 0x00 };
        let mut r = vec![0x0b, 0x00, 0x77];
        r.extend(fat.to_le_bytes());
        r.extend(size.to_le_bytes());
        r.extend(handle.to_le_bytes());
        r.extend(seconds.to_le_bytes());
        r.extend([0x0a, 0x11, kind, 0xFF, 0x19, 0x06, 0, 0, 0, 0, 0]);
        r.extend(tlv(1, &format!("DCIM/DJI_001/{base}")));
        r.extend(tlv(2, &format!("MISC/THM/DJI_001/{base}")));
        r.extend([0x1b, 0x0a, 0, 0, 0, 0x02, 0x02, 0x01, 0x14, 0x02, 0x15, 0x03, 0x00]);
        let name = format!("{base}.{ext}");
        r.extend([0x0D, name.len() as u8]);
        r.extend(name.as_bytes());
        r
    }

    /// Respuesta `00/27` partida en tramas de `chunk` bytes, con inicio y fin.
    pub fn reply_frames(ctr: u8, body: &[u8], chunk: usize) -> Vec<Frame> {
        let frame = |sub: u8, data: &[u8]| {
            let mut payload = vec![0x4A, sub, 0, 0, ctr, 0, 0, 0, 0, 0];
            payload.extend(data);
            Frame::request(addr::CAMERA, addr::APP, 1, 0x00, 0x27, payload)
        };
        let mut frames = vec![frame(0x04, &[])];
        frames.extend(body.chunks(chunk).map(|c| frame(0x01, c)));
        frames.push(frame(0x03, &[]));
        frames
    }

    #[test]
    fn decodes_videos_and_photos_split_across_frames() {
        let mut body = vec![0u8; 12]; // cuenta, tamaño y fecha de la lista
        body.extend(record("DJI_20261024081530_0002_D", "MP4", 0x0004_0020, 734_003_200, 95));
        body.extend(record("DJI_20261024081000_0001_D", "JPG", 0x0004_0010, 4_200_000, 0));
        let frames = reply_frames(2, &body, 37);

        assert!(answered(&frames) && ended(&frames, 2) && !ended(&frames, 1));
        let files = decode(&reassemble(&frames, Some(2)));
        assert_eq!(files.len(), 2, "{files:?}");

        let video = &files[0];
        assert_eq!(video.name, "DJI_20261024081530_0002_D.MP4");
        assert_eq!(video.file_path(), "DCIM/DJI_001/DJI_20261024081530_0002_D.MP4");
        assert_eq!((video.handle, video.size, video.duration), (0x0004_0020, 734_003_200, Some(95)));
        assert_eq!(video.recorded.as_deref(), Some("2026-10-24T08:15:30"));
        assert_eq!(video.storage, 0);
        assert!(video.is_video());

        let photo = &files[1];
        assert_eq!((photo.name.as_str(), photo.duration, photo.size), ("DJI_20261024081000_0001_D.JPG", None, 4_200_000));
        assert!(!photo.is_video());
        assert!(reassemble(&frames, Some(1)).is_empty());
    }

    #[test]
    fn internal_store_handles_set_storage_one() {
        let body = record("DJI_0001", "MP4", 0x4004_0010, 10, 1);
        assert_eq!(decode(&body)[0].storage, 1);
    }
}
