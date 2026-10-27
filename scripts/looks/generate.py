#!/usr/bin/env python3
"""Genera los estilos de la galería como LUT .cube de 33 puntos.

Cada estilo es una receta de operaciones de colorista sobre video Rec.709
(después de la LUT de conversión de la cámara, si el clip es LOG):

1. Curva de contraste tipo película, por canal, con pivote en el gris medio.
2. En Oklab (perceptual): saturación, vibrancia, giros de tono por zonas,
   densidad sustractiva (los colores saturados se oscurecen, como en
   película) y virado de sombras y altas luces.
3. La piel se protege: sus tonos casi no giran ni se saturan de más.
4. Vuelta al gamut reduciendo croma (sin cortar canales, sin cambiar tono)
   y niveles de salida (negro de copia y blanco).

`--check` mide cada LUT y falla si no cumple: monotonía, suavidad, rango,
gris medio, neutralidad y desplazamiento de la piel.

Uso: python3 scripts/looks/generate.py [--check] [--out DIR]
"""

import argparse
import math
import sys
from pathlib import Path

import numpy as np

SIZE = 33
GAMMA = 2.4  # Rec.709 en pantalla (BT.1886)
OUT = Path(__file__).resolve().parents[2] / "src-tauri" / "resources" / "looks"

# ---------------------------------------------------------------- Oklab

M1 = np.array([
    [0.4122214708, 0.5363325363, 0.0514459929],
    [0.2119034982, 0.6806995451, 0.1073969566],
    [0.0883024619, 0.2817188376, 0.6299787005],
])
M2 = np.array([
    [0.2104542553, 0.7936177850, -0.0040720468],
    [1.9779984951, -2.4285922050, 0.4505937099],
    [0.0259040371, 0.7827717662, -0.8086757660],
])
M1_INV = np.linalg.inv(M1)
M2_INV = np.linalg.inv(M2)


def to_oklab(lin):
    lms = np.cbrt(lin @ M1.T)
    return lms @ M2.T


def from_oklab(lab):
    lms = (lab @ M2_INV.T) ** 3
    return lms @ M1_INV.T


def decode(v):
    return np.clip(v, 0.0, 1.0) ** GAMMA


def encode(lin):
    return np.clip(lin, 0.0, 1.0) ** (1.0 / GAMMA)


def lch(lab):
    c = np.hypot(lab[..., 1], lab[..., 2])
    h = np.degrees(np.arctan2(lab[..., 2], lab[..., 1])) % 360.0
    return lab[..., 0], c, h


def from_lch(l, c, h):
    r = np.radians(h)
    return np.stack([l, c * np.cos(r), c * np.sin(r)], axis=-1)


def hue_dist(h, center):
    """Distancia angular con signo, en grados (-180..180)."""
    return (h - center + 180.0) % 360.0 - 180.0


def window(h, center, width):
    """Peso suave (gaussiano) alrededor de un tono."""
    return np.exp(-0.5 * (hue_dist(h, center) / width) ** 2)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


# Tonos de piel de la carta ColorChecker (sRGB, BabelColor): de aquí sale el
# centro de la zona protegida, en vez de un número a ojo.
CHECKER = {
    "piel oscura": (115, 82, 68),
    "piel clara": (194, 150, 130),
    "cielo": (98, 122, 157),
    "follaje": (87, 108, 67),
    "flor azul": (133, 128, 177),
    "verde azulado": (103, 189, 170),
    "naranja": (214, 126, 44),
    "azul morado": (80, 91, 166),
    "rojo moderado": (193, 90, 99),
    "morado": (94, 60, 108),
    "verde amarillo": (157, 188, 64),
    "amarillo naranja": (224, 163, 46),
    "azul": (56, 61, 150),
    "verde": (70, 148, 73),
    "rojo": (175, 54, 60),
    "amarillo": (231, 199, 31),
    "magenta": (187, 86, 149),
    "cian": (8, 133, 161),
}
SKIN = np.array([CHECKER["piel oscura"], CHECKER["piel clara"]]) / 255.0
SKIN_HUE = float(np.mean(lch(to_oklab(decode(SKIN)))[2]))
SKIN_WIDTH = 18.0

# ---------------------------------------------------------------- operaciones


