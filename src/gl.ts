/**
 * Dibuja un video con WebGL2 aplicando, en la GPU y en tiempo real, la LUT
 * que recupera el color, un filtro (otra LUT) encima y, para los videos 360,
 * la vista que se elige arrastrando: el mismo resultado que la exportación.
 *
 * Los videos 360 llegan como "doble ojo de pez" (las dos lentes lado a lado,
 * como el `.LRF` de la Osmo 360): cada píxel de la vista se convierte en una
 * dirección, se busca en la lente que la ve y, cerca de la costura, se
 * mezclan las dos.
 */

import { api, type View360 } from "./api";

export type { View360 };

export type Lut3D = { size: number; data: Float32Array };

export const DEFAULT_VIEW: View360 = { yaw: 0, pitch: 0, roll: 0, fov: 100, mode: "flat" };
export const PLANET_VIEW: View360 = { yaw: 0, pitch: -90, roll: 0, fov: 260, mode: "planet" };

/** Campo de visión de cada lente de la Osmo 360 (grados), el que usa también la exportación. */
export const LENS_FOV = 195;

const VERTEX = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler2D u_video;
uniform sampler3D u_lut;
uniform sampler3D u_look;
uniform float u_lutSize;
uniform float u_lookSize;
uniform float u_lookAmount;  // intensidad del filtro (0–1)
uniform int u_mode;          // 0 plano, 1 360 rectilíneo, 2 pequeño planeta
uniform mat3 u_rot;
uniform vec2 u_tan;          // tangente de medio campo de visión (h, v)
uniform float u_lensHalf;    // medio campo de visión de cada lente (radianes)
in vec2 v_uv;
out vec4 outColor;

const float PI = 3.14159265;
const float SEAM = 0.06;     // ancho de la mezcla en la costura (radianes)

vec3 lut(sampler3D s, float n, vec3 c) {
  vec3 coord = clamp(c, 0.0, 1.0) * ((n - 1.0) / n) + 0.5 / n;
  return texture(s, coord).rgb;
}

// Píxel de la lente que ve la dirección d (x der., y abajo, z al frente).
// Como en el v360 de ffmpeg (y en la exportación), el frente es la mitad
// derecha del cuadro (pista 1 del .OSV) y la trasera, la izquierda, en espejo.
vec3 lens(vec3 d, float back) {
  vec3 l = back > 0.5 ? vec3(-d.x, d.y, -d.z) : d;
  float theta = acos(clamp(l.z, -1.0, 1.0));
  float r = 0.5 * theta / u_lensHalf;
  float h = length(l.xy);
  vec2 dir = h > 1e-6 ? l.xy / h : vec2(0.0);
  vec2 p = vec2(0.5) + r * dir;
  return texture(u_video, vec2((p.x + 1.0 - back) * 0.5, p.y)).rgb;
}

vec3 sphere(vec3 d) {
  float theta = acos(clamp(d.z, -1.0, 1.0));
  // 1 = solo la delantera, 0 = solo la trasera, mezcla alrededor de los 90°.
  float w = smoothstep(PI * 0.5 + SEAM, PI * 0.5 - SEAM, theta);
  if (w >= 1.0) return lens(d, 0.0);
  if (w <= 0.0) return lens(d, 1.0);
  return mix(lens(d, 1.0), lens(d, 0.0), w);
}

