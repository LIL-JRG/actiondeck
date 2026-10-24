# Conexión sin cable con la Osmo Action 5 Pro

Resumen de lo que sabemos del protocolo, con su grado de confirmación. Las fuentes están en `NOTICE.md`; las abreviaturas son **OS** osmosis, **OC** osmo-client, **VC** dji-vcam.

Marcas: ✅ probado con un Action 5 Pro por alguna fuente · 🟡 documentado para otros modelos · ❓ contradictorio o sin verificar.

## Requisitos

- La cámara debe haberse activado una vez con DJI Mimo. La activación la firma DJI y no se puede imitar ni saltar.
- Solo un cliente a la vez: DJI Mimo debe estar cerrado.
- La computadora necesita Bluetooth LE y Wi-Fi. Con un solo adaptador Wi-Fi pierde internet mientras está en la red de la cámara.

## 1. Bluetooth (implementado en `wireless/ble.rs`)

| Paso | Detalle | Estado |
|---|---|---|
| Anuncio | ID de empresa DJI `0x08AA` (también `0xF7AA`, `0xE5C0`); los dos primeros bytes son el modelo, el Action 5 Pro es `0x0015`. Nuestra cámara anuncia `OsmoAction5Pro675D` (sin guion) y los datos `15 00 fa 88 29 85 cc 67 5e 00`: el tercer byte es `fa`, no `40`, y el byte de despierta/dormida vale `00`, así que no sirve. | ✅ (probado 2026-10-24) |
| Detección | Apagada no se anuncia. Encendida, se anuncia sin parar: aparece en menos de 1 s y, sin anuncios durante 12 s, se da por apagada (`wireless/watch.rs`). El primer anuncio puede traer solo el nombre; el modelo se deduce de él. | ✅ (probado 2026-10-24) |
| GATT | Servicio `fff0`. Se escribe en `fff5` sin confirmación y se recibe en `fff4` y `fff5`. | ✅ |
| Preparar | Suscribirse a `fff4` y `fff5`, escribir `01 00` en el valor de `fff4` con confirmación y esperar ~200 ms. Sin esto la cámara no contesta. | 🟡 |
| MTU | 500; con 517 la cámara deja de responder (OS). btleplug no permite elegirla: la negocia el sistema. | ❓ |
| Abrir sesión | `00/2B [04 00]` hacia `0xF0`. | 🟡 |
| Emparejar | `07/45` con `[len]identificador[len]texto`. Responde `00 01` (ya emparejada) o `00 02` (aceptar en pantalla, ~20 s). La aprobación llega como **petición** `07/46` y hay que contestarla. | ✅ |
| Despertar | `53/10 [00 00 00 00]` hacia `0x1C`. Mimo no siempre lo envía (VC). | ❓ en Action 5 Pro |
| Latido | `00/2B [01 01]` cada segundo mientras dura la sesión Bluetooth. | 🟡 |
| Wi-Fi | `07/07` nombre y `07/0E` contraseña; respuesta `[estado][len][texto]`. `07/0C` es la MAC. | ✅ |
| Cerrar | Mimo cuelga el Bluetooth al tener la contraseña; dejarlo abierto rompía el Wi-Fi tras apagones cortos (VC). | ✅ |

El identificador (32 caracteres) se genera una vez por instalación y se guarda en `wireless.json`. Es la clave con la que la cámara recuerda la aprobación.

## 2. Wi-Fi (implementado en `wireless/wifi.rs`)

La cámara crea una red WPA2 y queda en `192.168.2.1`, repartiendo direcciones `192.168.2.x` ✅. Windows se une con un perfil manual de `netsh`, macOS con `networksetup` y Linux con `nmcli`.

## 3. Enlace de datos y lista de archivos (implementado en `wireless/datalink.rs` y `wireless/manifest.rs`)

Probado el 2026-10-24 con una Action 5 Pro original (se identifica como `ac204` en su `00/81`):

| Paso | Detalle | Estado |
|---|---|---|
| Poke | TCP `192.168.2.1:7001`: una trama `07/45` con **nuestro** identificador y texto de emparejamiento, esperar 400 ms y cerrar. | ✅ |
| Puerto | UDP **9004**, el mismo puerto local. La Xtra Edge Pro (la misma cámara con otra marca) usa 10004 sin poke; se prueba después. Varias notas de osmosis que dicen "Action 5 Pro = 10004" se refieren a la Xtra. | ✅ 9004 |
| Saludo | Tipo `00`, 40 bytes: base aleatoria múltiplo de 8 y la cola `64 00 64 00 c0 05 …` (38 bytes; la documentación de dji-vcam muestra un `00` de más). | ✅ ~2.4 s |
| Secuencia | La nuestra empieza en el canal de la cámara + 8 y avanza de 8 en 8; el "ack" del enrutamiento es nuestra secuencia − 8. Confirmar lo recibido (tipo `04`) en cada tanda. | ✅ |
| Registro | `00/81` (62 B, a `0x48`, flags `0x80`), `00/88` presencia (a `0x28`), `03/DA` y 8 suscripciones `00/99`. | ✅ |
| Reproducción | `02/0C [01 01 00 01]` a la cámara; se confirma con el bit 30 de `02/80`. | ✅ al primer intento |
| Lista | `00/26` (cursor 1, contador 1) → disparador → `00/26` (cursor `0x40000001`, contador 2). Respuestas `00/27`: el contador 1 es la microSD, el 2 la memoria interna. 45 por página; la siguiente se pide con el handle más viejo. | ✅ 13 + 2 archivos |
| Registro de archivo | Orden: cabecera con la marca `ff 19 06`, ruta, miniatura, valores y nombre. Tamaño en T−14 (vale 0 si pasa de 4 GB), handle en T−10, duración en T−6, fecha FAT en T−18. Handles de la microSD desde `0x00040000`, de la interna desde `0x40040000`. | ✅ |
| Estado | Batería en `0d/02` byte 20; microSD total y libre (MiB) en `02/DC` bytes 6 y 10, interna en 24 y 28. | ✅ |

## 4. Descarga (implementado en `wireless/download.rs`)

`GET http://192.168.2.1/v2?storage=<0 microSD|1 interna>&path=DCIM/DJI_001/<nombre>.MP4`, con `Range` para reanudar. Para los archivos de más de 4 GB el tamaño se pide con `HEAD`. Mientras dura, el enlace UDP se mantiene con presencia y confirmación cada segundo. ✅ 243 MB a 68.7 MB/s; el video se decodificó completo.

## Plan de verificación con la cámara

1. ✅ `actiondeck-diag buscar` y `vigilar`: aparece con el modelo `0x0015` y se detecta al encenderla y al apagarla.
2. ✅ `actiondeck-diag emparejar`: pide aceptar en pantalla (unos 20 s; si no, responde `07/46 [02]`) y devuelve el nombre y la contraseña de la red. Las siguientes veces responde `00 01` sin preguntar.
3. ✅ `actiondeck-diag listar --descargar`: despierta la cámara, se une a su red, lista, baja el video más chico y vuelve a la red anterior (internet de vuelta en ~6 s en macOS).

Cada ejecución deja un registro con todas las tramas en `%APPDATA%\com.jorge.actiondeck\diag-logs` (Windows) o `~/Library/Application Support/com.jorge.actiondeck/diag-logs` (macOS).
