//! Diagnóstico de la conexión sin cable con la cámara, paso por paso.
//!
//! ```text
//! actiondeck-diag buscar [segundos]        busca cámaras DJI por Bluetooth
//! actiondeck-diag vigilar [segundos]       avisa cuando una cámara se enciende o se apaga
//! actiondeck-diag emparejar [nombre]       empareja y pide el Wi-Fi de la cámara
//! actiondeck-diag wifi [nombre] [--quedarse]
//!                                         se une al Wi-Fi de la cámara y prueba HTTP
//! actiondeck-diag http [ruta]             HEAD a la cámara (ya conectado a su Wi-Fi)
//! actiondeck-diag info                    identidad y cámaras guardadas
//! ```
//!
//! Opciones: `--sin-despertar` (no envía 53/10), `--mostrar-contrasena`.
//! Cada ejecución deja un registro en `<config>/diag-logs/`.

use std::time::Duration;

use actiondeck_lib::wireless::{
    ble,
    config::{self, KnownCamera, WirelessConfig},
    log::{redact, Log},
    watch, wifi,
};

const USAGE: &str = "Uso: actiondeck-diag <buscar|vigilar|emparejar|wifi|http|info> [argumentos] [--sin-despertar] [--mostrar-contrasena] [--quedarse]";

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |f: &str| args.iter().any(|a| a == f);
    let positional: Vec<&str> = args.iter().filter(|a| !a.starts_with("--")).map(String::as_str).collect();
    let Some(&command) = positional.first() else {
        eprintln!("{USAGE}");
        std::process::exit(2);
    };
    let arg = positional.get(1).copied();

    let log = Log::to_dir(&config::config_dir().join("diag-logs"), true);
    log.line(format!("actiondeck-diag {} · {} {}", args.join(" "), std::env::consts::OS, std::env::consts::ARCH));

    let result = match command {
        "buscar" => buscar(&log, arg).await,
        "vigilar" => vigilar(&log, arg).await,
        "emparejar" => emparejar(&log, arg, !flag("--sin-despertar"), flag("--mostrar-contrasena")).await,
        "wifi" => conectar_wifi(&log, arg, flag("--quedarse")),
        "http" => probar_http(&log, arg.unwrap_or("/")),
        "info" => info(&log),
        _ => Err(USAGE.into()),
    };
    match result {
        Ok(()) => log.line("Listo."),
        Err(e) => log.line(format!("ERROR: {e}")),
    }
    if let Some(path) = log.path() {
        println!("\nRegistro guardado en {}", path.display());
    }
}

fn load_config(log: &Log) -> Result<WirelessConfig, String> {
    let path = config::default_path();
    let config = WirelessConfig::load_or_create(&path)?;
    log.line(format!("Identidad {}… guardada en {}", &config.identifier[..8], path.display()));
    Ok(config)
}

async fn buscar(log: &Log, seconds: Option<&str>) -> Result<(), String> {
    let secs = seconds.and_then(|s| s.parse().ok()).unwrap_or(8);
    let found = ble::scan(log, Duration::from_secs(secs)).await?;
    if found.is_empty() {
        return Err("No encontré cámaras. Enciéndela, acércala y cierra DJI Mimo en el teléfono.".into());
    }
    log.line(format!("{} cámara(s) encontradas", found.len()));
    Ok(())
}

async fn vigilar(log: &Log, seconds: Option<&str>) -> Result<(), String> {
    let secs = seconds.and_then(|s| s.parse().ok()).unwrap_or(120);
    log.line(format!("Vigilando durante {secs} s: enciende y apaga la cámara…"));
    let watcher = watch::watch(|nearby| match &nearby.bluetooth_error {
        Some(e) => log.line(format!("Bluetooth: {e}")),
        None if nearby.cameras.is_empty() => log.line("Ninguna cámara encendida cerca"),
        None => {
            let names: Vec<String> = nearby.cameras.iter().map(|c| format!("{} ({})", c.name, c.model)).collect();
            log.line(format!("Cerca: {}", names.join(", ")))
        }
    });
    let _ = tokio::time::timeout(Duration::from_secs(secs), watcher).await;
    Ok(())
}

async fn emparejar(log: &Log, name: Option<&str>, wake: bool, show_password: bool) -> Result<(), String> {
    let mut config = load_config(log)?;
    let found = ble::scan(log, Duration::from_secs(8)).await?;
    let camera = match name {
        Some(n) => found.into_iter().find(|c| c.name.eq_ignore_ascii_case(n)),
        None => found.into_iter().next(),
    }
    .ok_or("No encontré la cámara. Enciéndela, acércala y cierra DJI Mimo en el teléfono.")?;
    log.line(format!("Usando {}", camera.describe()));

    let creds = ble::fetch_credentials(log, &camera, &config, wake, || {
        println!("\n>>> Acepta la conexión en la pantalla de la cámara <<<\n");
    })
    .await?;

    config.remember(KnownCamera {
        name: camera.name.clone(),
        model: camera.model.into(),
        ssid: creds.ssid.clone(),
        password: creds.password.clone(),
        wifi_mac: creds.wifi_mac.clone(),
    });
    config.save(&config::default_path())?;
    log.line(format!(
        "Guardada: {} · red {} · contraseña {}",
        camera.name,
        creds.ssid,
        if show_password { creds.password.clone() } else { redact(&creds.password) }
    ));
    Ok(())
}

fn conectar_wifi(log: &Log, name: Option<&str>, stay: bool) -> Result<(), String> {
    let config = load_config(log)?;
    let camera = match name {
        Some(n) => config.find(n),
        None => config.cameras.last(),
    }
    .ok_or("No hay cámaras guardadas: corre primero `emparejar`.")?;

    let joined = wifi::join(log, &camera.ssid, &camera.password)?;
    let reachable = wifi::wait_reachable(log, Duration::from_secs(25));
    let probe = if reachable { probar_http(log, "/") } else { Err("La cámara no respondió".into()) };
    if stay {
        log.line("Me quedo en la red de la cámara (--quedarse).");
    } else {
        wifi::leave(log, &joined)?;
    }
    probe
}

fn probar_http(log: &Log, path: &str) -> Result<(), String> {
    let url = format!("http://{}{}", wifi::CAMERA_IP, path);
    log.line(format!("HEAD {url}"));
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(5)))
        .http_status_as_error(false)
        .build()
        .into();
    let response = agent.head(&url).call().map_err(|e| format!("Sin respuesta HTTP: {e}"))?;
    log.line(format!("  HTTP {}", response.status()));
    for (name, value) in response.headers() {
        log.line(format!("  {name}: {}", value.to_str().unwrap_or("?")));
    }
    Ok(())
}

fn info(log: &Log) -> Result<(), String> {
    let config = load_config(log)?;
    log.line(format!("Texto de emparejamiento: {}", config.token));
    if config.cameras.is_empty() {
        log.line("Sin cámaras guardadas.");
    }
    for c in &config.cameras {
        log.line(format!("{} · {} · red {} · MAC {}", c.name, c.model, c.ssid, c.wifi_mac.as_deref().unwrap_or("?")));
    }
    Ok(())
}
