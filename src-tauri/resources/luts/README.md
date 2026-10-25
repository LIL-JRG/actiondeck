# LUT oficiales de DJI

Descargadas de las páginas de descargas de dji.com el 2026-10-24 y sin modificar.
Convierten el perfil logarítmico de cada cámara a Rec.709. Se incrustan en la app
(`src/luts.rs`), así el usuario no tiene que descargar nada.

| Archivo | Original de DJI | Cámaras |
|---|---|---|
| `dlog-m.cube` | DJI OSMO Action 5 Pro D-Log M to Rec.709 V1 | Action 4, Action 5 Pro, Pocket 3, Osmo 360 y Nano publican exactamente este mismo archivo |
| `action-6.cube` | DJI OSMO Action 6 D-LogM to Rec.709 LUT-11.17 | Osmo Action 6 |
| `pocket-4.cube` | DJI OSMO Pocket 4 D-Log to Rec.709 V2.0 | Osmo Pocket 4 |
| `pocket-4-vivid.cube` | DJI OSMO Pocket 4 D-Log to Rec.709 vivid V2.0 | Pocket 4 y Pocket 4 Pro (idéntico) |
| `pocket-4-pro.cube` | DJI OSMO Pocket 4P D-Log to Rec.709 V2.0 size33 | Osmo Pocket 4 Pro |
| `pocket-4-pro-dlog2.cube` | DJI OSMO Pocket 4P D-Log2 to Rec.709 V1.0 size33 | Osmo Pocket 4 Pro |
| `pocket-4-pro-dlog2-vivid.cube` | DJI OSMO Pocket 4P D-Log2 to Rec.709 vivid V1.0 size33 | Osmo Pocket 4 Pro |

Los estilos creativos ("Rec.709 to Color Grading LUTs" de la Action 4, Action 5 Pro
y Pocket 3) no se incluyen: la app los descarga del CDN de DJI cuando el usuario
lo pide (Ajustes › Filtros).

Antes de distribuir la app públicamente, conviene confirmar con DJI que se permite
redistribuir estos archivos.
