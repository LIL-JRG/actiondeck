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
| Anuncio | ID de empresa DJI `0x08AA` (también `0xF7AA`, `0xE5C0`); los dos primeros bytes son el modelo, el Action 5 Pro es `0x0015`. El nombre es `OsmoAction5Pro-XXXX`. | ✅ modelo · 🟡 nombre |
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

## 3. Listado de archivos (pendiente)

- Antes del enlace, un "poke": TCP `192.168.2.1:7001`, enviar la trama `07/45` con **el mismo texto de emparejamiento** que por Bluetooth, esperar 400 ms y cerrar ✅ (OS, VC).
- Enlace UDP al puerto `9004` ✅, con cabecera propia de 8 bytes, handshake, acks cada 25 ms y retransmisión. Hay que registrarse como app y contestar las peticiones de la cámara, o da el enlace por perdido.
- Modo reproducción `02/0C [01 01 00 01]`, esperar ~1.7 s y pedir páginas con `00/26`; la respuesta llega en trozos `00/27`. Cada archivo es un registro TLV con nombre, ruta, tamaño, fecha, duración y miniatura.
- ❓ Pendiente de confirmar: el método de paginación, y si `storage` 0 es la microSD (casi todas las fuentes) o la memoria interna.
- En archivos de más de 4 GB el tamaño del listado vale 0: hay que pedirlo con HEAD ✅ (VC).

## 4. Descarga (pendiente)

`GET http://192.168.2.1/v2?storage=<0|1>&path=DCIM/DJI_001/<nombre>.MP4`. El servidor es lighttpd, sin autenticación, y admite `Range` para reanudar ✅. Mientras dura la descarga hay que mantener vivo el enlace UDP, o la cámara apaga su red. La versión ligera `.LRF` se pide cambiando la extensión 🟡.

## Plan de verificación con la cámara

1. `actiondeck-diag buscar`: ¿aparece el Action 5 Pro con el modelo `0x0015`?
2. `actiondeck-diag emparejar`: ¿pide aceptar en pantalla y devuelve el nombre y la contraseña de la red?
3. `actiondeck-diag wifi`: ¿la computadora se une a la red, la cámara responde en `192.168.2.1` y HTTP contesta?
4. Listado por UDP y descarga (siguiente etapa).

Cada ejecución deja un registro con todas las tramas en `%APPDATA%\com.jorge.actiondeck\diag-logs` (Windows) o `~/Library/Application Support/com.jorge.actiondeck/diag-logs` (macOS).
