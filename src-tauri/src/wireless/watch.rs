//! Detección continua por Bluetooth, como hace Mimo: sin conectarse, escucha
//! los anuncios de las cámaras DJI y avisa cuando una aparece (al encenderla)
//! o deja de anunciarse (al apagarla o alejarla).
//!
//! La cámara se anuncia sin parar mientras está encendida, y en macOS
//! btleplug pide los anuncios repetidos, así que cada uno renueva su "visto".

use btleplug::api::{Central, CentralEvent, CentralState, Manager as _, Peripheral as _, ScanFilter};
use btleplug::platform::{Adapter, Manager, PeripheralId};
use futures::StreamExt;
use serde::Serialize;
use std::collections::HashMap;
use std::time::{Duration, Instant};

use super::ble::{looks_dji, model_from_name, model_name, parse_advert};

/// Sin anuncios durante este tiempo, la cámara se da por apagada.
pub const LOST_AFTER: Duration = Duration::from_secs(12);
/// Espera antes de reintentar si el Bluetooth no está disponible.
const RETRY: Duration = Duration::from_secs(5);

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NearbyCamera {
    /// Identificador del sistema; en macOS cambia de una Mac a otra.
    pub id: String,
    /// Nombre que anuncia, p. ej. `OsmoAction5Pro675D`.
    pub name: String,
    pub model: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Nearby {
    /// Por qué no se puede buscar (Bluetooth apagado, sin adaptador…).
    pub bluetooth_error: Option<String>,
    pub cameras: Vec<NearbyCamera>,
}

/// Cámaras vistas hace menos de `LOST_AFTER`.
#[derive(Default)]
pub struct Tracker {
    seen: HashMap<String, (NearbyCamera, Instant)>,
}

impl Tracker {
    pub fn saw(&mut self, camera: NearbyCamera, now: Instant) {
        self.seen.insert(camera.id.clone(), (camera, now));
    }

    pub fn expire(&mut self, now: Instant) {
        self.seen.retain(|_, (_, at)| now.duration_since(*at) < LOST_AFTER);
    }

    pub fn cameras(&self) -> Vec<NearbyCamera> {
        let mut list: Vec<_> = self.seen.values().map(|(c, _)| c.clone()).collect();
        list.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id)));
        list
    }
}

/// Busca sin fin y llama a `on_change` cada vez que cambia lo que hay cerca.
/// Si el Bluetooth falla o se apaga, lo informa y reintenta.
pub async fn watch(mut on_change: impl FnMut(&Nearby) + Send) {
    let mut last: Option<Nearby> = None;
    let mut report = |now: Nearby| {
        if last.as_ref() != Some(&now) {
            on_change(&now);
            last = Some(now);
        }
    };
    loop {
        if let Err(reason) = scan_until_error(&mut report).await {
            report(Nearby { bluetooth_error: Some(reason), cameras: Vec::new() });
        }
        tokio::time::sleep(RETRY).await;
    }
}

async fn scan_until_error(report: &mut impl FnMut(Nearby)) -> Result<(), String> {
    let manager = Manager::new().await.map_err(|e| format!("Bluetooth no disponible: {e}"))?;
    let central = manager
        .adapters()
        .await
        .map_err(|e| format!("No pude listar adaptadores Bluetooth: {e}"))?
        .into_iter()
        .next()
        .ok_or("No hay adaptador Bluetooth")?;
    if let Ok(CentralState::PoweredOff) = central.adapter_state().await {
        return Err("El Bluetooth está apagado".into());
    }
    let mut events = central.events().await.map_err(|e| e.to_string())?;
    central.start_scan(ScanFilter::default()).await.map_err(|e| format!("No pude buscar: {e}"))?;

    let mut tracker = Tracker::default();
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    report(Nearby::default());
    loop {
        tokio::select! {
            event = events.next() => {
                let id = match event {
                    None => return Err("El Bluetooth dejó de responder".into()),
                    Some(CentralEvent::StateUpdate(CentralState::PoweredOff)) => {
                        return Err("El Bluetooth está apagado".into());
                    }
                    Some(
                        CentralEvent::DeviceDiscovered(id)
                        | CentralEvent::DeviceUpdated(id)
                        | CentralEvent::ManufacturerDataAdvertisement { id, .. }
                        | CentralEvent::RssiUpdate { id, .. },
                    ) => id,
                    Some(_) => continue,
                };
                if let Some(camera) = identify(&central, &id).await {
                    tracker.saw(camera, Instant::now());
                }
            }
            _ = tick.tick() => {}
        }
        tracker.expire(Instant::now());
        report(Nearby { bluetooth_error: None, cameras: tracker.cameras() });
    }
}

async fn identify(central: &Adapter, id: &PeripheralId) -> Option<NearbyCamera> {
    let props = central.peripheral(id).await.ok()?.properties().await.ok()??;
    let advert = parse_advert(&props.manufacturer_data);
    let name = props.local_name.or(props.advertisement_name).unwrap_or_default();
    if !looks_dji(&name, advert.as_ref()) {
        return None;
    }
    let model = advert
        .and_then(|a| a.model_id)
        .map(model_name)
        .or_else(|| model_from_name(&name))
        .unwrap_or("Cámara DJI");
    Some(NearbyCamera {
        id: id.to_string(),
        name: if name.is_empty() { model.to_string() } else { name },
        model: model.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cam(id: &str) -> NearbyCamera {
        NearbyCamera { id: id.into(), name: format!("OsmoAction5Pro{id}"), model: "Osmo Action 5 Pro".into() }
    }

    #[test]
    fn camera_disappears_when_it_stops_advertising() {
        let start = Instant::now();
        let mut tracker = Tracker::default();
        tracker.saw(cam("675D"), start);
        tracker.saw(cam("1A2B"), start);

        // La segunda sigue anunciándose; la primera se apagó.
        tracker.saw(cam("1A2B"), start + LOST_AFTER - Duration::from_secs(1));
        tracker.expire(start + LOST_AFTER + Duration::from_millis(1));
        assert_eq!(tracker.cameras(), [cam("1A2B")]);

        // Al volver a encenderla reaparece.
        tracker.saw(cam("675D"), start + LOST_AFTER * 2);
        assert_eq!(tracker.cameras(), [cam("1A2B"), cam("675D")]);
    }
}
