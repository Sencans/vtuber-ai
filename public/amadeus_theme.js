// VTuber AI Studio — tema visual «Amadeus» (homenaje de fan a Makise Kurisu, STEINS;GATE 0).
//
// Sin assets ni logos oficiales: todo es procedural (paleta, corbata, medias, rim, scanlines y un
// marco CSS de «videollamada holograma» con texto propio). Módulo ESM sin dependencias: NO importa
// three; recibe el namespace en `opciones.THREE` (el mismo que ya importó app.js).
//
// Contrato (docs/COMPANION.md §C2.6 de R.A.M.S.):
//   AMADEUS_PALETA, clasificarMaterial(nombre), aplicarTemaAmadeus(vrm, opciones) → { update(t), dispose() }
//
// Uso (dentro de loadModel, tras avatarRoot.add(vrm.scene) y ANTES del primer render):
//   const tema = aplicarTemaAmadeus(vrm, { THREE, rim, scanlines, escena: scene, avatarRoot, modoEscritorio });
//   ...en cada frame: tema.update(t)   ...al recargar el modelo: tema.dispose()
//
// Nunca lanza: cada paso va en su propio try/catch y, si algo falta (canvas en Node, ImageBitmap
// cerrado, huesos ausentes, materiales que no son MToon), ese paso se omite y el resto sigue.

/** Paleta de Kurisu/Amadeus (sRGB '#rrggbb'). Las listas van de oscuro a claro (gradient map). */
export const AMADEUS_PALETA = Object.freeze({
  hair: Object.freeze(['#2e140b', '#4b2718', '#803d23', '#a14c2d', '#c06a42']),
  iris: Object.freeze(['#1e1626', '#453450', '#8378ba', '#9883b7', '#c9bde0']),
  boots: Object.freeze(['#0d0b0b', '#1a1616', '#2a2424', '#463e3e']),
  skinShade: '#e8c4a8',
  coatShade: '#d7e6e2',
  tights: '#3a2a24',
  tie: '#ae1927',
  tieShade: '#6e0f17',
  rim: '#ff9a3c',
});

// ===================================================================== clasificación de materiales

const SUFIJOS = /\s*\((?:outline|instance|clone|copy)\)\s*/gi;   // ' (Outline)', ' (Instance)'…
const PREFIJO_VROID = /^N\d+(?:_\d+)*_/i;                          // 'N00_000_00_' de VRoid Studio
const SEPARADORES = /[\s_.:|-]+/;

const RE_IRIS = /^(?:EyeIris|Iris)\d*$/i;
const RE_CAT_HAIR = /^HAIR$/i;
const RE_PARTE_HAIR = /^Hair(?:Back|Front|Side|Top|Tail|Ahoge)?\d*$/i;
const RE_CAT_EYE = /^EYE$/i;
const RE_PARTE_EYE = /^Eye(?!line|lash|brow)/i;
const RE_SOCKS = /^(?:Socks?|Tights|Stockings?|Legwear|Pantyhose)\d*$/i;
const RE_SHOES = /^(?:Shoes?|Boots?)\d*$/i;
const RE_BOTTOMS = /^(?:Bottoms?|Skirt|Pants|Shorts|Trousers)\d*$/i;
const RE_TOPS = /^(?:Tops?|Onepiece|Coat|Jacket|Shirt|Blouse)\d*$/i;
const RE_SKIN = /^SKIN$/i;

/**
 * Clasifica un material VRM por su nombre (regex sobre las partes del nombre, no sobre el nombre
 * completo). Tolera los sufijos ' (Outline)' / ' (Instance)' y el prefijo 'N00_000_00_' de VRoid.
 * @param {string} nombre p. ej. 'Hair_00_HAIR (Outline)', 'N00_000_00_EyeIris_00_EYE (Instance)'
 * @returns {'hair'|'skin'|'eye'|'iris'|'tops'|'bottoms'|'shoes'|'socks'|null}
 */
export function clasificarMaterial(nombre) {
  if (typeof nombre !== 'string' || !nombre.trim()) return null;
  const base = nombre.replace(SUFIJOS, ' ').trim().replace(PREFIJO_VROID, '');
  const partes = base.split(SEPARADORES).filter(Boolean);
  if (!partes.length) return null;
  const hay = (re) => partes.some((p) => re.test(p));
  const primera = partes[0];
  if (hay(RE_IRIS)) return 'iris';
  if (hay(RE_CAT_HAIR) || RE_PARTE_HAIR.test(primera)) return 'hair';
  if (hay(RE_CAT_EYE) || RE_PARTE_EYE.test(primera)) return 'eye';
  if (hay(RE_SOCKS)) return 'socks';
  if (hay(RE_SHOES)) return 'shoes';
  if (hay(RE_BOTTOMS)) return 'bottoms';
  if (hay(RE_TOPS)) return 'tops';
  if (hay(RE_SKIN)) return 'skin';
  return null;
}

// ===================================================================== utilidades puras

