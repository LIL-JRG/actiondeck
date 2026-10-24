import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errorText, hardwareName, type Settings } from "./api";

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
    const path = await open({ directory: true, title: "Carpeta que contiene ffmpeg.exe y ffprobe.exe" });
    if (typeof path === "string") apply(() => api.setFfmpegDir(path));
  };

  return (
    <div className="settings-view">
      <section className="panel setting">
        <h2>Recuperar color (LUT)</h2>
        <p>
          La Osmo Action 5 Pro graba en D-Log M, un perfil plano que conserva más detalle pero se ve gris. Para devolverle
          el color se aplica la LUT oficial de DJI <em>“D-Log M to Rec.709”</em>. Descárgala de la página de DJI,
          descomprímela y elige el archivo <span className="mono">.cube</span>.
        </p>
        <div className="row">
          <button className="primary" onClick={pickLut}>
            {settings.lutName ? "Cambiar LUT…" : "Elegir LUT…"}
          </button>
          <button className="secondary" onClick={() => openUrl(DJI_DOWNLOADS)}>
            Abrir descargas de DJI
          </button>
          {settings.lutName && (
            <button className="link" onClick={() => apply(api.clearLut)}>
              Quitar
            </button>
          )}
        </div>
        <p className="status">
          {settings.lutName ? (
            <>
              Activa: <span className="mono">{settings.lutName}</span> ({settings.lutSize}³)
            </>
          ) : (
            "Sin LUT: los clips se exportan con su color original."
          )}
        </p>
      </section>

      <section className="panel setting">
        <h2>Biblioteca</h2>
        <p>Los videos importados se copian aquí, en una carpeta por día de grabación.</p>
        <div className="row">
          <span className="mono path">{settings.libraryDir}</span>
          <button className="secondary" onClick={pickLibrary}>
            Cambiar…
          </button>
        </div>
      </section>

      <section className="panel setting">
        <h2>Motor de video (ffmpeg)</h2>
        {settings.ffmpegError ? (
          <p className="warning">{settings.ffmpegError}</p>
        ) : (
          <p className="status">
            ffmpeg encontrado{settings.ffmpegDir ? ` en ${settings.ffmpegDir}` : " en el sistema"}.
          </p>
        )}
        {settings.hardware && (
          <p className="status">
            Aceleración ({hardwareName(settings.hardware.encoder)}): H.264 {settings.hardware.h264 ? "sí" : "no"} ·
            H.265 10 bits {settings.hardware.hevc ? "sí" : "no"}
          </p>
        )}
        <div className="row">
          <button className="secondary" onClick={pickFfmpeg}>
            Elegir carpeta de ffmpeg…
          </button>
          {settings.ffmpegDir && (
            <button className="link" onClick={() => apply(() => api.setFfmpegDir(null))}>
              Usar el del sistema
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
