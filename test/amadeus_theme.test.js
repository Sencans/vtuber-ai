// Pruebas del tema «Amadeus» (public/amadeus_theme.js, grupo kurisu). Sin navegador ni red:
//   node --test test/amadeus_theme.test.js
//
// Las pruebas funcionales usan three r180 REAL desde public/vendor/ (lo publica el grupo
// visor-escritorio). Si aún no existe, se omiten con un aviso; para correrlas contra otra copia de
// three: AMADEUS_THREE=/ruta/a/three/build/three.module.js node --test test/amadeus_theme.test.js
// El lienzo 2D y el DOM son falsos y mínimos (aquí no hay navegador ni canvas nativo); el lienzo sí
// rasteriza trayectos (regla nonzero), así que las pruebas de las medias miran píxeles reales.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULO = path.join(RAIZ, 'public', 'amadeus_theme.js');
const HOJA_CSS = path.join(RAIZ, 'public', 'amadeus_theme.css');
const tema = await import(pathToFileURL(MODULO).href);
const { AMADEUS_PALETA, clasificarMaterial, aplicarTemaAmadeus } = tema;

const HEX = /^#[0-9a-f]{6}$/;
const silenciar = (t) => t.mock.method(console, 'warn', () => {});

// ===================================================================== DOM y lienzo falsos

class ListaClases {
  constructor() { this.s = new Set(); }
  add(c) { this.s.add(c); }
  remove(c) { this.s.delete(c); }
  contains(c) { return this.s.has(c); }
}

class ElementoFalso {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this.className = '';
    this.textContent = '';
    this.classList = new ListaClases();
    this.style = {};
    this.oyentes = {};
  }
  addEventListener(tipo, fn) { (this.oyentes[tipo] ||= []).push(fn); }
  disparar(tipo) { for (const fn of this.oyentes[tipo] || []) fn({ type: tipo }); }
  get firstChild() { return this.children[0] ?? null; }
  get nextSibling() {
    const p = this.parentNode;
    return p ? p.children[p.children.indexOf(this) + 1] ?? null : null;
  }
  appendChild(n) { n.parentNode?.removeChild(n); n.parentNode = this; this.children.push(n); return n; }
  insertBefore(n, ref) {
    n.parentNode?.removeChild(n);
    n.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(n); else this.children.splice(i, 0, n);
    return n;
  }
  removeChild(n) { const i = this.children.indexOf(n); if (i >= 0) this.children.splice(i, 1); n.parentNode = null; return n; }
  remove() { this.parentNode?.removeChild(this); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  /** Solo 'tag', 'tag[attr]' y 'tag[attr="valor"]' (lo que usa el módulo). */
  querySelector(sel) {
    const m = /^(\w+)(?:\[([\w-]+)(?:="([^"]*)")?\])?$/.exec(sel);
    if (!m) return null;
    for (const c of this.children) {
      const valor = c.attrs?.[m[2]] ?? c[m[2]];
      if (c.tagName === m[1].toUpperCase() && (!m[2] || (m[3] === undefined ? valor != null : valor === m[3]))) return c;
      const r = c.querySelector?.(sel);
      if (r) return r;
    }
    return null;
  }
}

class LienzoFalso {
  constructor() { this.tagName = 'CANVAS'; this.width = 0; this.height = 0; this.px = null; }
  getContext() { return new Contexto2DFalso(this); }
}

/** Contexto 2D mínimo: copia de píxeles, get/putImageData, multiply y trazados de verdad.
 *  fill() rasteriza los subtrayectos en el centro de cada píxel con la regla de la especificación
 *  ('nonzero' por defecto: dos triángulos solapados con orientación contraria NO se rellenan, igual
 *  que en el navegador); stroke() pinta los píxeles a ≤ lineWidth/2 de algún segmento (sin uniones). */
class Contexto2DFalso {
  constructor(cv) {
    this.canvas = cv;
    this.globalCompositeOperation = 'source-over';
    this.fillStyle = '#000000'; this.strokeStyle = '#000000'; this.lineWidth = 1; this.lineJoin = 'miter';
    this.subs = [];
    this.actual = null;
  }
  buf() {
    const c = this.canvas, n = c.width * c.height * 4;
    if (!c.px || c.px.length !== n) c.px = new Uint8ClampedArray(n);
    return c.px;
  }
  drawImage(src) {
    if (src.cerrado) throw Object.assign(new Error('El ImageBitmap está cerrado'), { name: 'InvalidStateError' });
    const d = this.buf(), s = src.px;
    if (!s) return;
    if (this.globalCompositeOperation === 'multiply') {
      for (let i = 0; i < d.length; i += 4) if (s[i + 3]) for (let c = 0; c < 3; c++) d[i + c] = (d[i + c] * s[i + c]) / 255;
    } else d.set(s.subarray(0, d.length));
  }
  getImageData(x, y, w, h) { return { data: new Uint8ClampedArray(this.buf()), width: w, height: h }; }
  putImageData(id) { this.buf().set(id.data); }
  beginPath() { this.subs = []; this.actual = null; }
  moveTo(x, y) { this.actual = { pts: [[x, y]], cerrado: false }; this.subs.push(this.actual); }
  lineTo(x, y) { if (this.actual) this.actual.pts.push([x, y]); else this.moveTo(x, y); }
  closePath() {
    if (!this.actual) return;
    this.actual.cerrado = true;
    this.moveTo(...this.actual.pts[0]);          // la especificación abre un subtrayecto en el primer punto
  }
  /** Segmentos [x0, y0, x1, y1]; con `cerrar`, también el de vuelta al primer punto. */
  segmentos(cerrar) {
    const segs = [];
    for (const s of this.subs) {
      const p = s.pts;
      for (let i = 0; i + 1 < p.length; i++) segs.push([...p[i], ...p[i + 1]]);
      if ((cerrar || s.cerrado) && p.length > 2) segs.push([...p[p.length - 1], ...p[0]]);
    }
    return segs;
  }
  pintar(color, dentro) {
    const d = this.buf(), { width: w, height: h } = this.canvas;
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!dentro(x + 0.5, y + 0.5)) continue;
      const o = (y * w + x) * 4;
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
    }
  }
  fill(regla = 'nonzero') {
    const segs = this.segmentos(true);
    this.pintar(this.fillStyle, (px, py) => {
      let vueltas = 0;                            // número de vueltas (algoritmo de Sunday)
      for (const [x0, y0, x1, y1] of segs) {
        const lado = (x1 - x0) * (py - y0) - (px - x0) * (y1 - y0);
        if (y0 <= py) { if (y1 > py && lado > 0) vueltas++; } else if (y1 <= py && lado < 0) vueltas--;
      }
      return regla === 'evenodd' ? (vueltas & 1) === 1 : vueltas !== 0;
    });
  }
  stroke() {
    const segs = this.segmentos(false), r = this.lineWidth / 2;
    this.pintar(this.strokeStyle, (px, py) => segs.some(([x0, y0, x1, y1]) => {
      const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy;
      const k = l2 ? Math.min(1, Math.max(0, ((px - x0) * dx + (py - y0) * dy) / l2)) : 0;
      return Math.hypot(px - (x0 + k * dx), py - (y0 + k * dy)) <= r;
    }));
  }
}

