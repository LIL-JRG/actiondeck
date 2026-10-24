import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  errorText,
  onImportProgress,
  onNearbyCameras,
  onWirelessClosed,
  onWirelessPhase,
  type ImportProgress,
  type ImportSummary,
  type MediaFile,
  type Nearby,
  type NearbyCamera,
} from "./api";

/** La conexión por Wi-Fi con la cámara. */
export type Link =
  | { status: "idle" }
  | { status: "connecting"; camera: NearbyCamera }
  | { status: "connected"; camera: NearbyCamera; files: MediaFile[] }
  | { status: "failed"; camera: NearbyCamera; error: string };

/** Pasos de la conexión, en orden, para la barra de avance de la hoja. */
const PHASES: [prefix: string, progress: number][] = [
  ["Buscando la cámara", 0.12],
  ["Despertando", 0.28],
  ["Acepta la conexión", 0.38],
  ["Uniéndome a la red", 0.58],
  ["Leyendo la lista", 0.86],
];

export function phaseProgress(phase: string): number {
  return PHASES.find(([prefix]) => phase.startsWith(prefix))?.[1] ?? 0.06;
}

export function needsApproval(phase: string): boolean {
  return phase.startsWith("Acepta la conexión");
}

/**
 * Cámaras cerca (por Bluetooth) y la conexión por Wi-Fi. `arrived` es la
 * cámara que se acaba de encender: la app abre la hoja de conexión sola, como
 * Mimo, una vez por encendido.
 */
export function useCamera() {
  const [nearby, setNearby] = useState<Nearby>({ bluetoothError: null, cameras: [] });
  const [arrived, setArrived] = useState<NearbyCamera | null>(null);
  const [link, setLink] = useState<Link>({ status: "idle" });
  const [phase, setPhase] = useState("");
  const present = useRef<Set<string>>(new Set());

  useEffect(() => {
    const update = (next: Nearby) => {
      const fresh = next.cameras.find((c) => !present.current.has(c.id));
      present.current = new Set(next.cameras.map((c) => c.id));
      setNearby(next);
      if (fresh) setArrived(fresh);
    };
    api.nearbyCameras().then(update).catch(() => {});
    const pending = [
      onNearbyCameras(update),
      onWirelessPhase(setPhase),
      // Al salir de la red de la cámara (desconectar, apagarla, terminar de
      // importar) sus archivos ya no se pueden ver ni bajar.
      onWirelessClosed(() => setLink({ status: "idle" })),
    ];
    return () => {
      pending.forEach((p) => p.then((unlisten) => unlisten()));
    };
  }, []);

  const connect = useCallback(async (camera: NearbyCamera) => {
    setLink({ status: "connecting", camera });
    try {
      const files = await api.wirelessConnect();
      setLink({ status: "connected", camera, files });
      return true;
    } catch (e) {
      setLink({ status: "failed", camera, error: errorText(e) });
      return false;
    }
  }, []);

  const disconnect = useCallback(() => api.wirelessDisconnect(), []);
  const forgetArrival = useCallback(() => setArrived(null), []);
  const resetFailure = useCallback(() => setLink((l) => (l.status === "failed" ? { status: "idle" } : l)), []);

  return { nearby, arrived, forgetArrival, link, phase, connect, disconnect, resetFailure };
}

export type Camera = ReturnType<typeof useCamera>;

/** Copia a la biblioteca, desde una unidad o por Wi-Fi. Vive en la app para no perderse al cambiar de pantalla. */
export function useImporter(onDone: () => void, onError: (message: string) => void) {
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  useEffect(() => {
    const pending = onImportProgress(setProgress);
    return () => {
      pending.then((unlisten) => unlisten());
    };
  }, []);

  const run = useCallback(
    async (paths: string[], wireless: boolean): Promise<ImportSummary | null> => {
      setRunning(true);
      setSummary(null);
      setProgress(null);
      try {
        const result = wireless ? await api.wirelessImport(paths) : await api.startImport(paths);
        setSummary(result);
        onDone();
        return result;
      } catch (e) {
        onError(errorText(e));
        return null;
      } finally {
        setRunning(false);
      }
    },
    [onDone, onError],
  );

  const dismiss = useCallback(() => setSummary(null), []);
  return { progress, running, summary, run, cancel: api.cancelImport, dismiss };
}

export type Importer = ReturnType<typeof useImporter>;
