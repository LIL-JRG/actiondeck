# ActionDeck

App de escritorio para Windows y macOS que hace con las cámaras DJI Osmo lo que DJI Mimo hace en el teléfono.

Fase 1 (esta versión):

- **Importar**: detecta la cámara conectada por USB o su microSD (cualquier unidad con `DCIM`) y copia los videos y fotos a la biblioteca, en carpetas por fecha. No duplica lo ya importado y una copia interrumpida nunca queda como archivo completo.
- **Recuperar color**: las LUT oficiales de DJI para convertir D-Log M, D-Log y D-Log2 a Rec.709 vienen dentro de la app. Cada clip usa la de su cámara: la app lee el modelo y el perfil de color de los metadatos de DJI y solo convierte los clips grabados en un perfil logarítmico.
- **Filtros**: los estilos creativos de DJI (Action 4, Action 5 Pro, Pocket 3) se descargan con un clic desde Ajustes, y se puede importar cualquier LUT `.cube`.
- **Vista previa en vivo**: el color recuperado y el filtro se ven mientras se reproduce (WebGL2 con LUT 3D en la GPU), en el editor, en el álbum y en la tira de cuadros.
- **Videos 360 (Osmo 360)**: los `.OSV` se ven arrastrando para mirar alrededor, en vista normal o "pequeño planeta"; en el editor cada clip guarda su vista y se exporta en cualquier formato (también vertical) con el `v360` de ffmpeg. La vista previa usa el `.LRF` de la cámara (las dos lentes lado a lado) y se importa junto con el `.OSV`.
- **Editar**: recortar clips, compararlos antes y después de la LUT, ordenarlos en una línea de tiempo y unirlos.
- **Exportar**: H.265 de 10 bits o H.264, por GPU NVIDIA (NVENC) o procesador, con progreso y cancelación.

Fase 2:

- **Detectar la cámara** por Bluetooth en cuanto se enciende, como DJI Mimo.
- **Importar por Wi-Fi**: la primera vez se acepta la conexión en la pantalla de la cámara; después, al encenderla, la app la detecta sola y ofrece conectarse. Se une a la red de la cámara, muestra sus archivos con miniaturas y vista previa, y descarga los que elijas (unos 70 MB/s). Vuelve a la red anterior al desconectar o tras 2 minutos sin usarla. Con un solo adaptador Wi-Fi, la computadora no tiene internet mientras tanto.

## Cámaras

| Modelo | USB / microSD | Wi-Fi | LUT incluida |
|---|---|---|---|
| Osmo Action 5 Pro | sí | probada | D-Log M |
| Osmo Action 6, Pocket 3, Nano | sí | mismo protocolo (verificado por [Osmosis](https://github.com/KonradIT/osmosis)) | D-Log M |
| Osmo Action 4, Pocket 4, Pocket 4 Pro | sí | sin probar | D-Log M / D-Log / D-Log2 |
| Osmo Action 3 | sí | sin probar | — (D-Cinelike) |
| Osmo 360 | sí, incluidos los 360 `.OSV` | no levanta su red Wi-Fi | D-Log M |
| Osmo Action, Action 2 | sí | no | — |

Las tablas de modelos están en `src-tauri/src/devices.rs`; las LUT, en `src-tauri/resources/luts/`.

Fase siguiente: DJI Mic Mini 2 (fase 3).

## Instalar en Mac

Descarga el `.dmg` de [Releases](https://github.com/LIL-JRG/actiondeck/releases), ábrelo y arrastra ActionDeck a Aplicaciones. Es para Mac con Apple Silicon (M1 o posterior), macOS 12+, y ya trae ffmpeg dentro.

La app no está firmada con un certificado de Apple, así que la primera vez macOS no la deja abrir:

1. Abre ActionDeck desde Aplicaciones y cierra el aviso.
2. Ve a Ajustes del Sistema › Privacidad y seguridad, baja hasta «Se bloqueó ActionDeck» y pulsa **Abrir de todos modos**.

También funciona `xattr -dr com.apple.quarantine /Applications/ActionDeck.app` en la Terminal.

Para generar el `.dmg`: `npm run release:mac`. Descarga ffmpeg estático (verificado con SHA-256) a `src-tauri/binaries/` y deja el instalador en `src-tauri/target/release/bundle/dmg/`. Ese ffmpeg es una compilación GPL de [Martin Riedl](https://ffmpeg.martin-riedl.de).

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
- `src-tauri/src/render.rs`: exportación, cuadros de comparación y vistas previas ligeras.
- `src-tauri/src/devices.rs`: modelos de cámara (Bluetooth, metadatos, Wi-Fi, LUT oficial).
- `src-tauri/src/luts.rs`: LUT incluidas, extra del usuario y paquetes de estilos de DJI.
- `src-tauri/src/lib.rs`: estado, ajustes y comandos que usa la interfaz.
- `src/`: interfaz en React (Importar, Editar y exportar, Ajustes).

Los ajustes se guardan en `%APPDATA%\com.jorge.actiondeck\settings.json`; las LUT extra, en `luts\` junto a ellos; miniaturas y vistas previas, en `%LOCALAPPDATA%\com.jorge.actiondeck`.

## Pendiente de probar en Mac

- Compilar: el código exclusivo de macOS (detección en `/Volumes`, VideoToolbox) solo se revisó a mano, porque no se puede compilar para Mac desde Windows.
- La calidad de VideoToolbox se traduce de CRF de forma aproximada (CRF 20 ≈ `-q:v 70`); conviene compararla con la de la CPU.
- Que WKWebView reproduzca directamente los HEVC de la cámara; si no, la app genera la vista previa ligera sola.

## Pendiente de probar con la cámara real

- Que la Osmo Action 5 Pro por USB aparezca como unidad con letra (si aparece como dispositivo MTP, sin letra, la app no la verá todavía).
- Wi-Fi con los modelos que no son la Action 5 Pro.
