import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { NearbyCamera } from "./api";
import { needsApproval, phaseProgress, type Camera } from "./camera";
import { CheckIcon } from "./icons";
import { Sheet } from "./Sheet";

type Props = {
  open: boolean;
  onClose: () => void;
  camera: Camera;
  /** Ya conectada: ir a sus archivos. */
  onShowFiles: () => void;
};

export type View = "searching" | "found" | "connecting" | "approval" | "connected" | "failed";

/**
 * La hoja que sube sola cuando se enciende una cámara, como la de Mimo:
 * reconoce el modelo, ofrece conectarse y muestra cada paso hasta que sus
 * archivos están listos.
 */
export function DeviceSheet({ open, onClose, camera, onShowFiles }: Props) {
  const { link, nearby, arrived, phase } = camera;
  const target: NearbyCamera | null = link.status !== "idle" ? link.camera : (arrived ?? nearby.cameras[0] ?? null);
  const view: View =
    link.status === "connecting"
      ? needsApproval(phase)
        ? "approval"
        : "connecting"
      : link.status === "connected"
        ? "connected"
        : link.status === "failed"
          ? "failed"
          : target
            ? "found"
            : "searching";

  // Al conectarse con la hoja abierta, muestra el ✓ un momento y lleva a los archivos.
  const wasConnecting = useRef(false);
  useEffect(() => {
    if (view === "connecting" || view === "approval") wasConnecting.current = true;
    else if (view === "connected" && wasConnecting.current && open) {
      wasConnecting.current = false;
      const timer = window.setTimeout(onShowFiles, 1100);
      return () => window.clearTimeout(timer);
    } else wasConnecting.current = false;
  }, [view, open, onShowFiles]);

  const connect = () => target && camera.connect(target);
  const progress = view === "connected" ? 1 : phaseProgress(phase);

  const title = view === "searching" ? "Buscando cámaras" : target?.name;
  const status: Record<View, string> = {
    searching: nearby.bluetoothError ?? "Enciende tu cámara y acércala a la computadora.",
    found: `${target?.model ?? "Cámara"} encendida cerca`,
    connecting: phase || "Conectando…",
    approval: "Acepta la conexión en la pantalla de la cámara",
    connected: link.status === "connected" ? `Conectado · ${link.files.length} archivos en la cámara` : "Conectado",
    failed: link.status === "failed" ? link.error : "",
  };

  return (
    <Sheet open={open} onClose={onClose} tone="light" className="device-sheet" label="Cámara">
      <AnimatePresence mode="wait" initial={false}>
        <motion.h2
          key={title}
          className="device-title"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.2 }}
        >
          {title}
        </motion.h2>
      </AnimatePresence>

      <div className="device-art">
        <CameraArt view={view} />
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.p
          key={view + status[view]}
          className={view === "failed" ? "device-status error" : view === "approval" ? "device-status strong" : "device-status"}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.2 }}
        >
          {status[view]}
          {view === "approval" && <span className="device-sub">Tienes unos 20 segundos</span>}
        </motion.p>
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {(view === "connecting" || view === "approval" || view === "connected") && (
          <motion.div
            className="device-bar"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 10 }}
            exit={{ opacity: 0, height: 0 }}
          >
            <motion.div
              className="device-bar-fill"
              initial={{ width: "4%" }}
              animate={{ width: `${progress * 100}%` }}
              transition={{ type: "spring", stiffness: 60, damping: 20 }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <div className="device-actions">
        {view === "found" && (
          <>
            <button className="pill dark large wide" onClick={connect}>
              Conectar
            </button>
            <p className="device-note">
              Para ver y bajar tus videos, la computadora se une a la red Wi-Fi de la cámara. Mientras tanto no tiene
              internet por Wi-Fi.
            </p>
            <button className="pill ghost-dark" onClick={onClose}>
              Ahora no
            </button>
          </>
        )}
        {(view === "connecting" || view === "approval") && (
          <button className="pill ghost-dark" onClick={onClose}>
            Seguir en segundo plano
          </button>
        )}
        {view === "connected" && (
          <>
            <button className="pill dark large wide" onClick={onShowFiles}>
              Ver archivos
            </button>
            <button className="pill ghost-dark" onClick={() => camera.disconnect()}>
              Desconectar
            </button>
          </>
        )}
        {view === "failed" && (
          <>
            <button className="pill dark large wide" onClick={connect}>
              Reintentar
            </button>
            <button
              className="pill ghost-dark"
              onClick={() => {
                camera.resetFailure();
                onClose();
              }}
            >
              Cerrar
            </button>
          </>
        )}
        {view === "searching" && (
          <>
            <p className="device-note">
              Se detecta sola por Bluetooth al encenderla. Si la conectas por USB-C, sus archivos aparecen en Álbum ›
              Dispositivo.
            </p>
            <button className="pill ghost-dark" onClick={onClose}>
              Cerrar
            </button>
          </>
        )}
      </div>
    </Sheet>
  );
}

/**
 * Una cámara de acción dibujada (no es la foto del producto): flota, emite
 * ondas mientras busca, arcos de Wi-Fi mientras se conecta y un ✓ al final.
 */