def film_curve(v, contrast, pivot):
    """S por canal con pendiente `contrast` en el pivote; 0→0 y 1→1, con pie
    y hombro suaves (pendiente 0 en los extremos si contrast > 1)."""
    if contrast == 1.0:
        return v
    lo = pivot * (np.clip(v, 0, None) / pivot) ** contrast
    hi = 1.0 - (1.0 - pivot) * (np.clip(1.0 - v, 0, None) / (1.0 - pivot)) ** contrast
    return np.where(v < pivot, lo, hi)


def max_chroma(l, h):
    """Croma máximo dentro de Rec.709 para cada (L, tono)."""
    lo = np.zeros_like(l)
    hi = np.full_like(l, 0.5)
    for _ in range(22):
        mid = (lo + hi) / 2
        test = from_oklab(from_lch(l, mid, h))
        ok = np.all((test >= 0.0) & (test <= 1.0), axis=-1)
        lo = np.where(ok, mid, lo)
        hi = np.where(ok, hi, mid)
    return lo


def gamut_compress(lab, knee=0.75):
    """Lleva al gamut Rec.709 bajando croma con el mismo L y tono. Es suave
    (como la compresión de gamut de ACES): por debajo del `knee` del croma
    máximo no toca nada y, desde ahí, se acerca al borde sin llegar a una
    esquina, así los degradados saturados no hacen escalones."""
    l, c, h = lch(lab)
    l = np.clip(l, 0.0, 1.0)
    edge = max_chroma(l, h)
    start = knee * edge
    room = np.maximum(edge - start, 1e-6)
    over = np.maximum(c - start, 0.0)
    c = np.where(c > start, start + room * np.tanh(over / room), c)
    return from_lch(l, c, h)


def apply_look(rgb, p):
    """`rgb`: códigos Rec.709 (N×3, 0–1). `p`: receta del estilo."""
    v = rgb.copy()

    if p.get("mono"):
        w = np.array(p["mono"])
        y = decode(v) @ (w / w.sum())
        v = np.repeat(encode(y)[:, None], 3, axis=1)

    v = film_curve(v, p.get("contrast", 1.0), p.get("pivot", 0.43))
    lab = to_oklab(decode(v))
    l, c, h = lch(lab)
    skin = window(h, SKIN_HUE, SKIN_WIDTH) * smoothstep(0.015, 0.05, c)

    # Giros de tono por zonas: [(centro, ancho, giro en grados)].
    shift = np.zeros_like(h)
    for center, width, deg in p.get("hue", []):
        shift += deg * window(h, center, width)
    # Atraer tonos hacia un centro (teal & orange): [(centro, ancho, fuerza)].
    for center, width, k in p.get("attract", []):
        shift -= k * hue_dist(h, center) * window(h, center, width)
    # Un color que ya está en el borde del gamut casi no gira: girarlo hacia
    # un tono con menos espacio solo lo recortaría (`edge_guard`).
    guard = p.get("edge_guard", 0.0)
    if guard:
        edge = np.clip(c / np.maximum(max_chroma(np.clip(l, 0, 1), h), 1e-6), 0.0, 1.0)
        shift *= 1.0 - guard * edge * edge
    h = h + shift * (1.0 - p.get("skin_hue_guard", 0.8) * skin)

    # Saturación por zonas y global; la vibrancia sube más lo apagado.
    sat = np.full_like(c, p.get("sat", 1.0))
    for center, width, k in p.get("hue_sat", []):
        sat *= 1.0 + (k - 1.0) * window(h, center, width)
    vib = p.get("vibrance", 0.0)
    if vib:
        sat *= 1.0 + vib * (1.0 - smoothstep(0.0, 0.16, c))
    skin_sat = p.get("skin_sat")
    if skin_sat is not None:
        sat = sat + (skin_sat - sat) * skin
    # Menos color en negros y blancos profundos, como la película.
    sat *= 1.0 - p.get("extreme_desat", 0.0) * (1.0 - smoothstep(0.0, 0.25, l) * (1 - smoothstep(0.85, 1.0, l)))
    # Subir saturación solo donde hay espacio: lo que ya está en el borde
    # del gamut se queda (monótono en croma mientras sat < 2). Bajarla es
    # proporcional.
    room = np.clip(1.0 - c / np.maximum(max_chroma(np.clip(l, 0, 1), h), 1e-6), 0.0, 1.0)
    c = np.where(sat > 1.0, c * (1.0 + (sat - 1.0) * room), c * sat)

    # Límite suave de croma: nada de colores fosforescentes.
    cmax = p.get("chroma_limit", 0.26)
    c = cmax * np.tanh(c / cmax)

    # Densidad sustractiva: el color saturado pesa (se oscurece), en
    # proporción a su propia luz; así un azul (mucho croma, poca luz) no
    # baja al subir su entrada (monótono mientras density < 1.6).
    l = l * (1.0 - p.get("density", 0.0) * c * (1.0 - 0.5 * skin))
    lab = from_lch(l, c, h)

    # Virado: (a, b) que se suman en sombras y en altas luces.
    sh = np.array(p.get("shadows", (0.0, 0.0)))
    hl = np.array(p.get("highlights", (0.0, 0.0)))
    ws = (1.0 - smoothstep(0.08, 0.62, l))[:, None] * smoothstep(0.0, 0.12, l)[:, None]
    wh = smoothstep(0.45, 0.95, l)[:, None]
    lab[:, 1:] += ws * sh + wh * hl

    lab = gamut_compress(lab)
    v = encode(from_oklab(lab))

    black = p.get("black", 0.0)
    white = p.get("white", 1.0)
    v = black + (white - black) * v
    return np.clip(v, 0.0, 1.0)


