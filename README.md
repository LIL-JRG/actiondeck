# ActionDeck

App de escritorio para Windows que hace con una DJI Osmo Action 5 Pro lo que DJI Mimo hace en el teléfono.

Fase 1 (esta versión):

- **Importar**: detecta la cámara conectada por USB o su microSD (cualquier unidad con `DCIM`) y copia los videos y fotos a la biblioteca, en carpetas por fecha. No duplica lo ya importado y una copia interrumpida nunca queda como archivo completo.
- **Recuperar color**: aplica la LUT oficial de DJI "D-Log M to Rec.709" (se descarga de DJI y se elige en Ajustes; la app no la incluye).
- **Editar**: recortar clips, compararlos antes y después de la LUT, ordenarlos en una línea de tiempo y unirlos.
- **Exportar**: H.265 de 10 bits o H.264, por GPU NVIDIA (NVENC) o procesador, con progreso y cancelación.

Fase 2:

- **Detectar la cámara** por Bluetooth en cuanto se enciende, como DJI Mimo.
- **Importar por Wi-Fi**: la primera vez se acepta la conexión en la pantalla de la cámara; después basta con elegirla en Importar. La app se une a la red de la cámara, lista sus archivos, los descarga (unos 70 MB/s) y vuelve a la red anterior. Con un solo adaptador Wi-Fi, la computadora no tiene internet mientras tanto.

Fase siguiente: DJI Mic Mini 2 (fase 3).

## Requisitos

- **Windows 10/11** con WebView2. ffmpeg y ffprobe: `winget install Gyan.FFmpeg`. Exporta rápido con GPU NVIDIA (NVENC) si hay una.
- **macOS 12+**. ffmpeg y ffprobe: `brew install ffmpeg` (la app los busca también en `/opt/homebrew/bin` y `/usr/local/bin`). Exporta rápido con VideoToolbox. La cámara o la microSD se detectan en `/Volumes`.
- También se puede elegir la carpeta de ffmpeg en Ajustes.
- Para desarrollar: Node.js 22+ y Rust estable, más Visual Studio Build Tools (C++) en Windows o Xcode Command Line Tools (`xcode-select --install`) en macOS. El instalador de Mac (`.app`/`.dmg`) solo se puede generar en una Mac.

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

## Pendiente de probar en Mac

- Compilar: el código exclusivo de macOS (detección en `/Volumes`, VideoToolbox) solo se revisó a mano, porque no se puede compilar para Mac desde Windows.
- La calidad de VideoToolbox se traduce de CRF de forma aproximada (CRF 20 ≈ `-q:v 70`); conviene compararla con la de la CPU.
- Que WKWebView reproduzca directamente los HEVC de la cámara; si no, la app genera la vista previa ligera sola.

## Pendiente de probar con la cámara real

- Que la Osmo Action 5 Pro por USB aparezca como unidad con letra (si aparece como dispositivo MTP, sin letra, la app no la verá todavía).
- Cómo etiqueta la cámara sus clips en D-Log M, para marcar la LUT automáticamente solo en esos clips.
