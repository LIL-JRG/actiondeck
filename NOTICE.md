# Créditos

La conexión sin cable de ActionDeck (`src-tauri/src/wireless/`) es una implementación propia en Rust, escrita a partir de la documentación pública de estos proyectos, que hicieron la ingeniería inversa del protocolo de las cámaras Osmo:

- [KonradIT/osmosis](https://github.com/KonradIT/osmosis) (MIT): `MEDIA_PROTOCOL.md` y `docs/01-protocol-map.md`. Sus CRC y formato de trama vienen a su vez de [dimadesu/dji-remote](https://github.com/dimadesu/dji-remote) (MIT).
- [luisreysan/osmo-client](https://github.com/luisreysan/osmo-client) (MIT): `docs/PROTOCOL.md`.
- [RB14/dji-vcam](https://github.com/RB14/dji-vcam) (MIT): `docs/protocol-notes.md`, con pruebas en una Osmo Action 5 Pro.
- [intermittech/OsmoOffload](https://github.com/intermittech/OsmoOffload) (MIT).
- [xaionaro-go/djictl](https://github.com/xaionaro-go/djictl) (CC0).

Las pruebas de `wireless/duml.rs` usan como vectores tramas capturadas de DJI Mimo que esos proyectos publicaron.

DJI, Osmo y DJI Mimo son marcas de SZ DJI Technology Co., Ltd. ActionDeck no está afiliado a DJI.