# ---------------------------------------------------------------- estilos
# Hue en Oklab: rojo ≈ 29°, naranja ≈ 60°, amarillo ≈ 110°, verde ≈ 142°,
# cian ≈ 195°, azul ≈ 264°, magenta ≈ 328°. Piel ≈ SKIN_HUE.

LOOKS = {
    # Película de proyección de cine: contraste con hombro suave, sombras
    # cian, altas luces cálidas, colores densos y verdes hacia esmeralda.
    "proyeccion": dict(
        contrast=1.36, sat=1.0, density=1.0, extreme_desat=0.35,
        hue=[(142, 30, 14), (110, 20, -6), (29, 16, 6)],
        hue_sat=[(264, 40, 0.88), (142, 40, 0.88)],
        shadows=(-0.022, -0.016), highlights=(0.006, 0.024),
        skin_sat=1.0, black=0.014, white=0.98, chroma_limit=0.22,
    ),
    # Teal & orange: la piel y lo cálido hacia naranja, lo frío hacia
    # verde azulado, que es el complemento de la piel.
    "blockbuster": dict(
        contrast=1.26, sat=1.0, density=0.7, edge_guard=0.7,
        attract=[(62, 55, 0.35), (215, 45, 0.4)],
        hue_sat=[(215, 60, 1.35), (62, 30, 1.1), (110, 30, 0.7), (142, 35, 0.65), (330, 40, 0.7)],
        shadows=(-0.026, -0.008), highlights=(0.012, 0.020),
        skin_sat=1.04, black=0.008, chroma_limit=0.22,
    ),
    # Negativo de cine de bajo contraste: suave, poco saturado, sombras
    # verde azuladas, mucha latitud en las luces.
    "cine-suave": dict(
        contrast=1.12, sat=0.78, density=0.4,
        hue=[(142, 30, 14), (29, 16, -4)],
        hue_sat=[(29, 25, 0.95)],
        shadows=(-0.010, -0.002), highlights=(0.002, 0.006),
        skin_sat=0.9, black=0.03, white=0.965, chroma_limit=0.18,
    ),
    # Sin blanqueo: se queda la plata; mucho contraste y color lavado.
    "bleach-bypass": dict(
        contrast=1.5, sat=0.5, density=0.35, extreme_desat=0.3,
        shadows=(-0.004, -0.006), highlights=(0.0, 0.004),
        skin_sat=0.62, black=0.01, white=0.98, chroma_limit=0.16,
    ),
    # Negativo de retrato: cálido, pastel, piel favorecedora, verdes hacia
    # oliva, negros abiertos.
    "retrato": dict(
        contrast=1.1, sat=0.88, density=0.35,
        hue=[(142, 28, -12), (264, 30, -8), (29, 16, 4)],
        hue_sat=[(142, 35, 0.8), (264, 40, 0.88)],
        shadows=(0.0, -0.006), highlights=(0.008, 0.024),
        skin_sat=1.0, skin_hue_guard=0.9, black=0.035, white=0.975, chroma_limit=0.2,
    ),
    # Diapositiva de paisaje: mucho color y profundidad en cielos y verdes,
    # sin quemar la piel.
    "paisaje": dict(
        contrast=1.22, sat=1.25, vibrance=0.3, density=0.8,
        hue=[(142, 30, 6), (264, 30, -6)],
        hue_sat=[(142, 35, 1.12), (230, 40, 1.1), (29, 20, 1.05)],
        shadows=(0.0, -0.006),
        skin_sat=1.0, black=0.006, chroma_limit=0.25,
    ),
    # Reportaje: color sobrio y tonalidad dura; azules hacia cian y rojos
    # profundos. Para calle y viaje.
    "reportaje": dict(
        contrast=1.3, sat=0.72, density=0.75, extreme_desat=0.2,
        hue=[(264, 35, -14), (110, 22, -8)],
        hue_sat=[(264, 40, 0.65), (110, 25, 0.75), (142, 35, 0.8), (29, 18, 1.1)],
        shadows=(-0.006, -0.002), highlights=(0.002, 0.004),
        skin_sat=0.92, black=0.012, white=0.97, chroma_limit=0.2,
    ),
    # Diapositiva clásica: rojos ricos, azules profundos, luz cálida.
    "diapositiva": dict(
        contrast=1.28, sat=1.1, density=1.0,
        hue=[(29, 18, -4), (264, 30, 6), (142, 30, 8)],
        hue_sat=[(29, 20, 1.15), (264, 35, 1.12), (110, 22, 0.92)],
        shadows=(-0.002, -0.008), highlights=(0.006, 0.014),
        skin_sat=1.02, black=0.01, white=0.985, chroma_limit=0.23,
    ),
    # Aventura: natural pero con fuerza, para cámara de acción: cielos más
    # profundos, verdes vivos, piel intacta.
    "aventura": dict(
        contrast=1.2, sat=1.1, vibrance=0.45, density=0.7,
        hue=[(264, 28, -6), (142, 30, 4)],
        hue_sat=[(264, 40, 1.15), (142, 35, 1.12), (200, 40, 1.1)],
        skin_sat=1.0, chroma_limit=0.24,
    ),
    # Nórdico: frío y sobrio, verdes apagados hacia azul verdoso.
    "nordico": dict(
        contrast=1.14, sat=0.72, density=0.5,
        hue=[(142, 32, 18), (110, 22, 8)],
        hue_sat=[(142, 35, 0.75), (60, 30, 0.85)],
        shadows=(-0.010, -0.014), highlights=(-0.004, -0.006),
        skin_sat=0.9, black=0.018, white=0.98, chroma_limit=0.18,
    ),
    # Cine verde azulado: verdes y azules se funden en un mismo verde azulado
    # (sombras incluidas), amarillos hacia ámbar, magentas fuera. Suspenso.
    "esmeralda": dict(
        contrast=1.3, sat=0.86, density=0.8, edge_guard=0.6,
        hue=[(142, 35, 22), (264, 30, -16), (110, 22, -8)],
        hue_sat=[(180, 50, 1.15), (110, 25, 0.75), (330, 40, 0.7)],
        shadows=(-0.020, -0.006), highlights=(-0.002, 0.008),
        skin_sat=0.95, black=0.012, white=0.98, chroma_limit=0.2,
    ),
    # Noche de cine: sombras azules, luces de la calle cálidas, verdes fuera.
    "medianoche": dict(
        contrast=1.28, sat=0.82, density=0.6, edge_guard=0.6,
        hue=[(142, 30, 25), (110, 22, -6)],
        hue_sat=[(264, 45, 1.15), (60, 30, 1.05), (142, 35, 0.7)],
        shadows=(-0.010, -0.026), highlights=(0.004, 0.010),
        skin_sat=0.95, black=0.008, white=0.985, chroma_limit=0.2,
    ),
    # Vívido: color alto y limpio para redes, sin tocar la piel.
    "vivido": dict(
        contrast=1.18, sat=1.3, vibrance=0.4, density=0.6,
        hue=[(264, 28, -4)],
        skin_sat=1.04, chroma_limit=0.26,
    ),
    # Verano: vívido y cálido; agua turquesa, naranjas y sol dorado.
    "verano": dict(
        contrast=1.15, sat=1.18, vibrance=0.3, density=0.5, edge_guard=0.6,
        hue=[(110, 22, -6), (230, 40, -10)],
        hue_sat=[(200, 40, 1.2), (60, 30, 1.1)],
        shadows=(0.0, -0.004), highlights=(0.006, 0.020),
        skin_sat=1.02, black=0.006, chroma_limit=0.25,
    ),
    # Motoblog urbano: asfalto frío y duro, verdes y amarillos apagados, los
    # rojos y naranjas de la moto y el equipo destacan.
    "asfalto": dict(
        contrast=1.38, sat=0.8, density=0.8, extreme_desat=0.25, edge_guard=0.6,
        hue=[(142, 30, 18), (110, 22, -10), (264, 30, -10)],
        hue_sat=[(29, 22, 1.25), (60, 25, 1.1), (142, 35, 0.7), (110, 25, 0.7), (264, 40, 0.85)],
        shadows=(-0.012, -0.012), highlights=(0.002, 0.006),
        skin_sat=0.92, black=0.01, white=0.985, chroma_limit=0.21,
    ),
    # Carretera: cálido y con fuerza, cielo hacia cian, sombras verde
    # azuladas y luz dorada, de viaje en moto.
    "ruta": dict(
        contrast=1.32, sat=1.05, vibrance=0.2, density=0.9, edge_guard=0.8,
        hue=[(142, 30, 14), (264, 30, -12)],
        hue_sat=[(210, 45, 1.2), (60, 30, 1.12), (142, 35, 0.85)],
        shadows=(-0.016, -0.006), highlights=(0.008, 0.020),
        skin_sat=1.0, black=0.01, white=0.985, chroma_limit=0.23,
    ),
    # Noche en moto: negros profundos y azules, neones magenta y cian vivos.
    "neon": dict(
        contrast=1.32, sat=1.15, density=0.5, edge_guard=0.7,
        hue_sat=[(330, 40, 1.3), (200, 45, 1.3), (264, 40, 1.15)],
        shadows=(-0.008, -0.022), highlights=(0.004, 0.004),
        skin_sat=1.0, black=0.004, chroma_limit=0.25,
    ),
    # Bosque: verdes profundos hacia esmeralda, tierra cálida, sol suave.
    "bosque": dict(
        contrast=1.2, sat=1.05, vibrance=0.2, density=1.0, edge_guard=0.6,
        hue=[(142, 30, 12), (115, 18, 10)],
        hue_sat=[(150, 40, 1.15), (60, 25, 1.08)],
        shadows=(-0.010, -0.002), highlights=(0.003, 0.010),
        skin_sat=1.0, black=0.012, chroma_limit=0.23,
    ),
    # Cumbre: aire de montaña, nítido; cielo profundo, nieve limpia y fría.
    "cumbre": dict(
        contrast=1.22, sat=1.0, vibrance=0.25, density=0.7,
        hue=[(264, 30, -6)],
        hue_sat=[(240, 45, 1.2), (142, 35, 0.9), (110, 25, 0.85)],
        shadows=(-0.004, -0.012), highlights=(-0.002, -0.004),
        skin_sat=1.0, black=0.006, white=0.99, chroma_limit=0.24,
    ),
    # Hora dorada: amanecer o atardecer; luz cálida, sombras algo frías.
    "hora-dorada": dict(
        contrast=1.12, sat=1.08, density=0.6,
        hue=[(110, 22, -10)],
        hue_sat=[(60, 35, 1.18)],
        shadows=(0.002, -0.006), highlights=(0.012, 0.032),
        skin_sat=1.02, black=0.02, white=0.98, chroma_limit=0.22,
    ),
    # Blanco y negro pancromático de grano clásico: el rojo y el verde dan
    # el brillo, el cielo queda algo más oscuro; contraste firme.
    "bn-clasico": dict(
        mono=(0.36, 0.55, 0.09), contrast=1.38, black=0.01, white=0.985,
    ),
    # Blanco y negro suave con viraje al selenio (cálido en medios tonos).
    "bn-selenio": dict(
        mono=(0.30, 0.59, 0.11), contrast=1.14,
        shadows=(0.006, 0.0), highlights=(0.006, 0.016),
        black=0.025, white=0.97, chroma_limit=0.035,
    ),
}