export function CameraArt({ view, size = 300 }: { view: View | "idle"; size?: number }) {
  const on = view !== "searching" && view !== "idle";
  return (
    <div className="camera-art" style={{ width: size, height: size * 0.72 }}>
      {/* Las ondas se repiten sin fin; el contenedor es el que se desvanece al salir. */}
      <AnimatePresence>
        {view === "searching" && (
          <motion.div className="art-rings" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            {[0, 1, 2].map((i) => (
              <motion.span
                key={i}
                className="art-ring"
                initial={{ scale: 0.5, opacity: 0 }}
                animate={{ scale: 1.6, opacity: [0, 0.5, 0] }}
                transition={{ duration: 3, repeat: Infinity, delay: i, ease: "easeOut" }}
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      <motion.div
        className="art-float"
        animate={{ y: [0, -7, 0] }}
        transition={{ duration: 3.4, repeat: Infinity, ease: "easeInOut" }}
      >
        <svg viewBox="0 0 320 220" width="100%" height="100%" aria-hidden="true">
          <defs>
            <linearGradient id="art-body" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#4b4b4f" />
              <stop offset="0.5" stopColor="#2c2c30" />
              <stop offset="1" stopColor="#1b1b1e" />
            </linearGradient>
            <linearGradient id="art-screen" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#3d7bff" />
              <stop offset="1" stopColor="#0d2d77" />
            </linearGradient>
            <radialGradient id="art-glass" cx="0.38" cy="0.35" r="0.75">
              <stop offset="0" stopColor="#4a5568" />
              <stop offset="0.45" stopColor="#151a24" />
              <stop offset="1" stopColor="#030405" />
            </radialGradient>
            <filter id="art-soft" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="0.6" />
            </filter>
          </defs>

          {/* Soportes laterales */}
          <path d="M78 82c-30 0-44 14-44 34s14 34 44 34" fill="none" stroke="#dedede" strokeWidth="14" strokeLinecap="round" />
          <path d="M242 82c30 0 44 14 44 34s-14 34-44 34" fill="none" stroke="#dedede" strokeWidth="14" strokeLinecap="round" />

          {/* Cuerpo */}
          <rect x="66" y="46" width="188" height="132" rx="24" fill="url(#art-body)" />
          <rect x="66" y="46" width="188" height="132" rx="24" fill="none" stroke="#5c5c61" strokeOpacity="0.6" />
          <path d="M90 47h140" stroke="#8a8a90" strokeOpacity="0.5" strokeWidth="1.5" strokeLinecap="round" />
          <rect x="226" y="40" width="20" height="7" rx="3.5" fill="#3a3a3e" />
          <rect x="70" y="160" width="180" height="16" rx="8" fill="#141416" opacity="0.7" />

          {/* Pantalla frontal */}
          <rect x="82" y="64" width="80" height="92" rx="11" fill="#0b0b0d" />
          <motion.rect
            x="87"
            y="69"
            width="70"
            height="82"
            rx="7"
            fill={on ? "url(#art-screen)" : "#141418"}
            animate={view === "approval" ? { opacity: [1, 0.55, 1] } : { opacity: 1 }}
            transition={view === "approval" ? { duration: 1.1, repeat: Infinity } : { duration: 0.3 }}
          />
          {on && view !== "approval" && (
            <g fill="#fff" fontFamily="-apple-system, system-ui, sans-serif" fontWeight="600">
              <text x="93" y="81" fontSize="7" opacity="0.9">
                1h03m
              </text>
              <rect x="140" y="75" width="11" height="6" rx="1.5" fill="none" stroke="#fff" strokeWidth="1" />
              <rect x="141.5" y="76.5" width="6" height="3" rx="0.5" />
              <text x="93" y="144" fontSize="7" opacity="0.9">
                4K60
              </text>
              <circle cx="146" cy="141.5" r="3" fill="#ff453a" />
            </g>
          )}
          {view === "approval" && (
            <g stroke="#fff" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="122" cy="110" r="16" strokeOpacity="0.9" />
              <path d="m114 110 6 6 10-11" />
            </g>
          )}

          {/* Lente */}
          <circle cx="206" cy="108" r="44" fill="#232326" />
          <circle cx="206" cy="108" r="44" fill="none" stroke="#3b3b40" strokeWidth="2" />
          <circle cx="206" cy="108" r="37" fill="#101012" />
          <circle cx="206" cy="108" r="32" fill="none" stroke="#d6312b" strokeWidth="2.2" />
          <circle cx="206" cy="108" r="26" fill="url(#art-glass)" />
          <ellipse cx="197" cy="98" rx="8" ry="5" fill="#fff" opacity="0.28" filter="url(#art-soft)" transform="rotate(-30 197 98)" />
          <circle cx="213" cy="116" r="2.2" fill="#fff" opacity="0.18" />
        </svg>

        <AnimatePresence>
          {(view === "connecting" || view === "approval") && (
            <motion.div className="art-wifi" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              {[0, 1, 2].map((i) => (
                <motion.span
                  key={i}
                  className={`arc arc-${i}`}
                  animate={{ opacity: [0.15, 1, 0.15] }}
                  transition={{ duration: 1.4, repeat: Infinity, delay: i * 0.22 }}
                />
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {view === "connected" && (
            <motion.span
              className="art-check"
              initial={{ scale: 0, rotate: -30 }}
              animate={{ scale: 1, rotate: 0 }}
              exit={{ scale: 0 }}
              transition={{ type: "spring", stiffness: 480, damping: 20 }}
            >
              <CheckIcon size={26} strokeWidth={2.6} />
            </motion.span>
          )}
        </AnimatePresence>
      </motion.div>

      <motion.span
        className="art-shadow"
        animate={{ scaleX: [1, 0.86, 1], opacity: [0.5, 0.32, 0.5] }}
        transition={{ duration: 3.4, repeat: Infinity, ease: "easeInOut" }}
      />
    </div>
  );
}