void main() {
  vec3 c;
  vec2 xy = vec2(v_uv.x * 2.0 - 1.0, v_uv.y * 2.0 - 1.0) * u_tan;
  if (u_mode == 0) {
    c = texture(u_video, v_uv).rgb;
  } else if (u_mode == 1) {
    c = sphere(u_rot * normalize(vec3(xy, 1.0)));
  } else {
    // Proyección estereográfica: el horizonte se curva en un pequeño planeta.
    float r2 = dot(xy, xy);
    vec3 ray = vec3(2.0 * xy, 1.0 - r2) / (1.0 + r2);
    c = sphere(u_rot * ray);
  }
  if (u_lutSize > 0.0) c = lut(u_lut, u_lutSize, c);
  if (u_lookSize > 0.0) c = mix(c, lut(u_look, u_lookSize, c), u_lookAmount);
  outColor = vec4(c, 1.0);
}`;

/** Lee una LUT `.cube` (orden: rojo el que cambia más rápido, como en la textura 3D). */
export function parseCube(text: string): Lut3D {
  let size = 0;
  const values: number[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("LUT_3D_SIZE")) {
      size = Number(line.split(/\s+/)[1]);
      continue;
    }
    const parts = line.split(/\s+/);
    if (parts.length !== 3) continue;
    const r = Number(parts[0]);
    if (Number.isNaN(r)) continue;
    values.push(r, Number(parts[1]), Number(parts[2]), 1);
  }
  if (!size || values.length !== size * size * size * 4) throw new Error("LUT .cube incompleta");
  return { size, data: new Float32Array(values) };
}

function rotation(view: View360): number[] {
  const rad = Math.PI / 180;
  const [y, p, r] = [view.yaw * rad, view.pitch * rad, view.roll * rad];
  // Mirar a la derecha (yaw) gira sobre y; hacia arriba (pitch) sobre x; inclinar (roll) sobre z.
  const ry = [Math.cos(y), 0, -Math.sin(y), 0, 1, 0, Math.sin(y), 0, Math.cos(y)];
  const rx = [1, 0, 0, 0, Math.cos(p), Math.sin(p), 0, -Math.sin(p), Math.cos(p)];
  const rz = [Math.cos(r), Math.sin(r), 0, -Math.sin(r), Math.cos(r), 0, 0, 0, 1];
  return multiply(multiply(ry, rx), rz);
}

/** Producto de matrices 3×3 en orden de columnas, como las espera WebGL. */
function multiply(a: number[], b: number[]): number[] {
  const out = new Array(9).fill(0);
  for (let col = 0; col < 3; col++)
    for (let row = 0; row < 3; row++)
      for (let k = 0; k < 3; k++) out[col * 3 + row] += a[k * 3 + row] * b[col * 3 + k];
  return out;
}

let webgl2: boolean | null = null;

export class VideoRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private video: WebGLTexture;
  private luts: [WebGLTexture, WebGLTexture];
  private sizes: [number, number] = [0, 0];
  private loaded: [Lut3D | null, Lut3D | null] = [null, null];
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  view: View360 | null = null;
  /** Intensidad del filtro: 0 = sin él, 1 = completo. */
  lookAmount = 1;
  /** Cómo cabe un video normal en el lienzo, como `object-fit`. */
  fit: "contain" | "cover" = "contain";

  /**
   * Si hay WebGL2. Se averigua una sola vez y se suelta el contexto de
   * prueba: el navegador admite pocos (unos 16) y, al pasarse, le quita el
   * suyo al más viejo, que suele ser el del video que se está viendo.
   */
  static supported(): boolean {
    if (webgl2 === null) {
      try {
        const gl = document.createElement("canvas").getContext("webgl2");
        webgl2 = !!gl;
        gl?.getExtension("WEBGL_lose_context")?.loseContext();
      } catch {
        webgl2 = false;
      }
    }
    return webgl2;
  }

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL2 no disponible");
    this.gl = gl;
    this.program = link(gl, VERTEX, FRAGMENT);
    gl.useProgram(this.program);
    for (const name of ["u_video", "u_lut", "u_look", "u_lutSize", "u_lookSize", "u_lookAmount", "u_mode", "u_rot", "u_tan", "u_lensHalf"]) {
      this.uniforms[name] = gl.getUniformLocation(this.program, name);
    }
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(this.program, "a_pos");
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);

    this.video = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.video);
    for (const [k, v] of [
      [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
      [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
      [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
    ])
      gl.texParameteri(gl.TEXTURE_2D, k, v);

    this.luts = [this.lutTexture(1), this.lutTexture(2)];
    gl.uniform1i(this.uniforms.u_video, 0);
    gl.uniform1i(this.uniforms.u_lut, 1);
    gl.uniform1i(this.uniforms.u_look, 2);
    gl.uniform1f(this.uniforms.u_lensHalf, ((LENS_FOV / 2) * Math.PI) / 180);
  }

  private lutTexture(unit: number): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_3D, tex);
    for (const [k, v] of [
      [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
      [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
      [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
      [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE],
    ])
      gl.texParameteri(gl.TEXTURE_3D, k, v);
    // Una LUT de 1 píxel mientras no haya otra, para que el muestreador sea válido.
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, 1, 1, 1, 0, gl.RGBA, gl.FLOAT, new Float32Array([0, 0, 0, 1]));
    return tex;
  }

  /** La LUT de conversión (0) o el filtro (1); `null` los quita. */
  setLut(slot: 0 | 1, lut: Lut3D | null) {
    if (this.loaded[slot] === lut) return;
    this.loaded[slot] = lut;
    this.sizes[slot] = lut?.size ?? 0;
    if (!lut) return;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1 + slot);
    gl.bindTexture(gl.TEXTURE_3D, this.luts[slot]);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, lut.size, lut.size, lut.size, 0, gl.RGBA, gl.FLOAT, lut.data);
  }

  /** Dibuja el cuadro actual. `false` si el video todavía no tiene imagen. */
  draw(source: TexImageSource & { videoWidth?: number }): boolean {
    if ("videoWidth" in source && !source.videoWidth) return false;
    const gl = this.gl;
    const { width, height } = this.canvas;
    const view = this.view;
    // Un video normal conserva su proporción; un 360 llena el lienzo con la vista.
    const vw = "videoWidth" in source && source.videoWidth ? source.videoWidth : width;
    const vh = "videoHeight" in source && (source as HTMLVideoElement).videoHeight ? (source as HTMLVideoElement).videoHeight : height;
    const scale = view ? 0 : this.fit === "contain" ? Math.min(width / vw, height / vh) : Math.max(width / vw, height / vh);
    const [w, h] = view ? [width, height] : [Math.round(vw * scale), Math.round(vh * scale)];
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.viewport(Math.round((width - w) / 2), Math.round((height - h) / 2), w, h);
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.video);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } catch {
      return false;
    }
    gl.uniform1f(this.uniforms.u_lutSize, this.sizes[0]);
    gl.uniform1f(this.uniforms.u_lookSize, this.sizes[1]);
    gl.uniform1f(this.uniforms.u_lookAmount, Math.min(1, Math.max(0, this.lookAmount)));
    gl.uniform1i(this.uniforms.u_mode, !view ? 0 : view.mode === "planet" ? 2 : 1);
    if (view) {
      const aspect = width / height;
      if (view.mode === "planet") {
        // En la estereográfica el "campo" se reparte con tan(fov/4).
        const t = Math.tan(((view.fov / 4) * Math.PI) / 180);
        gl.uniform2f(this.uniforms.u_tan, t, t / aspect);
      } else {
        const t = Math.tan(((Math.min(view.fov, 170) / 2) * Math.PI) / 180);
        gl.uniform2f(this.uniforms.u_tan, t, t / aspect);
      }
      gl.uniformMatrix3fv(this.uniforms.u_rot, false, rotation(view));
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return true;
  }

  /**
   * Libera lo que ocupa en la GPU. `discard` también suelta el contexto: solo
   * para lienzos que se tiran (uno perdido no vuelve a servir, y React puede
   * montar dos veces el mismo lienzo).
   */
  dispose(discard = false) {
    const gl = this.gl;
    gl.deleteTexture(this.video);
    this.luts.forEach((t) => gl.deleteTexture(t));
    gl.deleteProgram(this.program);
    if (discard) gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const compile = (type: number, src: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "shader");
    return shader;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "programa");
  return program;
}

const cache = new Map<string, Promise<Lut3D>>();

/** Lee una LUT por su ID una sola vez y la guarda para el resto de la sesión. */
export function loadLut(id: string): Promise<Lut3D> {
  let pending = cache.get(id);
  if (!pending) {
    pending = api.lutFile(id).then((buffer) => parseCube(new TextDecoder().decode(buffer)));
    pending.catch(() => cache.delete(id));
    cache.set(id, pending);
  }
  return pending;
}

/** Límites del campo de visión según el modo. */
export function clampFov(view: View360, fov: number): number {
  return view.mode === "planet" ? Math.min(330, Math.max(120, fov)) : Math.min(150, Math.max(30, fov));
}
