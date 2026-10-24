# ActionDeck

App de escritorio para Windows que hace con una DJI Osmo Action 5 Pro lo que DJI Mimo hace en el teléfono.

Fase 1 (esta versión):

- **Importar**: detecta la cámara conectada por USB o su microSD (cualquier unidad con `DCIM`) y copia los videos y fotos a la biblioteca, en carpetas por fecha. No duplica lo ya importado y una copia interrumpida nunca queda como archivo completo.
- **Recuperar color**: aplica la LUT oficial de DJI "D-Log M to Rec.709" (se descarga de DJI y se elige en Ajustes; la app no la incluye).
- **Editar**: recortar clips, compararlos antes y después de la LUT, ordenarlos en una línea de tiempo y unirlos.
- **Exportar**: H.265 de 10 bits o H.264, por GPU NVIDIA (NVENC) o procesador, con progreso y cancelación.

Fases siguientes: transferencia por Wi-Fi y detección por Bluetooth (fase 2), DJI Mic Mini 2 (fase 3).

## Requisitos

- Windows 10/11 con WebView2.
- ffmpeg y ffprobe en el PATH (`winget install Gyan.FFmpeg`) o en una carpeta elegida en Ajustes.
- Para desarrollar: Node.js 22+, Rust estable y Visual Studio Build Tools (C++).

## Desarrollo

```powershell
npm install
npm run tauri dev                       # app con recarga en vivo
cd src-tauri; cargo test                # pruebas rápidas
cargo test -- --include-ignored         # además, exportaciones reales con ffmpeg
npm run tauri build                     # instalador NSIS en src-tauri\target\release\bundle
```

## Estructura

- `src-tauri/src/media.rs`: análisis de clips con ffprobe, búsqueda de archivos y detección de la cámara.
- `src-tauri/src/import.rs`: copia con progreso a la biblioteca.
- `src-tauri/src/render.rs`: LUT, exportación, cuadros de comparación y vistas previas ligeras.
- `src-tauri/src/lib.rs`: estado, ajustes y comandos que usa la interfaz.
- `src/`: interfaz en React (Importar, Editar y exportar, Ajustes).

Los ajustes se guardan en `%APPDATA%\com.jorge.actiondeck\settings.json`; miniaturas, vistas previas y la LUT activa, en `%LOCALAPPDATA%\com.jorge.actiondeck`.

## Pendiente de probar con la cámara real

- Que la Osmo Action 5 Pro por USB aparezca como unidad con letra (si aparece como dispositivo MTP, sin letra, la app no la verá todavía).
- Cómo etiqueta la cámara sus clips en D-Log M, para marcar la LUT automáticamente solo en esos clips.
