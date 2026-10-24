//! Unirse al punto de acceso de la cámara y volver a la red anterior.
//!
//! - Windows: perfil WPA2-PSK con conexión manual (`netsh wlan`), para que
//!   Windows no se quede en la red de la cámara ni salte a ella solo.
//! - macOS: `networksetup -setairportnetwork`. Para volver no sirve la
//!   contraseña guardada (error -3924): se olvida la red de la cámara y se
//!   apaga y enciende el Wi-Fi para que vuelva a la red de siempre.
//! - Linux: `nmcli`.
//!
//! Con un solo adaptador Wi-Fi la computadora pierde internet mientras está en
//! la red de la cámara; con cable de red o un segundo adaptador, no.

use std::net::{SocketAddr, TcpStream};
use std::process::Command;
use std::time::{Duration, Instant};

use super::log::{redact, Log};

pub const CAMERA_IP: &str = "192.168.2.1";

/// Lo necesario para volver a la red anterior.
#[derive(Clone, Debug, Default)]
pub struct Joined {
    pub ssid: String,
    /// Perfil de Windows o conexión de NetworkManager activos antes de unirse.
    pub previous: Option<String>,
    /// Interfaz Wi-Fi en macOS (p. ej. `en0`).
    pub device: Option<String>,
}

fn run(log: &Log, program: &str, args: &[String]) -> Result<String, String> {
    log.line(format!("$ {program} {}", args.join(" ")));
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // netsh necesita `name="..."` tal cual, sin el entrecomillado de Rust.
        for a in args {
            cmd.raw_arg(a);
        }
        cmd.creation_flags(0x0800_0000);
    }
    #[cfg(not(windows))]
    cmd.args(args);
    let out = cmd.output().map_err(|e| format!("No pude ejecutar {program}: {e}"))?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        log.line(format!("  {}", line.trim_end()));
    }
    if !out.status.success() {
        return Err(format!("{program} falló: {}", text.trim()));
    }
    Ok(text)
}

/// ¿Responde la cámara en el puerto HTTP?
pub fn camera_reachable() -> bool {
    let addr: SocketAddr = format!("{CAMERA_IP}:80").parse().unwrap();
    TcpStream::connect_timeout(&addr, Duration::from_millis(800)).is_ok()
}