/** Documento falso con #stage > canvas. `lienzos` decide si createElement('canvas') da un lienzo útil. */
function documentoFalso({ lienzos = false } = {}) {
  const head = new ElementoFalso('head'), body = new ElementoFalso('body');
  const stage = new ElementoFalso('div');
  stage.attrs.id = 'stage';
  stage.appendChild(new ElementoFalso('canvas'));
  body.appendChild(stage);
  const creados = {};
  return {
    head, body, stage, creados,
    createElement(tag) {
      creados[tag] = (creados[tag] || 0) + 1;
      return tag === 'canvas' && lienzos ? new LienzoFalso() : new ElementoFalso(tag);
    },
    getElementById(id) { return id === 'stage' ? stage : null; },
    querySelector(sel) { return head.querySelector(sel) || body.querySelector(sel); },
  };
}

/** Ejecuta fn con globalThis.document = doc y lo quita al terminar (también si falla). */
async function conDocumento(doc, fn) {
  const previo = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true });
  try { return await fn(); } finally {
    if (previo) Object.defineProperty(globalThis, 'document', previo);
    else delete globalThis.document;
  }
}

// ===================================================================== objetos falsos mínimos

/** THREE hecho de clases vacías: cualquier THREE.X es `class {}`. */
const THREE_VACIO = new Proxy({}, { get: (_, k) => (k === 'then' ? undefined : class {}) });

function vrmMinimo(nombre = 'Muestra') {
  const mallaPelo = { isMesh: true, name: 'Hair', material: [{ name: 'Hair_00_HAIR' }, { name: 'Hair_00_HAIR (Outline)' }], geometry: {} };
  const mallaCuerpo = { isMesh: true, name: 'Body', material: { name: 'Body_00_SKIN' }, geometry: {} };
  const hueso = { attach() {}, add() {}, getWorldPosition: (v) => v };
  return {
    scene: { children: [mallaPelo, mallaCuerpo], traverse(cb) { cb(this); cb(mallaPelo); cb(mallaCuerpo); }, updateWorldMatrix() {} },
    meta: { name: nombre },
    humanoid: { getNormalizedBoneNode: () => hueso },
  };
}

// ===================================================================== pruebas básicas

