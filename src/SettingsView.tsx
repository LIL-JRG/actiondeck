import type { ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { api, errorText, hardwareName, type Settings } from "./api";
import { ChipIcon, ExternalIcon, FolderIcon, LogIcon } from "./icons";

const DJI_DOWNLOADS = "https://www.dji.com/downloads/djiapp/dji-mimo";

type Props = {
  settings: Settings;
  onChange: (settings: Settings) => void;
  onError: (message: string) => void;
};

export function SettingsView({ settings, onChange, onError }: Props) {
  const apply = async (action: () => Promise<Settings>) => {
    try {
      onChange(await action());
    } catch (e) {
      onError(errorText(e));
    }
  };

  const pickLibrary = async () => {
    const path = await open({ directory: true, title: "Carpeta de la biblioteca", defaultPath: settings.libraryDir });
    if (typeof path === "string") apply(() => api.setLibraryDir(path));
  };

  const pickLut = async () => {
    const path = await open({ title: "LUT de D-Log M (.cube)", filters: [{ name: "LUT 3D", extensions: ["cube"] }] });
    if (typeof path === "string") apply(() => api.setLut(path));
  };

  const pickFfmpeg = async () => {
    const path = await open({ directory: true, title: "Carpeta que contiene ffmpeg y ffprobe" });
    if (typeof path === "string") apply(() => api.setFfmpegDir(path));
  };

  return (
    <div className="settings">
      <header className="page-header">
        <h1 className="page-title">Ajustes</h1>
      </header>

      <div className="settings-groups">
        <Group
          icon={<LogIcon size={24} />}
          title="Recuperación de color"
          text={
            <>
              La Osmo Action 5 Pro graba en D-Log M, un perfil plano que conserva más detalle pero se ve gris. La LUT
              oficial de DJI <em>«D-Log M to Rec.709»</em> le devuelve el color. Descárgala de la página de DJI,
              descomprímela y elige el archivo <span className="mono">.cube</span>.
            </>
          }
        >
          <SettingRow label="LUT" value={settings.lutName ? `${settings.lutName} (${settings.lutSize}³)` : "Sin elegir: se exporta con el color original"}>
            {settings.lutName && (
              <button className="link" onClick={() => apply(api.clearLut)}>
                Quitar
              </button>
            )}
            <button className="pill small" onClick={pickLut}>
              {settings.lutName ? "Cambiar…" : "Elegir…"}
            </button>
          </SettingRow>
          <SettingRow label="Descargar la LUT" value="Página de descargas de DJI">
            <button className="round small" onClick={() => openUrl(DJI_DOWNLOADS)} aria-label="Abrir la página de DJI">
              <ExternalIcon size={18} />
            </button>
          </SettingRow>
        </Group>

        <Group icon={<FolderIcon size={24} />} title="Biblioteca" text="Lo que importas se copia aquí, en una carpeta por día de grabación.">
          <SettingRow label="Carpeta" value={<span className="mono">{settings.libraryDir}</span>}>
            <button className="link" onClick={() => revealItemInDir(settings.libraryDir)}>
              Mostrar
            </button>
            <button className="pill small" onClick={pickLibrary}>
              Cambiar…
            </button>
          </SettingRow>
        </Group>

        <Group icon={<ChipIcon size={24} />} title="Motor de video" text="ffmpeg hace las miniaturas, las vistas previas y la exportación.">
          <SettingRow
            label="ffmpeg"
            value={
              settings.ffmpegError ? (
                <span className="warning">{settings.ffmpegError}</span>
              ) : settings.ffmpegDir ? (
                <span className="mono">{settings.ffmpegDir}</span>
              ) : (
                "El del sistema"
              )
            }
          >
            {settings.ffmpegDir && (
              <button className="link" onClick={() => apply(() => api.setFfmpegDir(null))}>
                Usar el del sistema
              </button>
            )}
            <button className="pill small" onClick={pickFfmpeg}>
              Elegir carpeta…
            </button>
          </SettingRow>
          {settings.hardware && (
            <SettingRow
              label="Aceleración"
              value={`${hardwareName(settings.hardware.encoder)} · H.264 ${settings.hardware.h264 ? "sí" : "no"} · H.265 10 bits ${settings.hardware.hevc ? "sí" : "no"}`}
            />
          )}
        </Group>
      </div>
    </div>
  );
}

function Group({ icon, title, text, children }: { icon: ReactNode; title: string; text: ReactNode; children: ReactNode }) {
  return (
    <section className="settings-group">
      <header className="settings-group-head">
        <span className="settings-icon">{icon}</span>
        <div>
          <h2>{title}</h2>
          <p className="hint small">{text}</p>
        </div>
      </header>
      <div className="settings-rows">{children}</div>
    </section>
  );
}

function SettingRow({ label, value, children }: { label: string; value: ReactNode; children?: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-text">
        <span className="setting-label">{label}</span>
        <span className="setting-value">{value}</span>
      </div>
      {children && <div className="row">{children}</div>}
    </div>
  );
}