pub fn wait_reachable(log: &Log, limit: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < limit {
        if camera_reachable() {
            log.line(format!("La cámara responde en {CAMERA_IP} ({} ms)", start.elapsed().as_millis()));
            return true;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    log.line(format!("La cámara no respondió en {CAMERA_IP} tras {} s", limit.as_secs()));
    false
}

pub fn join(log: &Log, ssid: &str, password: &str) -> Result<Joined, String> {
    log.line(format!("Uniéndome a {ssid} (contraseña {})", redact(password)));
    platform::join(log, ssid, password)
}

pub fn leave(log: &Log, joined: &Joined) -> Result<(), String> {
    log.line(format!("Saliendo de {}", joined.ssid));
    platform::leave(log, joined)
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

/// Perfil WPA2-PSK/AES con conexión manual para `netsh wlan add profile`.
pub fn windows_profile_xml(ssid: &str, password: &str) -> String {
    let (ssid, password) = (xml_escape(ssid), xml_escape(password));
    format!(
        r#"<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
  <name>{ssid}</name>
  <SSIDConfig><SSID><name>{ssid}</name></SSID></SSIDConfig>
  <connectionType>ESS</connectionType>
  <connectionMode>manual</connectionMode>
  <MSM>
    <security>
      <authEncryption>
        <authentication>WPA2PSK</authentication>
        <encryption>AES</encryption>
        <useOneX>false</useOneX>
      </authEncryption>
      <sharedKey>
        <keyType>passPhrase</keyType>
        <protected>false</protected>
        <keyMaterial>{password}</keyMaterial>
      </sharedKey>
    </security>
  </MSM>
</WLANProfile>
"#
    )
}

/// Perfil activo según `netsh wlan show interfaces` (en inglés o español).
pub fn parse_netsh_profile(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        let key = key.trim().to_lowercase();
        (key == "profile" || key == "perfil").then(|| value.trim().to_string()).filter(|v| !v.is_empty())
    })
}

/// `netsh wlan show interfaces` sin adaptador (en inglés o español).
pub fn netsh_has_no_wifi(output: &str) -> bool {
    let text = output.to_lowercase();
    text.contains("no hay ninguna interfaz inalámbrica") || text.contains("there is no wireless interface")
}

/// Interfaz del puerto "Wi-Fi" según `networksetup -listallhardwareports`.
pub fn parse_macos_wifi_device(output: &str) -> Option<String> {
    let mut lines = output.lines();
    while let Some(line) = lines.next() {
        if line.trim() == "Hardware Port: Wi-Fi" || line.trim() == "Hardware Port: AirPort" {
            return lines.next()?.trim().strip_prefix("Device:").map(|d| d.trim().to_string());
        }
    }
    None
}

#[cfg(windows)]
mod platform {
    use super::*;

    pub fn join(log: &Log, ssid: &str, password: &str) -> Result<Joined, String> {
        let status = run(log, "netsh", &["wlan".into(), "show".into(), "interfaces".into()])?;
        if netsh_has_no_wifi(&status) {
            return Err("Esta computadora no tiene adaptador Wi-Fi".into());
        }
        let previous = parse_netsh_profile(&status).filter(|p| p != ssid);
        log.line(format!("Red actual: {}", previous.as_deref().unwrap_or("(ninguna)")));

        let file = std::env::temp_dir().join(format!("actiondeck-{}.xml", std::process::id()));
        std::fs::write(&file, windows_profile_xml(ssid, password)).map_err(|e| e.to_string())?;
        let added = run(
            log,
            "netsh",
            &["wlan".into(), "add".into(), "profile".into(), format!("filename=\"{}\"", file.display()), "user=current".into()],
        );
        let _ = std::fs::remove_file(&file);
        added?;
        run(log, "netsh", &["wlan".into(), "connect".into(), format!("name=\"{ssid}\""), format!("ssid=\"{ssid}\"")])?;
        Ok(Joined { ssid: ssid.into(), previous, device: None })
    }

    pub fn leave(log: &Log, joined: &Joined) -> Result<(), String> {
        match &joined.previous {
            Some(profile) => run(log, "netsh", &["wlan".into(), "connect".into(), format!("name=\"{profile}\"")]).map(|_| ()),
            None => run(log, "netsh", &["wlan".into(), "disconnect".into()]).map(|_| ()),
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;

    fn device(log: &Log) -> Result<String, String> {
        let ports = run(log, "networksetup", &["-listallhardwareports".into()])?;
        parse_macos_wifi_device(&ports).ok_or_else(|| "Esta Mac no tiene interfaz Wi-Fi".into())
    }

    pub fn join(log: &Log, ssid: &str, password: &str) -> Result<Joined, String> {
        let device = device(log)?;
        // networksetup devuelve 0 aunque falle; el error viene en el texto.
        let out = run(log, "networksetup", &["-setairportnetwork".into(), device.clone(), ssid.into(), password.into()])?;
        if out.contains("Error") || out.contains("Could not find") || out.contains("Failed") {
            return Err(format!("macOS no pudo unirse a {ssid}: {}", out.trim()));
        }
        Ok(Joined { ssid: ssid.into(), previous: None, device: Some(device) })
    }

    pub fn leave(log: &Log, joined: &Joined) -> Result<(), String> {
        let device = joined.device.clone().map(Ok).unwrap_or_else(|| device(log))?;
        let _ = run(log, "networksetup", &["-removepreferredwirelessnetwork".into(), device.clone(), joined.ssid.clone()]);
        run(log, "networksetup", &["-setairportpower".into(), device.clone(), "off".into()])?;
        std::thread::sleep(Duration::from_secs(1));
        run(log, "networksetup", &["-setairportpower".into(), device, "on".into()]).map(|_| ())
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;

    pub fn join(log: &Log, ssid: &str, password: &str) -> Result<Joined, String> {
        let active = run(log, "nmcli", &["-t".into(), "-f".into(), "NAME,TYPE".into(), "con".into(), "show".into(), "--active".into()])?;
        let previous = active.lines().find(|l| l.ends_with(":802-11-wireless")).map(|l| l.trim_end_matches(":802-11-wireless").to_string());
        run(log, "nmcli", &["dev".into(), "wifi".into(), "connect".into(), ssid.into(), "password".into(), password.into()])?;
        Ok(Joined { ssid: ssid.into(), previous, device: None })
    }

    pub fn leave(log: &Log, joined: &Joined) -> Result<(), String> {
        let _ = run(log, "nmcli", &["con".into(), "down".into(), "id".into(), joined.ssid.clone()]);
        if let Some(prev) = &joined.previous {
            run(log, "nmcli", &["con".into(), "up".into(), "id".into(), prev.clone()])?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_escapes_xml_and_is_manual() {
        let xml = windows_profile_xml("Osmo<&>", "p\"a's");
        assert!(xml.contains("<name>Osmo&lt;&amp;&gt;</name>"));
        assert!(xml.contains("<keyMaterial>p&quot;a&apos;s</keyMaterial>"));
        assert!(xml.contains("<connectionMode>manual</connectionMode>"));
    }

    #[test]
    fn reads_active_profile_in_english_and_spanish() {
        let en = "    Name                   : Wi-Fi\n    SSID                   : Casa\n    BSSID                  : aa:bb\n    Profile                : Casa 5G\n";
        let es = "    Nombre                 : Wi-Fi\n    SSID                   : Casa\n    Perfil                 : Casa 5G\n";
        assert_eq!(parse_netsh_profile(en).as_deref(), Some("Casa 5G"));
        assert_eq!(parse_netsh_profile(es).as_deref(), Some("Casa 5G"));
        assert_eq!(parse_netsh_profile("    Estado : desconectado\n"), None);
    }

    #[test]
    fn detects_missing_wifi_adapter() {
        assert!(netsh_has_no_wifi("No hay ninguna interfaz inalámbrica en el sistema.\r\n"));
        assert!(netsh_has_no_wifi("There is no wireless interface on the system.\r\n"));
        assert!(!netsh_has_no_wifi("    Nombre : Wi-Fi\n    Estado : conectado\n"));
    }

    #[test]
    fn finds_macos_wifi_device() {
        let out = "Hardware Port: Ethernet\nDevice: en1\nEthernet Address: x\n\nHardware Port: Wi-Fi\nDevice: en0\nEthernet Address: y\n";
        assert_eq!(parse_macos_wifi_device(out).as_deref(), Some("en0"));
        assert_eq!(parse_macos_wifi_device("Hardware Port: Ethernet\nDevice: en1\n"), None);
    }
}
