import { useEffect, useState, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { api, errorText, hardwareName, type Lut, type LutPack, type Settings } from "./api";
import { shortLutName } from "./EditView";
import { CheckIcon, ChipIcon, DownloadIcon, ExternalIcon, FolderIcon, LogIcon, PaletteIcon, PlusIcon, TrashIcon } from "./icons";

const DJI_DOWNLOADS = "https://www.dji.com/downloads";

type Props = {
  settings: Settings;
  onChange: (settings: Settings) => void;
  luts: Lut[];
  onLutsChange: (luts: Lut[]) => void;
  onError: (message: string) => void;
};

export function SettingsView({ settings, onChange, luts, onLutsChange, onError }: Props) {
  const [packs, setPacks] = useState<LutPack[]>([]);
  const [downloading, setDownloading] = useState<string | null>(null);

  useEffect(() => {
    api.lutPacks().then(setPacks).catch(() => {});
  }, [luts]);

  const changeLuts = async (action: () => Promise<Lut[]>) => {
    try {
      onLutsChange(await action());
    } catch (e) {
      onError(errorText(e));
    }
  };

  const importLut = async () => {
    const path = await open({ title: "LUT extra (.cube)", filters: [{ name: "LUT 3D", extensions: ["cube"] }] });
    if (typeof path === "string") changeLuts(() => api.importLut(path));
  };

  const downloadPack = async (id: string) => {
    setDownloading(id);
    await changeLuts(() => api.downloadLutPack(id));
    setDownloading(null);
  };

  const official = luts.filter((l) => l.builtin);
  const extras = luts.filter((l) => !l.builtin);

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
              Las cámaras DJI graban en D-Log M (o D-Log), un perfil plano que conserva más detalle pero se ve gris. Las
              LUT oficiales de DJI le devuelven el color; ya vienen en la app y cada clip usa la de su cámara.
            </>
          }
        >
          {official.map((l) => (
            <SettingRow key={l.id} label={l.name} value={l.detail}>
              <span className="tag">Incluida</span>
            </SettingRow>
          ))}
        </Group>

        <Group
          icon={<PaletteIcon size={24} />}
          title="Filtros (LUT extra)"
          text="Estilos que se aplican encima del color recuperado. Descarga los de DJI o importa cualquier LUT .cube."
        >
          {packs.map((p) => (
            <SettingRow key={p.id} label={`Estilos de DJI para ${p.name}`} value={p.installed ? "Descargados" : "Del sitio de DJI"}>
              {p.installed ? (
                <span className="tag ok">
                  <CheckIcon size={14} /> Listo
                </span>
              ) : (
                <button className="pill small" onClick={() => downloadPack(p.id)} disabled={downloading !== null}>
                  {downloading === p.id ? <span className="spinner" /> : <DownloadIcon size={16} />}
                  {downloading === p.id ? "Descargando…" : "Descargar"}
                </button>
              )}
            </SettingRow>
          ))}
          {extras.map((l) => (
            <SettingRow key={l.id} label={shortLutName(l.name)} value={l.name}>
              <button className="round small" onClick={() => changeLuts(() => api.removeLut(l.id))} aria-label={`Quitar ${l.name}`} title="Quitar">
                <TrashIcon size={18} />
              </button>
            </SettingRow>
          ))}
          <SettingRow label="Otra LUT" value="Un archivo .cube de cualquier fuente">
            <button className="round small" onClick={() => openUrl(DJI_DOWNLOADS)} aria-label="Abrir las descargas de DJI" title="Descargas de DJI">
              <ExternalIcon size={18} />
            </button>
            <button className="pill small" onClick={importLut}>
              <PlusIcon size={16} /> Importar…
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