# ---------------------------------------------------------------- .cube


def grid():
    t = np.linspace(0.0, 1.0, SIZE)
    # Orden .cube: el rojo cambia más rápido.
    b, g, r = np.meshgrid(t, t, t, indexing="ij")
    return np.stack([r.ravel(), g.ravel(), b.ravel()], axis=-1)


def write_cube(path, name, table):
    lines = [f'TITLE "ActionDeck {name}"', f"LUT_3D_SIZE {SIZE}", "DOMAIN_MIN 0 0 0", "DOMAIN_MAX 1 1 1"]
    lines += [f"{r:.5f} {g:.5f} {b:.5f}" for r, g, b in table]
    path.write_text("\n".join(lines) + "\n")


# ---------------------------------------------------------------- medición


def measure(name, p, table):
    """Devuelve (métricas, errores)."""
    cube = table.reshape(SIZE, SIZE, SIZE, 3)  # [b, g, r]
    errors = []
    m = {}

    # Gris: monotonía de luminancia y neutralidad.
    t = np.linspace(0, 1, 256)
    grey = np.stack([t, t, t], axis=-1)
    out = apply_look(grey, p)
    lum = to_oklab(decode(out))[:, 0]
    m["monotono"] = bool(np.all(np.diff(lum) > -1e-6))
    if not m["monotono"]:
        errors.append("la luminancia del gris no es monótona")
    _, gc, _ = lch(to_oklab(decode(out)))
    m["tinte_gris"] = float(gc.max())
    m["gris_medio"] = float(apply_look(np.array([[0.43, 0.43, 0.43]]), p)[0].mean())
    if abs(m["gris_medio"] - 0.43) > 0.06:
        errors.append(f"el gris medio se mueve a {m['gris_medio']:.3f}")

    # Cada canal debe crecer con su entrada (sin inversiones en la rejilla).
    d = [np.diff(cube[..., ch], axis=axis) for ch, axis in ((0, 2), (1, 1), (2, 0))]
    if not p.get("mono"):
        m["inversion"] = float(-min(x.min() for x in d))
        if m["inversion"] > 0.02:
            errors.append(f"un canal baja al subir su entrada ({m['inversion']:.3f})")

    # Suavidad: segunda diferencia a lo largo de cada eje.
    second = max(np.abs(np.diff(cube, n=2, axis=a)).max() for a in range(3))
    m["suavidad"] = float(second)
    if second > 0.09:
        errors.append(f"cambio brusco en la rejilla ({second:.3f})")

    # Piel: giro de tono y diferencia perceptual (ΔE en Oklab ×100).
    if not p.get("mono"):
        src = to_oklab(decode(SKIN))
        dst = to_oklab(decode(apply_look(SKIN, p)))
        _, _, h0 = lch(src)
        _, _, h1 = lch(dst)
        m["piel_giro"] = float(np.abs(hue_dist(h1, h0)).max())
        m["piel_dE"] = float(np.linalg.norm(dst - src, axis=-1).max() * 100)
        if m["piel_giro"] > 10:
            errors.append(f"la piel gira {m['piel_giro']:.1f}°")

    m["rango"] = (float(table.min()), float(table.max()))
    return m, errors


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="medir y fallar si algo no cumple")
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    print(f"piel: tono Oklab {SKIN_HUE:.1f}°")
    src = grid()
    failed = False
    for name, p in LOOKS.items():
        table = apply_look(src, p)
        write_cube(args.out / f"{name}.cube", name, table)
        m, errors = measure(name, p, table)
        piel = f"piel {m['piel_giro']:4.1f}° ΔE {m['piel_dE']:4.1f}" if "piel_giro" in m else "piel   —"
        print(
            f"{name:14} gris medio {m['gris_medio']:.3f}  tinte {m['tinte_gris']:.3f}  "
            f"{piel}  suavidad {m['suavidad']:.3f}  rango {m['rango'][0]:.3f}–{m['rango'][1]:.3f}"
        )
        for e in errors:
            print(f"  ✗ {e}")
        failed |= bool(errors)
    if args.check and failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