const AVISO = '[amadeus]';
function aviso(...args) {
  try { console.warn(AVISO, ...args); } catch { /* consola no disponible */ }
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const suave = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const hexARgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const rgbAHex = (c) => `#${c.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('')}`;
/** Mezcla lineal en sRGB de dos colores '#rrggbb' (k = 0 → a, k = 1 → b). */
const mezclar = (a, b, k) => { const A = hexARgb(a), B = hexARgb(b); return rgbAHex(A.map((v, i) => v + (B[i] - v) * k)); };

const LADO_MAX = 4096;          // tope del lienzo de trabajo (las texturas VRoid suelen ser de 1–2 K)
const RE_KURISU = /kurisu|makise|紅莉栖|牧瀬|amadeus/i;

/**
 * ¿El modelo ya es de Kurisu? Mira el nombre (VRM 1.0 `name`, VRM 0.x `title`) y las referencias a la
 * obra original (VRM 1.0 `references[]`, VRM 0.x `reference`): una Kurisu hecha en VRoid Studio con
 * otro «Avatar name» suele declararlo ahí. Si lo es, el tema no la recolorea ni le añade corbata o medias.
 */
function esModeloDeKurisu(meta) {
  if (!meta || typeof meta !== 'object') return false;
  const campos = [meta.name, meta.title, meta.reference];
  if (Array.isArray(meta.references)) campos.push(...meta.references.slice(0, 32));
  return campos.some((x) => typeof x === 'string' && RE_KURISU.test(x.slice(0, 512)));
}
const RE_CORBATA = /(?:^|[^a-z])(?:neck)?tie(?:[^a-z]|$)|necktie|corbata|ネクタイ/i;
const RE_CARA = /face|head|cara/i;
const RE_DECAL_CARA = /_FACE(?:$|[_\s(])|Face(?:Mouth|Eye|Brow)/;   // categoría VRoid en mayúsculas

function manejadorInerte() {
  return { update() {}, dispose() {}, resumen: Object.freeze({ aplicado: false }) };
}

function documentoDisponible() {
  try {
    const d = globalThis.document;
    return d && typeof d.createElement === 'function' ? d : null;
  } catch { return null; }
}

/** Crea un lienzo 2D: <canvas> si hay DOM, OffscreenCanvas si existe; si no, null (p. ej. Node). */
function crearLienzo(w, h) {
  const d = documentoDisponible();
  if (d) {
    try { const c = d.createElement('canvas'); c.width = w; c.height = h; return c; } catch { /* sigue */ }
  }
  try {
    if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
  } catch { /* sin lienzo */ }
  return null;
}
const hayLienzo = () => !!documentoDisponible() || typeof OffscreenCanvas === 'function';

function liberarLienzo(cv) {
  try { cv.width = 0; cv.height = 0; } catch { /* nada */ }
}

/** Imagen utilizable de una textura (o null si no hay o está cerrada: ImageBitmap.close() → 0×0). */
function imagenDe(tex) {
  const img = tex?.image ?? tex?.source?.data;
  if (!img || typeof img !== 'object') return null;
  const w = Number(img.width) || 0, h = Number(img.height) || 0;
  if (!(w > 0) || !(h > 0)) return null;
  return { img, w, h };
}

/** Copia la imagen de una textura a un lienzo nuevo. Lanza si el ImageBitmap está cerrado/contaminado. */
function volcarImagen(tex) {
  const fuente = imagenDe(tex);
  if (!fuente) return null;
  const k = Math.min(1, LADO_MAX / Math.max(fuente.w, fuente.h));
  const w = Math.max(1, Math.round(fuente.w * k)), h = Math.max(1, Math.round(fuente.h * k));
  const cv = crearLienzo(w, h);
  if (!cv) return null;
  const g = cv.getContext('2d', { willReadFrequently: true });
  if (!g) { liberarLienzo(cv); return null; }
  try {
    g.drawImage(fuente.img, 0, 0, w, h);
  } catch (err) {
    liberarLienzo(cv);
    throw err;
  }
  return { cv, g, w, h };
}

const mismaFuente = (a, b) => !!a && !!b && (a === b || (!!a.source && a.source === b.source));
const claveFuente = (tex) => tex?.source?.uuid ?? tex?.uuid ?? null;

// ===================================================================== aplicarTemaAmadeus

const REGISTRO = new WeakMap();   // respaldo de la idempotencia si vrm.userData no es escribible

/**
 * Aplica el tema Amadeus a un VRM ya añadido a la escena y ANTES del primer render.
 * Idempotente: si `vrm.userData.amadeusTema` existe, devuelve ese mismo manejador.
 * @param {object} vrm instancia de @pixiv/three-vrm
 * @param {{THREE: object, rim?: boolean, scanlines?: number, escena?: object, avatarRoot?: object,
 *          modoEscritorio?: boolean}} opciones
 * @returns {{update(t: number): void, dispose(): void}}
 */
export function aplicarTemaAmadeus(vrm, opciones = {}) {
  const op = opciones && typeof opciones === 'object' ? opciones : {};
  if (!vrm || typeof vrm !== 'object' || !vrm.scene) {
    aviso('No hay modelo VRM: el tema no se aplica.');
    return manejadorInerte();
  }
  let datos = null;
  try {
    if (!vrm.userData || typeof vrm.userData !== 'object') vrm.userData = {};
    datos = vrm.userData;
  } catch { datos = null; }
  if (datos?.amadeusTema) return datos.amadeusTema;
  if (REGISTRO.has(vrm)) return REGISTRO.get(vrm);

  const THREE = op.THREE;
  if (!THREE || (typeof THREE !== 'object' && typeof THREE !== 'function')) {
    aviso('Falta opciones.THREE: el tema no se aplica.');
    return manejadorInerte();
  }

  const tema = crearTema(vrm, THREE, {
    rim: op.rim !== false && op.rim !== 'false' && op.rim !== 0,
    scanlines: clamp(Number.isFinite(Number(op.scanlines)) && op.scanlines !== null && op.scanlines !== ''
      ? Number(op.scanlines) : 0.07, 0, 0.2),
    escena: op.escena ?? null,
    avatarRoot: op.avatarRoot ?? null,
    modoEscritorio: op.modoEscritorio === true,
    paleta: op.paleta !== false,
  });

  const manejador = {
    update: (t) => tema.update(t),
    dispose: () => {
      tema.dispose();
      try { if (datos && datos.amadeusTema === manejador) delete datos.amadeusTema; } catch { /* nada */ }
      REGISTRO.delete(vrm);
    },
    get resumen() { return tema.resumen(); },
  };
  // Se registra antes de trabajar: una segunda llamada nunca crea otra corbata.
  try { if (datos) datos.amadeusTema = manejador; } catch { /* sigue con el WeakMap */ }
  REGISTRO.set(vrm, manejador);

  try { tema.aplicar(); } catch (err) { aviso('El tema se aplicó a medias:', err?.message || err); }
  return manejador;
}

// ===================================================================== implementación

function crearTema(vrm, THREE, cfg) {
  const P = AMADEUS_PALETA;
  const SOMBRA_PELO = mezclar(P.hair[4], '#ffffff', 0.25);
  const MEDIAS = [mezclar(P.tights, '#000000', 0.65), mezclar(P.tights, '#000000', 0.35), P.tights,
    mezclar(P.tights, '#ffffff', 0.18)];

  const originales = new Map();     // material → valores previos (para restaurar en dispose)
  const texturasPorClave = new Map(); // `${fuente}|${clave}` → CanvasTexture | null
  const texturasPropias = new Set();
  const lienzosPropios = new Set();
  const rims = [];                   // materiales MToon con rim animado
  const res = { aplicado: true, kurisu: false, materiales: 0, texturas: 0, corbata: false, medias: false,
    escaneo: false, marco: false, rim: false };

  let corbata = null;   // { pivote, hueso, base, geos, mat, espacio, signo, angX, angZ, ... }
  let escaneo = null;   // { quad, geo, mat }
  let marco = null;     // { nodo, reloj, cuerpo }
  let t0 = null, tPrevio = null, ultimoSegundo = -1, desechado = false;
  let colorRim = null, tmpColor = null;

  // ------------------------------------------------------------- recorrido del modelo
  function recorrer() {
    const entradas = [];
    try {
      vrm.scene.traverse((o) => {
        if (!o || !o.isMesh) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (!m || typeof m !== 'object') continue;
          entradas.push({ malla: o, m, parte: clasificarMaterial(m.name), mtoon: m.isMToonMaterial === true });
        }
      });
    } catch (err) { aviso('No se pudo recorrer el modelo:', err?.message || err); }
    return entradas;
  }

  function guardar(m) {
    if (originales.has(m)) return;
    const copia = (v) => (v && typeof v.clone === 'function' ? v.clone() : v);
    const o = { map: m.map ?? null };
    if ('shadeMultiplyTexture' in m) o.shade = m.shadeMultiplyTexture ?? null;
    if (m.color) o.color = copia(m.color);
    if (m.shadeColorFactor) o.shadeColorFactor = copia(m.shadeColorFactor);
    if (m.emissive) o.emissive = copia(m.emissive);
    if (m.parametricRimColorFactor) {
      o.rimColor = copia(m.parametricRimColorFactor);
      o.rimMix = m.rimLightingMixFactor;
      o.rimPow = m.parametricRimFresnelPowerFactor;
      o.rimLift = m.parametricRimLiftFactor;
    }
    originales.set(m, o);
  }

  function restaurar() {
    for (const [m, o] of originales) {
      try {
        m.map = o.map;
        if ('shade' in o) m.shadeMultiplyTexture = o.shade;
        if (o.color && m.color?.copy) m.color.copy(o.color);
        if (o.shadeColorFactor && m.shadeColorFactor?.copy) m.shadeColorFactor.copy(o.shadeColorFactor);
        if (o.emissive && m.emissive?.copy) m.emissive.copy(o.emissive);
        if (o.rimColor && m.parametricRimColorFactor?.copy) {
          m.parametricRimColorFactor.copy(o.rimColor);
          m.rimLightingMixFactor = o.rimMix;
          m.parametricRimFresnelPowerFactor = o.rimPow;
          m.parametricRimLiftFactor = o.rimLift;
        }
        m.needsUpdate = true;
      } catch { /* material ya desechado */ }
    }
    originales.clear();
  }

  // ------------------------------------------------------------- texturas
  function nuevaTextura(cv, src) {
    const t = new THREE.CanvasTexture(cv);
    for (const k of ['flipY', 'wrapS', 'wrapT', 'magFilter', 'minFilter', 'anisotropy', 'channel',
      'generateMipmaps', 'premultiplyAlpha', 'unpackAlignment']) {
      if (src?.[k] !== undefined) t[k] = src[k];
    }
    t.colorSpace = src?.colorSpace || THREE.SRGBColorSpace;
    for (const k of ['offset', 'repeat', 'center']) {
      if (src?.[k] && typeof t[k]?.copy === 'function') t[k].copy(src[k]);
    }
    if (typeof src?.rotation === 'number') t.rotation = src.rotation;
    if (typeof src?.matrixAutoUpdate === 'boolean') t.matrixAutoUpdate = src.matrixAutoUpdate;
    if (src?.matrix && typeof t.matrix?.copy === 'function') t.matrix.copy(src.matrix);
    t.name = `${src?.name || 'textura'} · Amadeus`;
    t.needsUpdate = true;
    texturasPropias.add(t);
    lienzosPropios.add(cv);
    res.texturas = texturasPropias.size;
    return t;
  }

  /** Gradient map por luminancia (conserva el detalle de mechones/iris y fija la paleta). */
  function texturaGradiente(tex, clave, paradas) {
    const fuente = claveFuente(tex);
    if (!fuente || !hayLienzo()) return null;
    const k = `${fuente}|${clave}`;
    if (texturasPorClave.has(k)) return texturasPorClave.get(k);
    let resultado = null;
    try {
      const lienzo = volcarImagen(tex);
      if (lienzo) {
        const { cv, g, w, h } = lienzo;
        const id = g.getImageData(0, 0, w, h);
        const d = id.data, hist = new Uint32Array(256);
        let n = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] > 8) { hist[(d[i] * 54 + d[i + 1] * 183 + d[i + 2] * 19) >> 8]++; n++; }
        }
        if (n > 0) {
          const pct = (p) => { let a = 0; for (let v = 0; v < 256; v++) { a += hist[v]; if (a >= p * n) return v; } return 255; };
          const lo = pct(0.02), hi = Math.max(lo + 1, pct(0.98));
          const C = paradas.map(hexARgb), lut = new Uint8ClampedArray(768);
          for (let v = 0; v < 256; v++) {
            const s = clamp((v - lo) / (hi - lo), 0, 1) * (C.length - 1);
            const j = Math.min(C.length - 2, Math.floor(s)), f = s - j;
            for (let c = 0; c < 3; c++) lut[v * 3 + c] = C[j][c] + (C[j + 1][c] - C[j][c]) * f;
          }
          for (let i = 0; i < d.length; i += 4) {
            const L = ((d[i] * 54 + d[i + 1] * 183 + d[i + 2] * 19) >> 8) * 3;
            d[i] = lut[L]; d[i + 1] = lut[L + 1]; d[i + 2] = lut[L + 2];
          }
          g.putImageData(id, 0, 0);
          resultado = nuevaTextura(cv, tex);
        } else {
          liberarLienzo(cv);
        }
      }
    } catch (err) {
      // ImageBitmap cerrado (InvalidStateError) o lienzo contaminado: se omite este gradient map.
      aviso(`Sin gradient map para «${tex?.name || clave}»:`, err?.name || err?.message || err);
      resultado = null;
    }
    texturasPorClave.set(k, resultado);
    return resultado;
  }

  /** Cambia map (y la textura de sombra, si procede) por su versión con la paleta. */
  function aplicarGradiente(m, clave, paradas) {
    const mapaOrig = m.map;
    if (!mapaOrig) return false;
    const nuevo = texturaGradiente(mapaOrig, clave, paradas);
    if (!nuevo) return false;
    m.map = nuevo;
    if ('shadeMultiplyTexture' in m) {
      const sombra = m.shadeMultiplyTexture;
      if (!sombra || mismaFuente(sombra, mapaOrig)) m.shadeMultiplyTexture = nuevo;
      else {
        const ns = texturaGradiente(sombra, clave, paradas);
        if (ns) m.shadeMultiplyTexture = ns;
      }
    }
    return true;
  }

  const fijar = (color, hex) => { if (color && typeof color.set === 'function') color.set(hex); };

  // ------------------------------------------------------------- recoloreado por parte
  function recolorear(entradas) {
    const hechos = new Set();
    for (const { m, parte } of entradas) {
      if (hechos.has(m) || !parte) continue;
      hechos.add(m);
      try {
        guardar(m);
        const mtoon = m.isMToonMaterial === true;
        switch (parte) {
          case 'hair': {
            if (aplicarGradiente(m, 'hair', P.hair)) {
              fijar(m.color, '#ffffff');
              if (mtoon) fijar(m.shadeColorFactor, m.shadeMultiplyTexture ? SOMBRA_PELO : P.hair[1]);
            } else if (m.color?.multiply && THREE.Color) {
              // Sin imagen (ImageBitmap cerrado o sin lienzo): empuja el castaño hacia el auburn.
              const k = new THREE.Color().setRGB(1.45, 0.65, 0.34);
              m.color.multiply(k);
              if (mtoon && m.shadeColorFactor?.multiply) m.shadeColorFactor.multiply(k);
            }
            if (mtoon && m.emissiveMap && m.emissive) fijar(m.emissive, '#3a1408');
            break;
          }
          case 'iris':
            if (aplicarGradiente(m, 'iris', P.iris) && mtoon) fijar(m.shadeColorFactor, mezclar(P.iris[4], '#ffffff', 0.5));
            break;
          case 'shoes':
            if (aplicarGradiente(m, 'boots', P.boots)) {
              if (mtoon) fijar(m.shadeColorFactor, mezclar(P.boots[3], '#ffffff', 0.5));
            } else fijar(m.color, P.boots[2]);
            break;
          case 'socks':
            if (aplicarGradiente(m, 'socks', MEDIAS)) {
              if (mtoon) fijar(m.shadeColorFactor, mezclar(P.tights, '#ffffff', 0.55));
            } else fijar(m.color, P.tights);
            break;
          case 'skin':
            if (mtoon) fijar(m.shadeColorFactor, P.skinShade);
            break;
          case 'tops':
            if (mtoon) fijar(m.shadeColorFactor, P.coatShade);
            break;
          default:
            break;   // 'eye' y 'bottoms' se quedan como vienen
        }
        m.needsUpdate = true;
        res.materiales += 1;
      } catch (err) {
        aviso(`No se pudo recolorear «${m?.name}»:`, err?.message || err);
      }
    }
  }

  // ------------------------------------------------------------- geometría en espacio del modelo
  function matrizEspacio(espacio) {
    espacio.updateWorldMatrix?.(true, true);
    return new THREE.Matrix4().copy(espacio.matrixWorld).invert();
  }

  function alturaHueso(nombre, inv) {
    try {
      const n = vrm.humanoid?.getNormalizedBoneNode?.(nombre);
      if (!n) return null;
      const p = n.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
      return Number.isFinite(p.y) ? p : null;
    } catch { return null; }
  }

  /** Recorre solo los vértices que usa el índice de la malla (un búfer puede estar compartido). */
  function paraCadaVertice(geo, fn) {
    const pos = geo?.attributes?.position;
    if (!pos) return;
    const idx = geo.index?.array;
    if (!idx) { for (let i = 0; i < pos.count; i++) fn(pos, i); return; }
    const visto = new Uint8Array(pos.count);
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      if (visto[i]) continue;
      visto[i] = 1;
      fn(pos, i);
    }
  }

  function minimoY(entradas, parte, inv) {
    let min = Infinity;
    const v = new THREE.Vector3(), M = new THREE.Matrix4();
    for (const e of entradas) {
      if (e.parte !== parte || e.m.isOutline) continue;
      M.multiplyMatrices(inv, e.malla.matrixWorld);
      paraCadaVertice(e.malla.geometry, (pos, i) => {
        const y = v.fromBufferAttribute(pos, i).applyMatrix4(M).y;
        if (y < min) min = y;
      });
    }
    return Number.isFinite(min) ? min : null;
  }

  // ------------------------------------------------------------- medias oscuras (UV de Body_00)
  function pintarMedias(entradas) {
    if (!hayLienzo()) return;
    vrm.scene.updateWorldMatrix?.(true, true);
    const inv = matrizEspacio(vrm.scene);
    const muslo = alturaHueso('leftUpperLeg', inv) || alturaHueso('rightUpperLeg', inv);
    const rodilla = alturaHueso('leftLowerLeg', inv) || alturaHueso('rightLowerLeg', inv);
    const caderas = alturaHueso('hips', inv);
    let corte = null;
    if (muslo && rodilla && muslo.y > rodilla.y) corte = rodilla.y + 0.69 * (muslo.y - rodilla.y);
    else if (caderas) corte = caderas.y * 0.84;
    if (corte == null) return;
    const bajo = minimoY(entradas, 'bottoms', inv);
    if (bajo != null && muslo && rodilla && bajo > rodilla.y && bajo < muslo.y + 0.1) {
      // El borde de las medias queda escondido bajo los shorts/falda.
      corte = clamp(bajo + 0.06, rodilla.y + 0.03, muslo.y);
    }

    // Agrupa por imagen: varias mallas pueden compartir la textura del cuerpo.
    const grupos = new Map();
    for (const e of entradas) {
      if (e.parte !== 'skin' || e.m.isOutline || !e.m.map) continue;
      const nombre = String(e.m.name || '');
      if (RE_CARA.test(nombre) && !/body/i.test(nombre)) continue;
      const k = claveFuente(e.m.map);
      if (!k) continue;
      if (!grupos.has(k)) grupos.set(k, { tex: e.m.map, mallas: new Set() });
      grupos.get(k).mallas.add(e.malla);
    }

    for (const { tex, mallas } of grupos.values()) {
      try {
        const tris = triangulosBajo(mallas, inv, corte, tex.channel | 0);
        if (tris.length < 6) continue;
        const nuevo = medias(tex, tris);
        if (!nuevo) continue;
        // Asigna a los materiales (superficie y outline) cuyo map es ESA imagen; los demás (la cara)
        // no se tocan.
        for (const e of entradas) {
          const m = e.m;
          if (e.parte !== 'skin' || !mismaFuente(m.map, tex)) continue;
          guardar(m);
          m.map = nuevo.mapa;
          if ('shadeMultiplyTexture' in m) {
            const s = m.shadeMultiplyTexture;
            if (!s || mismaFuente(s, tex)) m.shadeMultiplyTexture = nuevo.mapa;
            else {
              // Textura de sombra propia: se le pintan las mismas piernas para que la sombra no sea piel.
              const otra = medias(s, tris);
              if (otra) m.shadeMultiplyTexture = otra.mapa;
            }
          }
          m.needsUpdate = true;
        }
        res.medias = true;
      } catch (err) {
        aviso('No se pudieron pintar las medias:', err?.name || err?.message || err);
      }
    }
  }

  /** Triángulos (en UV de píxel relativo 0..1) cuyo centroide queda por debajo de `corte`. */
  function triangulosBajo(mallas, inv, corte, canal) {
    const tris = [];
    const v = new THREE.Vector3(), M = new THREE.Matrix4();
    for (const malla of mallas) {
      const geo = malla.geometry;
      const pos = geo?.attributes?.position;
      const uv = geo?.attributes?.[canal ? `uv${canal}` : 'uv'] || geo?.attributes?.uv;
      if (!pos || !uv) continue;
      M.multiplyMatrices(inv, malla.matrixWorld);
      const idx = geo.index ? geo.index.array : null;
      const total = idx ? idx.length : pos.count;
      for (let t = 0; t + 2 < total; t += 3) {
        const a = idx ? idx[t] : t, b = idx ? idx[t + 1] : t + 1, c = idx ? idx[t + 2] : t + 2;
        const y = (v.fromBufferAttribute(pos, a).applyMatrix4(M).y
          + v.fromBufferAttribute(pos, b).applyMatrix4(M).y
          + v.fromBufferAttribute(pos, c).applyMatrix4(M).y) / 3;
        if (!(y < corte)) continue;
        tris.push(uv.getX(a), uv.getY(a), uv.getX(b), uv.getY(b), uv.getX(c), uv.getY(c));
      }
    }
    return tris;
  }

  /** Copia la textura y multiplica la zona de las piernas por el color de las medias. */
  function medias(tex, tris) {
    const k = `${claveFuente(tex)}|medias`;
    if (texturasPorClave.has(k)) return texturasPorClave.get(k);
    let salida = null;
    const lienzo = volcarImagen(tex);
    if (lienzo) {
      const { cv, g, w, h } = lienzo;
      // Si las piernas ya son oscuras (medias de fábrica), no se pintan encima.
      const d = g.getImageData(0, 0, w, h).data;
      const paso = Math.max(1, Math.floor(tris.length / 6 / 600));
      let suma = 0, n = 0;
      for (let i = 0; i < tris.length; i += 6 * paso) {
        const u = (tris[i] + tris[i + 2] + tris[i + 4]) / 3, vv = (tris[i + 1] + tris[i + 3] + tris[i + 5]) / 3;
        const x = clamp(Math.floor(u * w), 0, w - 1), y = clamp(Math.floor(vv * h), 0, h - 1);
        const o = (y * w + x) * 4;
        suma += (d[o] * 54 + d[o + 1] * 183 + d[o + 2] * 19) >> 8; n++;
      }
      if (n && suma / n < 0.35 * 255) {
        liberarLienzo(cv);
      } else {
        const mascara = crearLienzo(w, h);
        const mg = mascara?.getContext('2d');
        if (mg) {
          // Máscara opaca de un solo color (relleno + borde de 2 px para cerrar costuras entre islas UV)
          // y UNA sola multiplicación: así las aristas internas no se oscurecen dos veces.
          mg.fillStyle = P.tights; mg.strokeStyle = P.tights;
          mg.lineWidth = Math.max(1.5, w / 1024); mg.lineJoin = 'round';
          // Todos los triángulos se emiten con la MISMA orientación: fill() usa la regla 'nonzero' y dos
          // triángulos solapados con orientación contraria (UV en espejo: las dos piernas comparten isla)
          // se anularían y solo quedaría el trazo de las aristas.
          mg.beginPath();
          for (let i = 0; i < tris.length; i += 6) {   // glTF: origen UV arriba a la izquierda, flipY = false
            const x0 = tris[i] * w, y0 = tris[i + 1] * h;
            let x1 = tris[i + 2] * w, y1 = tris[i + 3] * h, x2 = tris[i + 4] * w, y2 = tris[i + 5] * h;
            const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
            if (!area) continue;                      // degenerado (o NaN): no cubre nada
            if (area < 0) { [x1, y1, x2, y2] = [x2, y2, x1, y1]; }
            mg.moveTo(x0, y0);
            mg.lineTo(x1, y1);
            mg.lineTo(x2, y2);
            mg.closePath();
          }
          mg.fill(); mg.stroke();
          g.globalCompositeOperation = 'multiply';
          g.drawImage(mascara, 0, 0);
          g.globalCompositeOperation = 'source-over';
          liberarLienzo(mascara);
          salida = { mapa: nuevaTextura(cv, tex) };
        } else {
          if (mascara) liberarLienzo(mascara);
          liberarLienzo(cv);
        }
      }
    }
    texturasPorClave.set(k, salida);
    return salida;
  }

  // ------------------------------------------------------------- corbata roja procedural
  function crearCorbata(entradas) {
    const H = vrm.humanoid;
    if (!H || typeof H.getNormalizedBoneNode !== 'function') return;
    const hueso = (n) => { try { return H.getNormalizedBoneNode(n) || null; } catch { return null; } };
    const pecho = hueso('upperChest') || hueso('chest') || hueso('spine');
    const cuello = hueso('neck'), caderas = hueso('hips');
    if (!pecho || !cuello || !caderas) return;

    // Espacio de trabajo: avatarRoot (ahí el frente es +z en VRM 0 y 1; rotateVRM0 gira vrm.scene).
    const espacio = cfg.avatarRoot || vrm.scene.parent || vrm.scene;
    const signo = espacio === vrm.scene && String(vrm.meta?.metaVersion) === '0' ? -1 : 1;
    const inv = matrizEspacio(espacio);
    const pos = (n) => n.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
    const pC = pos(cuello), pH = pos(caderas);
    const d = pC.y - pH.y;
    if (!(d > 0.05)) return;
    const s = d / 0.413;                       // escala relativa al modelo de ejemplo (cuello–caderas)
    const cx = (pC.x + pH.x) / 2;
    const yTop = pC.y - 0.025 * s, yBot = pH.y + 0.09 * s;
    const bin = 0.01 * s, xMax = 0.015 * s;

    // Perfil frontal del torso (z máximo por altura, cerca del eje) leído de Tops y de la piel del cuerpo.
    const perfil = new Map();
    const v = new THREE.Vector3(), M = new THREE.Matrix4();
    for (const e of entradas) {
      if (e.m.isOutline) continue;
      const util = e.parte === 'tops' || (e.parte === 'skin' && !RE_CARA.test(String(e.m.name || '')));
      if (!util) continue;
      M.multiplyMatrices(inv, e.malla.matrixWorld);
      paraCadaVertice(e.malla.geometry, (p, i) => {
        v.fromBufferAttribute(p, i).applyMatrix4(M);
        if (Math.abs(v.x - cx) > xMax || v.y > yTop + 0.05 * s || v.y < yBot - 0.05 * s) return;
        const b = Math.round(v.y / bin), z = v.z * signo;
        if (!(perfil.get(b) >= z)) perfil.set(b, z);
      });
    }
    const zEn = (y) => {
      const b = Math.round(y / bin);
      for (let k = 0; k < 5; k++) {
        const a = perfil.get(b + k), c = perfil.get(b - k);
        if (a != null || c != null) return Math.max(a ?? -Infinity, c ?? -Infinity);
      }
      return null;
    };
    const filas = 24;
    const zs = [];
    for (let i = 0; i <= filas; i++) zs.push(zEn(yTop + (yBot - yTop) * (i / filas)));
    const conDatos = zs.filter((z) => z != null).length;
    if (conDatos < filas * 0.4) return;        // no se pudo medir el pecho: mejor sin corbata
    // Rellena huecos con la fila válida más cercana (hacia abajo y luego hacia arriba).
    for (let i = 1; i <= filas; i++) if (zs[i] == null) zs[i] = zs[i - 1];
    for (let i = filas - 1; i >= 0; i--) if (zs[i] == null) zs[i] = zs[i + 1];

    const yNudo = yTop + 0.005 * s;
    const zNudo = (zEn(yNudo) ?? zs[0]) + 0.009 * s;
    const posiciones = [], indices = [];
    let zPrev = -Infinity;
    for (let i = 0; i <= filas; i++) {
      const f = i / filas, y = yTop + (yBot - yTop) * f;
      // Sigue el pecho hasta el busto y después cae vertical (z nunca retrocede).
      const z = Math.max(zs[i] + 0.005 * s, zPrev);
      zPrev = z;
      const w = (0.026 + 0.026 * f) * s;
      const x = cx + 0.004 * s * f;            // floja y un poco torcida, como la de Kurisu
      posiciones.push(x - w / 2, y, z * signo, x + w / 2, y, z * signo);
      if (i) { const a = (i - 1) * 2; indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    }
    const ultima = filas * 2;
    posiciones.push(cx + 0.004 * s, yBot - 0.03 * s, zPrev * signo);   // punta
    indices.push(ultima, ultima + 2, ultima + 1);

    const geoHoja = new THREE.BufferGeometry();
    geoHoja.setAttribute('position', new THREE.Float32BufferAttribute(posiciones, 3));
    geoHoja.setIndex(indices);
    geoHoja.translate(-cx, -yNudo, -zNudo * signo);
    geoHoja.computeVertexNormals();
    const geoNudo = new THREE.BoxGeometry(0.03 * s, 0.024 * s, 0.012 * s);

    const mat = materialCorbata(entradas);
    const hoja = new THREE.Mesh(geoHoja, mat);
    const nudo = new THREE.Mesh(geoNudo, mat);
    hoja.name = 'AmadeusCorbataHoja';
    nudo.name = 'AmadeusCorbataNudo';
    hoja.frustumCulled = false; nudo.frustumCulled = false;
    nudo.rotation.z = 0.12;
    const pivote = new THREE.Group();
    pivote.name = 'AmadeusCorbata';
    pivote.position.set(cx, yNudo, zNudo * signo);
    pivote.add(hoja, nudo);
    espacio.add(pivote);
    pecho.attach(pivote);                       // conserva la pose de mundo y sigue al hueso
    corbata = {
      pivote, hueso: pecho, espacio, signo, geos: [geoHoja, geoNudo], mat,
      base: pivote.quaternion.clone(), angX: 0, angZ: 0,
      qP: new THREE.Quaternion(), qE: new THREE.Quaternion(), qR: new THREE.Quaternion(),
      qS: new THREE.Quaternion(), arriba: new THREE.Vector3(), euler: new THREE.Euler(),
    };
    if (cfg.rim && mat.isMToonMaterial) registrarRim(mat);
    res.corbata = true;
  }

  function materialCorbata(entradas) {
    // Se clona un MToon del propio modelo (misma iluminación toon) sin texturas; si no hay, MeshToon.
    const base = entradas.find((e) => e.mtoon && !e.m.isOutline && e.parte === 'tops')?.m
      || entradas.find((e) => e.mtoon && !e.m.isOutline)?.m;
    if (base && typeof base.clone === 'function') {
      const mat = base.clone();
      for (const k of ['map', 'shadeMultiplyTexture', 'emissiveMap', 'normalMap', 'shadingShiftTexture',
        'matcapTexture', 'rimMultiplyTexture', 'outlineWidthMultiplyTexture', 'uvAnimationMaskTexture']) {
        if (k in mat) mat[k] = null;
      }
      if ('isOutline' in mat) mat.isOutline = false;
      for (const k of ['uvAnimationScrollXSpeedFactor', 'uvAnimationScrollYSpeedFactor', 'uvAnimationRotationSpeedFactor']) {
        if (k in mat) mat[k] = 0;
      }
      mat.side = THREE.DoubleSide;
      mat.transparent = false; mat.depthWrite = true; mat.alphaTest = 0; mat.opacity = 1;
      fijar(mat.color, P.tie);
      fijar(mat.shadeColorFactor, P.tieShade);
      fijar(mat.emissive, '#000000');
      if ('shadingToonyFactor' in mat) mat.shadingToonyFactor = 0.9;
      mat.name = 'AmadeusCorbata';
      mat.needsUpdate = true;
      try { mat.update?.(0); } catch { /* no es crítico */ }
      return mat;
    }
    const Clase = THREE.MeshToonMaterial || THREE.MeshLambertMaterial || THREE.MeshBasicMaterial;
    const mat = new Clase({ color: P.tie, side: THREE.DoubleSide });
    mat.name = 'AmadeusCorbata';
    return mat;
  }

  function moverCorbata(t, dt) {
    const c = corbata;
    // Gravedad: si el pecho se inclina hacia delante, la corbata cuelga separándose del cuerpo.
    c.hueso.getWorldQuaternion(c.qP);
    c.espacio.getWorldQuaternion(c.qE);
    c.qR.copy(c.qE).invert().multiply(c.qP).multiply(c.base);
    c.arriba.set(0, 1, 0).applyQuaternion(c.qR);
    const incl = Math.atan2(c.arriba.z * c.signo, c.arriba.y);   // > 0: inclinada hacia delante
    const objX = -Math.max(0, incl) * 0.85 - (0.012 + 0.012 * Math.sin(t * 1.7));
    const objZ = 0.04 + 0.02 * Math.sin(t * 1.1);
    const k = Math.min(1, dt * 5);
    c.angX += (objX - c.angX) * k;
    c.angZ += (objZ - c.angZ) * k;
    c.euler.set(c.angX * c.signo, 0, c.angZ);
    c.qS.setFromEuler(c.euler);
    c.pivote.quaternion.copy(c.base).multiply(c.qS);
  }

  // ------------------------------------------------------------- rim de «conexión»
  function registrarRim(m) {
    if (!m?.parametricRimColorFactor || m.isOutline || rims.includes(m)) return;
    guardar(m);
    m.rimLightingMixFactor = 0;                 // three-vrm ≥ 3.5 lo respeta; en 3.4 se ignora
    m.parametricRimFresnelPowerFactor = 3;
    m.parametricRimLiftFactor = 0.05;
    m.parametricRimColorFactor.setRGB?.(0, 0, 0);   // empieza apagado y se enciende en update()
    rims.push(m);
  }

  function aplicarRim(entradas) {
    colorRim = new THREE.Color(P.rim);
    tmpColor = new THREE.Color();
    for (const e of entradas) {
      // Sin rim en ojos ni en las calcomanías de la cara (boca, delineado, pestañas, cejas).
      if (!e.mtoon || e.parte === 'eye' || e.parte === 'iris' || RE_DECAL_CARA.test(String(e.m.name || ''))) continue;
      try { registrarRim(e.m); } catch (err) { aviso(`Sin rim en «${e.m?.name}»:`, err?.message || err); }
    }
    res.rim = rims.length > 0;
  }

  // ------------------------------------------------------------- scanlines dentro del canvas
  function crearEscaneo() {
    let raiz = cfg.escena;
    if (!raiz) {
      raiz = cfg.avatarRoot || vrm.scene;
      while (raiz?.parent) raiz = raiz.parent;
      if (!raiz?.isScene) return;
    }
    const geo = new THREE.PlaneGeometry(2, 2);
    const mat = new THREE.ShaderMaterial({
      name: 'AmadeusEscaneo',
      uniforms: { uT: { value: 0 }, uK: { value: cfg.scanlines }, uPeriodo: { value: 3 }, uVivo: { value: 0 } },
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: [
        'uniform float uT;',
        'uniform float uK;',
        'uniform float uPeriodo;',
        'uniform float uVivo;',
        'void main() {',
        '  float y = gl_FragCoord.y;',
        '  float linea = step(0.5, fract(y / uPeriodo));',
        '  float b = fract((y + uT * 110.0) / 900.0);',
        '  float banda = smoothstep(0.0, 0.05, b) * (1.0 - smoothstep(0.05, 0.13, b));',
        '  float f = 1.0 - uVivo * (uK * linea * (1.0 - 0.6 * banda) + 0.008 * (0.5 + 0.5 * sin(uT * 7.0)));',
        '  vec3 tinte = mix(vec3(1.0), vec3(1.0, 0.988, 0.955), uVivo);',
        '  gl_FragColor = vec4(f * tinte, 1.0);',
        '}',
      ].join('\n'),
      // Multiplica el color y conserva el alpha de destino: el escritorio transparente sigue transparente.
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.ZeroFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      toneMapped: false,
    });
    const quad = new THREE.Mesh(geo, mat);
    quad.name = 'AmadeusEscaneo';
    quad.frustumCulled = false;
    quad.renderOrder = 1e9;
    quad.raycast = () => {};                    // nunca participa en el hit-test del avatar
    quad.onBeforeRender = (renderer) => {
      const pr = Number(renderer?.getPixelRatio?.()) || 1;
      mat.uniforms.uPeriodo.value = Math.max(2, Math.round(3 * pr));
    };
    escaneo = { quad, geo, mat, raiz };
    raiz.add(quad);
    res.escaneo = true;
  }

  // ------------------------------------------------------------- marco CSS (fuera del escritorio)
  function crearMarco() {
    const doc = documentoDisponible();
    if (!doc) return;                           // Node u otro entorno sin DOM: se omite sin lanzar
    const raizDoc = doc.head || doc.body;
    let link = doc.querySelector?.('link[data-amadeus-tema]') || doc.querySelector?.('link[href="/amadeus_theme.css"]') || null;
    if (!link && raizDoc) {
      link = doc.createElement('link');
      link.rel = 'stylesheet';
      link.href = '/amadeus_theme.css';
      link.setAttribute?.('data-amadeus-tema', '');
      raizDoc.appendChild(link);
    }
    const el = (tag, clase, texto) => {
      const n = doc.createElement(tag);
      if (clase) n.className = clase;
      if (texto != null) n.textContent = texto;
      return n;
    };
    const binario = () => {
      const filas = [];
      for (let i = 0; i < 64; i++) {
        let f = '';
        for (let j = 0; j < 8; j++) f += Math.random() < 0.5 ? '0' : '1';
        filas.push(f);
      }
      return filas.join('\n');
    };
    const nodo = el('div', 'amadeus-marco');
    nodo.setAttribute?.('aria-hidden', 'true');
    nodo.appendChild(el('div', 'amadeus-vineta'));
    nodo.appendChild(el('div', 'amadeus-rejilla'));
    nodo.appendChild(el('pre', 'amadeus-binario amadeus-binario-izq', binario()));
    nodo.appendChild(el('pre', 'amadeus-binario amadeus-binario-der', binario()));
    nodo.appendChild(el('div', 'amadeus-borde'));
    for (const lado of ['si', 'sd', 'ii', 'id']) nodo.appendChild(el('i', `amadeus-esquina amadeus-esquina-${lado}`));
    nodo.appendChild(el('div', 'amadeus-marca', 'Amadeus'));
    const barra = el('div', 'amadeus-barra');
    const estado = el('span', 'amadeus-estado');
    estado.appendChild(el('b', 'amadeus-punto'));
    estado.appendChild(el('span', null, 'Enlace establecido'));
    const derecha = el('span', 'amadeus-canal');
    const reloj = el('span', 'amadeus-reloj', '00:00:00');
    derecha.appendChild(el('span', 'amadeus-linea', 'Línea 1.048596'));
    derecha.appendChild(reloj);
    barra.appendChild(estado);
    barra.appendChild(derecha);
    nodo.appendChild(barra);

    // Sin estilos el marco sería ruido (texto binario suelto): oculto hasta que cargue la hoja; si la
    // hoja falla, se queda oculto.
    if (nodo.style && !link?.sheet) {
      nodo.style.visibility = 'hidden';
      link?.addEventListener?.('load', () => { try { nodo.style.visibility = ''; } catch { /* nada */ } }, { once: true });
    }

    const escenario = doc.getElementById?.('stage') || doc.body;
    if (!escenario) return;
    const lienzo = escenario.querySelector?.('canvas');
    if (lienzo && lienzo.parentNode === escenario) escenario.insertBefore(nodo, lienzo.nextSibling ?? null);
    else escenario.insertBefore(nodo, escenario.firstChild ?? null);
    const cuerpo = doc.body;
    cuerpo?.classList?.add('amadeus-tema');
    marco = { nodo, reloj, cuerpo };
    res.marco = true;
  }

  function quitarMarco() {
    if (!marco) return;
    try {
      if (typeof marco.nodo.remove === 'function') marco.nodo.remove();
      else marco.nodo.parentNode?.removeChild(marco.nodo);
    } catch { /* nada */ }
    try { marco.cuerpo?.classList?.remove('amadeus-tema'); } catch { /* nada */ }
    marco = null;
  }

  // ------------------------------------------------------------- ciclo de vida
  function paso(nombre, fn) {
    try { fn(); } catch (err) { aviso(`Paso «${nombre}» omitido:`, err?.message || err); }
  }

  function aplicar() {
    paso('matrices', () => vrm.scene.updateWorldMatrix?.(true, true));
    const entradas = recorrer();
    res.kurisu = esModeloDeKurisu(vrm.meta);
    res.paleta = cfg.paleta && !res.kurisu;
    const traeCorbata = entradas.some((e) => RE_CORBATA.test(String(e.m.name || '')) || RE_CORBATA.test(String(e.malla.name || '')));
    if (res.paleta) {
      // Un modelo que ya es de Kurisu (o un .vrm propio, paleta:false) se respeta tal cual:
      // solo recibe rim, scanlines y marco.
      paso('recoloreado', () => recolorear(entradas));
      paso('medias', () => pintarMedias(entradas));
      if (!traeCorbata) paso('corbata', () => crearCorbata(entradas));
    }
    if (cfg.rim) paso('rim', () => aplicarRim(entradas));
    if (cfg.scanlines > 0) paso('escaneo', () => crearEscaneo());
    if (!cfg.modoEscritorio) paso('marco', () => crearMarco());
  }

  function update(t) {
    if (desechado || typeof t !== 'number' || !Number.isFinite(t)) return;
    if (t0 === null) { t0 = t; tPrevio = t; }
    const dt = clamp(t - tPrevio, 0, 0.1);
    tPrevio = t;
    const vivo = suave(0, 1.4, t - t0);       // «conectando»: el rim y las líneas se encienden
    if (corbata) {
      try { moverCorbata(t, dt); } catch { /* el hueso pudo desaparecer */ }
    }
    if (rims.length && colorRim) {
      const k = 0.5 * vivo * (1 + 0.08 * Math.sin(t * 1.6));
      try {
        tmpColor.copy(colorRim).multiplyScalar(k);
        for (const m of rims) m.parametricRimColorFactor.copy(tmpColor);
      } catch { /* material desechado */ }
    }
    if (escaneo) {
      try {
        escaneo.mat.uniforms.uT.value = t - t0;
        escaneo.mat.uniforms.uVivo.value = vivo;
      } catch { /* material sin uniforms */ }
    }
    if (marco) {
      const seg = Math.floor(t - t0);
      if (seg !== ultimoSegundo) {
        ultimoSegundo = seg;
        const hh = String(Math.floor(seg / 3600) % 100).padStart(2, '0');
        const mm = String(Math.floor(seg / 60) % 60).padStart(2, '0');
        const ss = String(seg % 60).padStart(2, '0');
        try { marco.reloj.textContent = `${hh}:${mm}:${ss}`; } catch { /* nada */ }
      }
    }
  }

  function dispose() {
    if (desechado) return;
    desechado = true;
    paso('quitar marco', quitarMarco);
    paso('quitar escaneo', () => {
      if (!escaneo) return;
      escaneo.quad.parent?.remove?.(escaneo.quad);
      escaneo.geo.dispose?.();
      escaneo.mat.dispose?.();
      escaneo = null;
    });
    paso('quitar corbata', () => {
      if (!corbata) return;
      if (typeof corbata.pivote.removeFromParent === 'function') corbata.pivote.removeFromParent();
      else corbata.pivote.parent?.remove?.(corbata.pivote);
      for (const g of corbata.geos) g.dispose?.();
      corbata.mat.dispose?.();
      corbata = null;
    });
    rims.length = 0;
    paso('restaurar materiales', restaurar);
    paso('liberar texturas', () => {
      for (const t of texturasPropias) { try { t.dispose?.(); } catch { /* nada */ } }
      for (const cv of lienzosPropios) liberarLienzo(cv);
      texturasPropias.clear();
      lienzosPropios.clear();
      texturasPorClave.clear();
    });
  }

  return { aplicar, update, dispose, resumen: () => Object.freeze({ ...res, desechado }) };
}