test('node --check del módulo y de la prueba', () => {
  for (const archivo of [MODULO, fileURLToPath(import.meta.url)]) {
    const r = spawnSync(process.execPath, ['--check', archivo], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
});

test('API exacta: solo AMADEUS_PALETA, clasificarMaterial y aplicarTemaAmadeus; sin imports', () => {
  assert.deepEqual(Object.keys(tema).sort(), ['AMADEUS_PALETA', 'aplicarTemaAmadeus', 'clasificarMaterial']);
  const fuente = readFileSync(MODULO, 'utf8');
  assert.doesNotMatch(fuente, /^\s*import\s/m, 'el módulo no debe importar nada (recibe THREE en opciones)');
  assert.doesNotMatch(fuente, /\bimport\s*\(/, 'tampoco imports dinámicos');
  assert.doesNotMatch(fuente, /\r/, 'LF, no CRLF');
});

test('AMADEUS_PALETA: claves exactas y colores #rrggbb', () => {
  assert.deepEqual(Object.keys(AMADEUS_PALETA).sort(),
    ['boots', 'coatShade', 'hair', 'iris', 'rim', 'skinShade', 'tie', 'tieShade', 'tights'].sort());
  for (const clave of ['hair', 'iris', 'boots']) {
    const lista = AMADEUS_PALETA[clave];
    assert.ok(Array.isArray(lista) && lista.length >= 2, `${clave} es una lista de paradas`);
    for (const c of lista) assert.match(c, HEX, `${clave}: ${c}`);
  }
  for (const clave of ['skinShade', 'coatShade', 'tights', 'tie', 'tieShade', 'rim']) {
    assert.match(AMADEUS_PALETA[clave], HEX, clave);
  }
  // Valores canónicos del informe (pelo auburn de S;G0, iris violeta, corbata roja).
  assert.ok(AMADEUS_PALETA.hair.includes('#803d23'));
  assert.ok(AMADEUS_PALETA.iris.includes('#9883b7'));
  assert.equal(AMADEUS_PALETA.tie, '#ae1927');
  assert.ok(Object.isFrozen(AMADEUS_PALETA) && Object.isFrozen(AMADEUS_PALETA.hair));
});

test('clasificarMaterial: nombres reales del modelo de ejemplo y de VRoid', () => {
  const casos = {
    'Hair_00_HAIR (Outline)': 'hair',
    'EyeIris_00_EYE': 'iris',
    'Hair_00_HAIR': 'hair',
    'HairBack_00_HAIR': 'hair',
    'Body_00_SKIN': 'skin',
    'Face_00_SKIN': 'skin',
    'Tops_01_CLOTH': 'tops',
    'Bottoms_01_CLOTH': 'bottoms',
    'Shoes_01_CLOTH': 'shoes',
    'EyeWhite_00_EYE': 'eye',
    'EyeHighlight_00_EYE': 'eye',
    'N00_000_00_EyeIris_00_EYE (Instance)': 'iris',
    'N00_000_Hair_00_HAIR_01 (Instance)': 'hair',
    'N00_000_00_Body_00_SKIN (Instance) (Outline)': 'skin',
    'N00_002_01_Tops_01_CLOTH_02 (Instance)': 'tops',
    'N00_007_03_Shoes_01_CLOTH_01 (Instance)': 'shoes',
    'Socks_00_CLOTH': 'socks',
    'Tights': 'socks',
    'Onepiece_00_CLOTH': 'tops',
    'FaceMouth_00_FACE': null,
    'FaceEyeline_00_FACE': null,
    'FaceEyelash_00_FACE': null,
    'FaceBrow_00_FACE': null,
    'Accessory_00_CLOTH': null,
    'Hairpin_00_CLOTH': null,
  };
  for (const [nombre, esperado] of Object.entries(casos)) {
    assert.equal(clasificarMaterial(nombre), esperado, nombre);
  }
  for (const raro of ['', '   ', null, undefined, 42, {}, ' (Outline)']) assert.equal(clasificarMaterial(raro), null);
});

test('aplicarTemaAmadeus con vrm y THREE falsos (clases vacías): {update, dispose} sin lanzar', (t) => {
  silenciar(t);
  assert.equal(typeof globalThis.document, 'undefined', 'Node no tiene document');
  const vrm = vrmMinimo();
  const escena = { add() {}, remove() {} };
  const h = aplicarTemaAmadeus(vrm, { THREE: THREE_VACIO, escena, avatarRoot: {}, modoEscritorio: false });
  assert.equal(typeof h.update, 'function');
  assert.equal(typeof h.dispose, 'function');
  assert.doesNotThrow(() => { h.update(0); h.update(0.5); h.update(Number.NaN); h.update(undefined); });
  // Idempotente: la segunda llamada devuelve el MISMO manejador (nunca dos corbatas).
  assert.equal(aplicarTemaAmadeus(vrm, { THREE: THREE_VACIO }), h);
  assert.equal(vrm.userData.amadeusTema, h);
  assert.doesNotThrow(() => { h.dispose(); h.dispose(); h.update(1); });
  assert.equal(vrm.userData.amadeusTema, undefined);
  const h2 = aplicarTemaAmadeus(vrm, { THREE: THREE_VACIO, modoEscritorio: true });
  assert.notEqual(h2, h, 'tras dispose se puede volver a aplicar');
  h2.dispose();
});

test('sin document (Node) no toca el DOM ni lanza, con y sin modo escritorio', (t) => {
  silenciar(t);
  assert.equal(typeof globalThis.document, 'undefined');
  for (const modoEscritorio of [true, false]) {
    const h = aplicarTemaAmadeus(vrmMinimo(), { THREE: THREE_VACIO, modoEscritorio });
    assert.equal(h.resumen.marco, false);
    h.dispose();
  }
  assert.equal(typeof globalThis.document, 'undefined', 'no crea un document global');
});

test('entradas inválidas: manejador inerte, sin lanzar', (t) => {
  silenciar(t);
  for (const [vrm, op] of [[null, { THREE: THREE_VACIO }], [{}, { THREE: THREE_VACIO }], [vrmMinimo(), {}], [vrmMinimo(), null]]) {
    const h = aplicarTemaAmadeus(vrm, op);
    assert.equal(typeof h.update, 'function');
    assert.doesNotThrow(() => { h.update(1); h.dispose(); });
  }
  // Sin THREE no se registra: luego, con THREE, sí se aplica.
  const vrm = vrmMinimo();
  const inerte = aplicarTemaAmadeus(vrm, {});
  const real = aplicarTemaAmadeus(vrm, { THREE: THREE_VACIO });
  assert.notEqual(inerte, real);
  real.dispose();
});

test('modoEscritorio:true no crea <link> ni marco CSS', async (t) => {
  silenciar(t);
  const doc = documentoFalso();
  await conDocumento(doc, () => {
    const h = aplicarTemaAmadeus(vrmMinimo(), { THREE: THREE_VACIO, modoEscritorio: true });
    assert.equal(doc.creados.link ?? 0, 0);
    assert.equal(doc.head.children.length, 0);
    assert.equal(doc.stage.children.length, 1, 'solo el canvas');
    assert.equal(doc.body.classList.contains('amadeus-tema'), false);
    h.dispose();
  });
});

test('modoEscritorio:false inyecta el <link> una vez y el marco tras el canvas; dispose lo quita', async (t) => {
  silenciar(t);
  const doc = documentoFalso();
  await conDocumento(doc, () => {
    const vrm = vrmMinimo();
    const h = aplicarTemaAmadeus(vrm, { THREE: THREE_VACIO, modoEscritorio: false });
    assert.equal(aplicarTemaAmadeus(vrm, { THREE: THREE_VACIO }), h);
    const links = doc.head.children.filter((n) => n.tagName === 'LINK');
    assert.equal(links.length, 1);
    assert.equal(links[0].href, '/amadeus_theme.css');
    assert.equal(links[0].rel, 'stylesheet');
    assert.equal(doc.stage.children[0].tagName, 'CANVAS');
    assert.equal(doc.stage.children[1].className, 'amadeus-marco');
    assert.equal(doc.stage.children[1].attrs['aria-hidden'], 'true');
    assert.ok(doc.body.classList.contains('amadeus-tema'));
    // Oculto hasta que carga la hoja (sin estilos sería texto suelto); visible al llegar 'load'.
    assert.equal(doc.stage.children[1].style.visibility, 'hidden');
    links[0].disparar('load');
    assert.equal(doc.stage.children[1].style.visibility, '');
    h.update(100); h.update(103.4);
    const reloj = doc.stage.children[1].children.find((n) => n.className === 'amadeus-barra')
      .children[1].children.find((n) => n.className === 'amadeus-reloj');
    assert.equal(reloj.textContent, '00:00:03');
    h.dispose();
    assert.equal(doc.stage.children.length, 1);
    assert.equal(doc.body.classList.contains('amadeus-tema'), false);
    // Un segundo modelo no duplica la hoja de estilos.
    const h2 = aplicarTemaAmadeus(vrmMinimo(), { THREE: THREE_VACIO });
    assert.equal(doc.head.children.filter((n) => n.tagName === 'LINK').length, 1);
    h2.dispose();
  });
});

test('amadeus_theme.css: sin recursos externos, sin logos y con las clases que usa el módulo', () => {
  const css = readFileSync(HOJA_CSS, 'utf8');
  assert.doesNotMatch(css, /@import|url\(\s*['"]?(?:https?:)?\/\//i, 'nada remoto');
  assert.doesNotMatch(css, /url\(/i, 'sin imágenes: el marco es solo CSS');
  assert.doesNotMatch(css, /\r/);
  const fuente = readFileSync(MODULO, 'utf8');
  const clases = new Set([...fuente.matchAll(/'(amadeus-[a-z-]+)/g)].map((m) => m[1]));
  for (const c of clases) {
    if (c.startsWith('amadeus-esquina-') || c === 'amadeus-tema') continue;
    assert.match(css, new RegExp(`\\.${c}\\b`), `falta .${c} en el CSS`);
  }
  for (const lado of ['si', 'sd', 'ii', 'id']) assert.match(css, new RegExp(`\\.amadeus-esquina-${lado}\\b`));
  assert.match(css, /body\.amadeus-tema/);
});

// ===================================================================== pruebas con three real

function buscarThree() {
  const env = process.env.AMADEUS_THREE;
  if (env && existsSync(env)) return env;
  const vendor = path.join(RAIZ, 'public', 'vendor');
  if (!existsSync(vendor)) return null;
  for (const rel of readdirSync(vendor, { recursive: true })) {
    const p = path.join(vendor, String(rel));
    if (/[\\/]build[\\/]three\.module\.js$/.test(p) && existsSync(path.join(path.dirname(p), 'three.core.js'))) return p;
  }
  return null;
}
const RUTA_THREE = buscarThree();
const THREE = RUTA_THREE ? await import(pathToFileURL(RUTA_THREE).href) : null;

/** Material con la interfaz de MToonMaterial que usa el tema (propiedades planas). */
function claseMToon(T) {
  return class MToonFalso {
    constructor(nombre = '') {
      this.name = nombre;
      this.isOutline = false;
      this.side = T.FrontSide;
      this.color = new T.Color(1, 1, 1);
      this.shadeColorFactor = new T.Color(0.93, 0.624, 0.708);
      this.map = null;
      this.shadeMultiplyTexture = null;
      this.emissive = new T.Color(0, 0, 0);
      this.emissiveMap = null;
      this.parametricRimColorFactor = new T.Color(0, 0, 0);
      this.rimLightingMixFactor = 1;
      this.parametricRimFresnelPowerFactor = 5;
      this.parametricRimLiftFactor = 0;
      this.shadingToonyFactor = 0.9;
      this.desechado = false;
    }
    get isMToonMaterial() { return true; }
    clone() {
      const c = new this.constructor(this.name);
      for (const k of ['color', 'shadeColorFactor', 'emissive', 'parametricRimColorFactor']) c[k] = this[k].clone();
      for (const k of ['map', 'shadeMultiplyTexture', 'emissiveMap', 'isOutline', 'side', 'rimLightingMixFactor',
        'parametricRimFresnelPowerFactor', 'parametricRimLiftFactor']) c[k] = this[k];
      return c;
    }
    dispose() { this.desechado = true; }
  };
}

const imagen = (w, h, fn) => {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = fn(x, y), o = (y * w + x) * 4;
    px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
  }
  return { width: w, height: h, px };
};
const pixel = (tex, x, y) => {
  const c = tex.image, o = (y * c.width + x) * 4;
  return `#${[c.px[o], c.px[o + 1], c.px[o + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
};
const hexDe = (color) => `#${color.getHexString()}`;

/** Modelo sintético con las medidas del ejemplo de three-vrm (cuello 1,321 m, caderas 0,908 m…). */
function modeloSintetico({ nombre = 'Muestra', imagenPelo = null, imagenPiel = null, geoPiel = null, meta = {} } = {}) {
  const T = THREE, MToon = claseMToon(T);
  const escena = new T.Scene();
  const avatarRoot = new T.Group();
  avatarRoot.position.set(0.3, 0, -0.2);
  avatarRoot.rotation.y = 0.4;                    // como tras un 'move': el tema trabaja en su espacio
  escena.add(avatarRoot);
  const scene = new T.Group();
  const rig = new T.Object3D();
  scene.add(rig);
  const hueso = (y, x = 0) => { const b = new T.Object3D(); b.position.set(x, y, 0); rig.add(b); return b; };
  const huesos = { hips: hueso(0.908), upperChest: hueso(1.183), neck: hueso(1.321),
    leftUpperLeg: hueso(0.869, 0.08), leftLowerLeg: hueso(0.516, 0.08) };
  const textura = (img, n) => { const tx = new T.Texture(img); tx.flipY = false; tx.colorSpace = T.SRGBColorSpace; tx.name = n; return tx; };
  const mtoon = (n, map) => { const m = new MToon(n); m.map = map; m.shadeMultiplyTexture = map; return m; };
  const conOutline = (geo, sup) => {
    const out = sup.clone(); out.name += ' (Outline)'; out.isOutline = true; out.side = T.BackSide;
    return new T.Mesh(geo, [sup, out]);
  };
  const mats = {
    pelo: mtoon('Hair_00_HAIR', textura(imagenPelo ?? imagen(16, 4, (x) => [80 + x * 8, 50 + x * 5, 40 + x * 3]), 'Hair_00')),
    iris: mtoon('EyeIris_00_EYE', textura(imagen(8, 8, (x) => (x < 4 ? [8, 8, 8] : [72, 40, 24])), 'EyeIris_00')),
    piel: mtoon('N00_000_00_Body_00_SKIN (Instance)', textura(imagenPiel ?? imagen(8, 8, () => [245, 229, 205]), 'Body_00')),
    cara: mtoon('Face_00_SKIN', textura(imagen(4, 4, () => [248, 229, 215]), 'Face_00')),
    tops: mtoon('Tops_01_CLOTH', textura(imagen(4, 4, () => [248, 246, 246]), 'Tops_01')),
    zapatos: mtoon('Shoes_01_CLOTH', textura(imagen(4, 4, (x) => (x < 2 ? [136, 168, 200] : [250, 250, 250])), 'Shoes_01')),
    shorts: mtoon('Bottoms_01_CLOTH', textura(imagen(4, 4, () => [5, 5, 5]), 'Bottoms_01')),
    boca: mtoon('FaceMouth_00_FACE', textura(imagen(2, 2, () => [200, 90, 90]), 'FaceMouth_00')),
  };
  mats.pelo.emissiveMap = textura(imagen(2, 2, () => [255, 255, 255]), 'Hair_00_spe');
  mats.pelo.emissive.setRGB(0.708, 0.254, 0.044);
  const torso = new T.LatheGeometry([0.04, 0.12, 0.14, 0.15, 0.13, 0.12, 0.13, 0.15, 0.12]
    .map((r, i) => new T.Vector2(r, 1.34 - i * 0.064)), 16);
  const piernas = new T.CylinderGeometry(0.07, 0.05, 0.86, 8, 8).translate(0.08, 0.43, 0);
  const mallas = {
    tops: conOutline(torso, mats.tops),
    piel: conOutline(geoPiel ?? piernas, mats.piel),
    cara: conOutline(new T.SphereGeometry(0.1, 8, 6).translate(0, 1.5, 0), mats.cara),
    pelo: conOutline(new T.SphereGeometry(0.12, 8, 6).translate(0, 1.52, -0.02), mats.pelo),
    iris: new T.Mesh(new T.PlaneGeometry(0.02, 0.02).translate(0.03, 1.5, 0.1), mats.iris),
    boca: new T.Mesh(new T.PlaneGeometry(0.02, 0.01).translate(0, 1.46, 0.1), mats.boca),
    shorts: conOutline(new T.CylinderGeometry(0.16, 0.18, 0.3, 8, 2).translate(0, 0.851, 0), mats.shorts),
    zapatos: conOutline(new T.BoxGeometry(0.1, 0.1, 0.2).translate(0.08, 0.05, 0.03), mats.zapatos),
  };
  scene.add(...Object.values(mallas));
  avatarRoot.add(scene);
  const vrm = { scene, meta: { name: nombre, metaVersion: '1', ...meta }, humanoid: { getNormalizedBoneNode: (n) => huesos[n] ?? null } };
  return { escena, avatarRoot, vrm, huesos, mats, mallas };
}

const contar = (raiz, nombre) => { let n = 0; raiz.traverse((o) => { if (o.name === nombre) n++; }); return n; };

describe('con three real (public/vendor)', { skip: THREE ? false : 'three aún no está en public/vendor/ (pendiente del grupo visor-escritorio)' }, () => {
  test('recolorea, pinta medias, ata UNA corbata, añade el escaneo y lo deshace todo en dispose', async (t) => {
    silenciar(t);
    const doc = documentoFalso({ lienzos: true });
    await conDocumento(doc, () => {
      const { escena, avatarRoot, vrm, huesos, mats, mallas } = modeloSintetico();
      const P = AMADEUS_PALETA;
      const orig = { pelo: mats.pelo.map, colorPelo: hexDe(mats.pelo.color), cara: mats.cara.map,
        sombraPiel: hexDe(mats.piel.shadeColorFactor), piel: mats.piel.map };
      const h = aplicarTemaAmadeus(vrm, { THREE, escena, avatarRoot, modoEscritorio: false, rim: true, scanlines: 0.07 });
      const r = h.resumen;
      assert.ok(r.corbata && r.medias && r.escaneo && r.marco && r.rim && !r.kurisu, JSON.stringify(r));

      // Pelo: gradient map compartido por superficie y outline; los extremos son los de la paleta.
      const [sup, out] = mallas.pelo.material;
      assert.notEqual(sup.map, orig.pelo);
      assert.ok(sup.map.isCanvasTexture);
      assert.equal(out.map, sup.map);
      assert.equal(sup.shadeMultiplyTexture, sup.map);
      assert.equal(sup.map.flipY, false);
      assert.equal(pixel(sup.map, 0, 0), P.hair[0]);
      assert.equal(pixel(sup.map, 15, 0), P.hair[4]);
      assert.equal(hexDe(sup.color), '#ffffff');
      assert.equal(hexDe(sup.emissive), '#3a1408');
      // Iris violeta, botas oscuras.
      assert.equal(pixel(mats.iris.map, 0, 0), P.iris[0]);
      assert.equal(pixel(mats.iris.map, 7, 0), P.iris[4]);
      assert.equal(pixel(mats.zapatos.map, 3, 0), P.boots[3]);
      // Piel: sombra cálida y medias en la textura del cuerpo (no en la cara).
      assert.equal(hexDe(mats.piel.shadeColorFactor), P.skinShade);
      assert.notEqual(mats.piel.map, orig.piel);
      assert.equal(mallas.piel.material[1].map, mats.piel.map, 'el outline del cuerpo comparte las medias');
      assert.equal(pixel(mats.piel.map, 0, 0), '#38261d', 'piel #f5e5cd × medias #3a2a24');
      assert.equal(mats.cara.map, orig.cara);
      assert.equal(mats.cara.shadeMultiplyTexture, orig.cara);
      assert.equal(hexDe(mats.tops.shadeColorFactor), P.coatShade);

      // Corbata: una, colgada de upperChest, delante del pecho y entre el cuello y las caderas.
      assert.equal(contar(escena, 'AmadeusCorbata'), 1);
      const pivote = huesos.upperChest.children.find((c) => c.name === 'AmadeusCorbata');
      assert.ok(pivote);
      escena.updateWorldMatrix(true, true);
      const inv = avatarRoot.matrixWorld.clone().invert();
      const nudo = pivote.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
      assert.ok(nudo.y > 1.2 && nudo.y < 1.321, `altura del nudo ${nudo.y}`);
      assert.ok(nudo.z > 0.1 && nudo.z < 0.2, `profundidad del nudo ${nudo.z}`);
      const caja = new THREE.Box3().setFromObject(pivote).applyMatrix4(inv);
      assert.ok(caja.min.y > 0.908 && caja.min.z > 0.1, 'no atraviesa el pecho ni baja de las caderas');
      const matCorbata = pivote.children[0].material;
      assert.equal(hexDe(matCorbata.color), P.tie);
      assert.equal(hexDe(matCorbata.shadeColorFactor), P.tieShade);
      assert.equal(matCorbata.map, null);
      assert.equal(matCorbata.side, THREE.DoubleSide);

      // Escaneo: quad que multiplica el color y conserva el alpha; no participa en el raycast.
      const quad = escena.children.find((c) => c.name === 'AmadeusEscaneo');
      assert.ok(quad);
      assert.equal(quad.material.blending, THREE.CustomBlending);
      assert.equal(quad.material.blendSrc, THREE.DstColorFactor);
      assert.equal(quad.material.blendDst, THREE.ZeroFactor);
      assert.equal(quad.material.blendSrcAlpha, THREE.ZeroFactor);
      assert.equal(quad.material.blendDstAlpha, THREE.OneFactor);
      assert.equal(quad.material.uniforms.uK.value, 0.07);
      const rayo = new THREE.Raycaster(new THREE.Vector3(0, 1, 5), new THREE.Vector3(0, 0, -1));
      assert.ok(!rayo.intersectObject(escena, true).some((x) => x.object === quad));

      // Idempotencia: el mismo manejador, una sola corbata, un solo quad, un solo <link>.
      assert.equal(aplicarTemaAmadeus(vrm, { THREE, escena, avatarRoot }), h);
      assert.equal(contar(escena, 'AmadeusCorbata'), 1);
      assert.equal(contar(escena, 'AmadeusEscaneo'), 1);
      assert.equal(doc.creados.link, 1);

      // update: el rim se enciende y la corbata se balancea; con el pecho inclinado cuelga.
      const q0 = pivote.quaternion.clone();
      h.update(10); h.update(10.5); h.update(12);
      assert.ok(mats.tops.parametricRimColorFactor.r > 0.1, 'rim encendido');
      assert.ok(mats.cara.parametricRimColorFactor.r > 0.1, 'la piel de la cara también');
      assert.ok(mallas.tops.material[1].parametricRimColorFactor.r === 0, 'el outline no lleva rim');
      assert.equal(mats.iris.parametricRimColorFactor.r, 0, 'sin rim en el iris');
      assert.equal(mats.boca.parametricRimColorFactor.r, 0, 'sin rim en las calcomanías de la cara');
      assert.equal(mats.tops.rimLightingMixFactor, 0);
      assert.ok(!pivote.quaternion.equals(q0));
      huesos.upperChest.rotation.x = 0.5;
      for (let i = 0; i < 90; i++) h.update(12 + i / 30);
      escena.updateWorldMatrix(true, true);
      const qRel = avatarRoot.getWorldQuaternion(new THREE.Quaternion()).invert()
        .multiply(pivote.getWorldQuaternion(new THREE.Quaternion()));
      const arriba = new THREE.Vector3(0, 1, 0).applyQuaternion(qRel);
      assert.ok(Math.abs(Math.atan2(arriba.z, arriba.y)) < 0.15, 'compensa la inclinación del pecho');

      // dispose: quita todo y restaura los materiales.
      h.dispose();
      assert.equal(contar(escena, 'AmadeusCorbata'), 0);
      assert.equal(contar(escena, 'AmadeusEscaneo'), 0);
      assert.ok(matCorbata.desechado);
      assert.equal(mats.pelo.map, orig.pelo);
      assert.equal(mallas.pelo.material[1].map, orig.pelo);
      assert.equal(hexDe(mats.pelo.color), orig.colorPelo);
      assert.equal(mats.piel.map, orig.piel);
      assert.equal(hexDe(mats.piel.shadeColorFactor), orig.sombraPiel);
      assert.equal(mats.tops.parametricRimColorFactor.r, 0);
      assert.equal(doc.stage.children.length, 1);
      assert.equal(vrm.userData.amadeusTema, undefined);
    });
  });

  test('ImageBitmap cerrado o drawImage que lanza: omite el gradient map y sigue', async (t) => {
    silenciar(t);
    const doc = documentoFalso({ lienzos: true });
    await conDocumento(doc, () => {
      const { escena, avatarRoot, vrm, mats } = modeloSintetico({ imagenPelo: { width: 0, height: 0 } });
      const mapaPelo = mats.pelo.map;
      mats.iris.map.image.cerrado = true;            // drawImage → InvalidStateError
      const mapaIris = mats.iris.map;
      let h;
      assert.doesNotThrow(() => { h = aplicarTemaAmadeus(vrm, { THREE, escena, avatarRoot }); });
      assert.equal(mats.pelo.map, mapaPelo);
      assert.equal(mats.iris.map, mapaIris);
      assert.notEqual(hexDe(mats.pelo.color), '#ffffff', 'el pelo se empuja hacia el auburn multiplicando');
      assert.ok(h.resumen.corbata, 'el resto del tema se aplica igual');
      assert.ok(h.resumen.medias);
      h.dispose();
      assert.equal(hexDe(mats.pelo.color), '#ffffff');
    });
  });

  test('modo escritorio: sin <link> ni marco, con rim y escaneo', async (t) => {
    silenciar(t);
    const doc = documentoFalso({ lienzos: true });
    await conDocumento(doc, () => {
      const { escena, avatarRoot, vrm } = modeloSintetico();
      const h = aplicarTemaAmadeus(vrm, { THREE, escena, avatarRoot, modoEscritorio: true, scanlines: 0.5 });
      assert.equal(doc.creados.link ?? 0, 0);
      assert.equal(doc.stage.children.length, 1);
      assert.ok(h.resumen.escaneo && h.resumen.rim && !h.resumen.marco);
      const quad = escena.children.find((c) => c.name === 'AmadeusEscaneo');
      assert.equal(quad.material.uniforms.uK.value, 0.2, 'scanlines acotado a 0..0.2');
      h.dispose();
    });
  });

  test('sin scanlines ni rim: no hay quad y los rim quedan como estaban', (t) => {
    silenciar(t);
    const { escena, avatarRoot, vrm, mats } = modeloSintetico();
    const h = aplicarTemaAmadeus(vrm, { THREE, escena, avatarRoot, modoEscritorio: true, scanlines: 0, rim: false });
    assert.equal(contar(escena, 'AmadeusEscaneo'), 0);
    assert.equal(mats.tops.rimLightingMixFactor, 1);
    h.update(5);
    assert.equal(mats.tops.parametricRimColorFactor.r, 0);
    h.dispose();
  });

  test('un modelo que ya es de Kurisu no se recolorea ni recibe corbata', (t) => {
    silenciar(t);
    const { escena, avatarRoot, vrm, mats } = modeloSintetico({ nombre: 'Makise Kurisu (VRM 1.0)' });
    const mapa = mats.pelo.map;
    const h = aplicarTemaAmadeus(vrm, { THREE, escena, avatarRoot, modoEscritorio: true });
    assert.ok(h.resumen.kurisu);
    assert.equal(h.resumen.corbata, false);
    assert.equal(mats.pelo.map, mapa);
    assert.equal(contar(escena, 'AmadeusCorbata'), 0);
    assert.ok(h.resumen.rim && h.resumen.escaneo);
    h.dispose();
  });

  test('medias: solo las islas UV bajo el corte, en su fila glTF (v pequeño arriba) y también con UV en espejo', async (t) => {
    silenciar(t);
    const doc = documentoFalso({ lienzos: true });
    await conDocumento(doc, () => {
      // Body_00 de 32×32 con tres islas. Corte de las medias: borde de los shorts (0,701) + 0,06 = 0,761.
      //   A: pierna izquierda (y 0,1–0,6), u 0,125–0,4375 × v 0,0625–0,3125 → filas 2–10, columnas 4–14.
      //   B: las dos piernas COMPARTEN la isla en espejo (orientación contraria), columnas 18–28, filas 2–10.
      //   T: torso (y 1,0–1,3, por encima del corte), filas 22–30: debe quedar intacto.
      const pos = [], uv = [];
      const isla = ({ x, yA, yB, u0, u1, v0, v1, espejo = false }) => {
        const esq = [[x - 0.05, yB, u0, v0], [x + 0.05, yB, u1, v0], [x + 0.05, yA, u1, v1], [x - 0.05, yA, u0, v1]];
        for (const tri of espejo ? [[0, 2, 1], [0, 3, 2]] : [[0, 1, 2], [0, 2, 3]]) {
          for (const i of tri) { const [px, py, pu, pv] = esq[i]; pos.push(px, py, 0.05); uv.push(pu, pv); }
        }
      };
      isla({ x: 0.08, yA: 0.1, yB: 0.6, u0: 0.125, u1: 0.4375, v0: 0.0625, v1: 0.3125 });
      isla({ x: 0.08, yA: 0.1, yB: 0.6, u0: 0.5625, u1: 0.875, v0: 0.0625, v1: 0.3125 });
      isla({ x: -0.08, yA: 0.1, yB: 0.6, u0: 0.5625, u1: 0.875, v0: 0.0625, v1: 0.3125, espejo: true });
      isla({ x: 0, yA: 1.0, yB: 1.3, u0: 0.125, u1: 0.875, v0: 0.6875, v1: 0.9375 });
      const geoPiel = new THREE.BufferGeometry();
      geoPiel.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geoPiel.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      const { escena, avatarRoot, vrm, mats } = modeloSintetico({
        geoPiel, imagenPiel: imagen(32, 32, () => [245, 229, 205]),
      });
      const h = aplicarTemaAmadeus(vrm, { THREE, escena, avatarRoot, modoEscritorio: true });
      assert.ok(h.resumen.medias, JSON.stringify(h.resumen));
      const mapa = mats.piel.map;
      const piel = '#f5e5cd', medias = '#38261d';   // piel × medias #3a2a24
      // Píxeles lejos de la diagonal de cada cuadrilátero: el trazo de 1,5 px no los alcanza, solo el relleno.
      for (const [x, y] of [[12, 3], [12, 4], [6, 8], [5, 9]]) assert.equal(pixel(mapa, x, y), medias, `isla A (${x},${y})`);
      for (const [x, y] of [[26, 3], [25, 4], [21, 8], [20, 9]]) assert.equal(pixel(mapa, x, y), medias, `isla B en espejo (${x},${y})`);
      for (const [x, y] of [[5, 23], [16, 26], [27, 29]]) assert.equal(pixel(mapa, x, y), piel, `torso intacto (${x},${y})`);
      for (const [x, y] of [[9, 13], [16, 16], [23, 19], [1, 6], [31, 6], [16, 0]]) {
        assert.equal(pixel(mapa, x, y), piel, `fuera de las islas (${x},${y})`);
      }
      assert.equal(mats.piel.shadeMultiplyTexture, mapa);
      h.dispose();
    });
  });

  test('un modelo de Kurisu con otro nombre se reconoce por sus referencias (VRM 1.0 y 0.x)', (t) => {
    silenciar(t);
    for (const meta of [{ references: ['STEINS;GATE – Makise Kurisu (homenaje de fan)'] },
      { metaVersion: '0', title: 'Mi avatar', reference: 'Amadeus / S;G0' }]) {
      const { escena, avatarRoot, vrm, mats } = modeloSintetico({ nombre: 'Mi avatar', meta });
      const mapa = mats.pelo.map;
      const h = aplicarTemaAmadeus(vrm, { THREE, escena, avatarRoot, modoEscritorio: true });
      assert.ok(h.resumen.kurisu, JSON.stringify(meta));
      assert.equal(mats.pelo.map, mapa);
      assert.equal(contar(escena, 'AmadeusCorbata'), 0);
      h.dispose();
    }
    // Sin pistas en name/title/references: se aplica el look completo.
    const { escena, avatarRoot, vrm } = modeloSintetico({ nombre: 'Mi avatar', meta: { references: ['STEINS;GATE'] } });
    const h = aplicarTemaAmadeus(vrm, { THREE, escena, avatarRoot, modoEscritorio: true });
    assert.equal(h.resumen.kurisu, false);
    assert.equal(contar(escena, 'AmadeusCorbata'), 1);
    h.dispose();
  });
});
