# Galería de estilos

LUT 3D de 33 puntos, de Rec.709 a Rec.709, ordenadas por uso: Cine, Vívido,
Motos, Senderismo, Película y B/N. Se aplican después de la LUT de
conversión de la cámara (si el clip es LOG) y se pueden usar con menos
intensidad.

No son copias de paquetes comerciales: las genera `scripts/looks/generate.py`
a partir de recetas de colorista, y cualquiera puede regenerarlas:

```sh
python3 scripts/looks/generate.py --check
```

Los nombres de película («al estilo de Kodak 2383», «de Portra»…) describen la
intención del estilo; no son emulaciones medidas de esas películas.

## Cómo se construye cada estilo

1. Curva de contraste tipo película por canal, con pivote en el gris medio, pie
   y hombro suaves.
2. En Oklab (espacio perceptual):
   - saturación y vibrancia;
   - giros de tono por zonas;
   - densidad sustractiva: el color saturado se oscurece, como en película;
   - virado de sombras y de altas luces.
3. Se protege la piel: el centro de la zona protegida sale de los parches de piel
   de la carta ColorChecker (tono Oklab 44,7°), no de un número a ojo.
4. Vuelta al gamut Rec.709 con compresión suave, como la de ACES: baja el croma
   sin cambiar tono ni luminosidad y sin esquinas que hagan escalones en los
   degradados saturados.
5. Niveles de salida: negro de copia y blanco.

## Pruebas (`--check` falla si alguna no se cumple)

- **Luminancia del gris:** monótona, sin inversiones de tono.
- **Gris medio:** a menos de 0,06 de donde estaba, para no cambiar la exposición.
- **Cada canal:** crece con su entrada; tolerancia de 0,02 por paso de rejilla.
- **Suavidad:** segunda diferencia de 0,09 o menos en la rejilla. Las LUT oficiales
  de DJI llegan a 0,13 (D-Log M) y a 0,55 (D-Log2 vívido).
- **Piel:** gira 10° o menos.

## Resultados

En la tabla:

- **Tinte del gris** es el croma Oklab de la rampa de grises (0 = neutro). Es
  mayor en los estilos con virado intencional.
- **Piel** muestra el giro de tono y la diferencia ΔE (Oklab × 100) de los
  parches de piel.

| Categoría | Estilo | Gris medio (0,430) | Tinte del gris | Piel | Suavidad |
|---|---|---|---|---|---|
| Cine | Proyección | 0,429 | 0,025 | 7,6° · ΔE 2,9 | 0,068 |
| Cine | Blockbuster | 0,434 | 0,025 | 4,5° · ΔE 2,4 | 0,085 |
| Cine | Esmeralda | 0,428 | 0,020 | 5,5° · ΔE 2,4 | 0,051 |
| Cine | Medianoche | 0,429 | 0,027 | 6,0° · ΔE 2,2 | 0,057 |
| Cine | Cine suave | 0,432 | 0,009 | 1,8° · ΔE 0,9 | 0,032 |
| Cine | Bleach bypass | 0,427 | 0,007 | 5,9° · ΔE 4,7 | 0,016 |
| Vívido | Vívido | 0,430 | 0,000 | 1,4° · ΔE 1,9 | 0,089 |
| Vívido | Verano | 0,433 | 0,021 | 4,6° · ΔE 1,6 | 0,076 |
| Vívido | Aventura | 0,430 | 0,000 | 1,5° · ΔE 2,1 | 0,087 |
| Motos | Asfalto | 0,429 | 0,016 | 4,1° · ΔE 2,7 | 0,033 |
| Motos | Ruta | 0,429 | 0,021 | 5,3° · ΔE 2,7 | 0,082 |
| Motos | Neón | 0,433 | 0,023 | 5,3° · ΔE 2,8 | 0,062 |
| Senderismo | Bosque | 0,436 | 0,010 | 3,3° · ΔE 1,6 | 0,066 |
| Senderismo | Cumbre | 0,430 | 0,012 | 3,2° · ΔE 2,0 | 0,081 |
| Senderismo | Hora dorada | 0,433 | 0,033 | 5,5° · ΔE 1,6 | 0,076 |
| Senderismo | Nórdico | 0,432 | 0,016 | 2,0° · ΔE 1,2 | 0,032 |
| Película | Retrato | 0,439 | 0,024 | 5,0° · ΔE 1,0 | 0,042 |
| Película | Diapositiva | 0,429 | 0,015 | 3,7° · ΔE 2,7 | 0,041 |
| Película | Reportaje | 0,424 | 0,006 | 2,8° · ΔE 2,6 | 0,023 |
| Película | Paisaje | 0,434 | 0,006 | 2,6° · ΔE 1,9 | 0,082 |
| B/N | B/N clásico | 0,429 | 0,000 | — | 0,007 |
| B/N | B/N selenio | 0,431 | 0,016 | — | 0,015 |

Revisados además a ojo, aplicados con ffmpeg (`lut3d` tetraédrico, igual que la
exportación) sobre la suite Kodak de imágenes de prueba: retratos con piel clara
y oscura, loros, motos, montaña y granero.
