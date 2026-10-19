// VTuber AI Studio — visor y motor de animación.
// Recibe comandos de la IA por SSE (/api/events) y los ejecuta sobre un modelo VRM.
//
// Modos por URL:
//   ?obs=1      transparente y sin panel (fuente de navegador de OBS).
//   ?desktop=1  modo escritorio para Amadeus Desktop (Electron): implica ?obs=1, el canvas es una
//               "caja" de 340×600 que se mueve por la pantalla con transform, hit-test por raycast,
//               comandos "desktop" y órdenes del proceso principal (window.amadeusDesktop).
//   ?tts=1      voz del navegador también en ?obs=1 / ?desktop=1 (si no, en ellos se ignora "tts").
//   ?theme=amadeus  tema visual Amadeus (look de Kurisu) desde /amadeus_theme.js.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import {
  DEFAULT_MODEL_URL, EMOTIONS, EMOTION_LABELS, VISEMES, POSES, GESTURES, HAND_SHAPES,
  LOOK_TARGETS, CAMERA_PRESETS, BACKGROUNDS, COMMANDS, COMMAND_TYPES,
  DESKTOP_ACTIONS, DESKTOP_EDGES, DESKTOP_LIMITS, DESKTOP_BOX, THEMES, THEME_LIMITS, RESTRICTED_TYPES,
  speakBubble,
} from '/protocol.js';

// ===================================================================== utilidades
const DEG = Math.PI / 180;
const AXES = ['x', 'y', 'z'];
const now = () => performance.now() / 1000;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, k) => a + (b - a) * k;
const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const plateau = (p, a = 0.2) => smooth(0, a, p) * (1 - smooth(1 - a, 1, p));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v, d) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v)) return +v;
  return d;
};
const $ = (s) => document.querySelector(s);
const S = Math.sin;
const TAU = Math.PI * 2;

class CommandError extends Error {}
const fail = (msg) => { throw new CommandError(msg); };

const params = new URLSearchParams(location.search);
const DESKTOP = params.has('desktop');
const OBS = params.has('obs') || DESKTOP;          // el modo escritorio implica el de OBS
// Regla de audio: como mucho un visor reproduce TTS (el panel); ?obs=1 / ?desktop=1 solo con ?tts=1.
const TTS_PERMITIDO = !OBS || params.has('tts');
if (OBS) { document.body.classList.add('obs'); document.documentElement.classList.add('obs'); }
if (DESKTOP) { document.body.classList.add('desktop'); document.documentElement.classList.add('desktop'); }

// API del preload de Amadeus Desktop (solo existe dentro de Electron, §C2.7.2). Todo es opcional.
const AD = DESKTOP && window.amadeusDesktop && typeof window.amadeusDesktop === 'object' ? window.amadeusDesktop : null;
function ad(nombre, ...args) {
  const f = AD?.[nombre];
  if (typeof f !== 'function') return undefined;
  try { return f(...args); } catch (err) { console.warn(`amadeusDesktop.${nombre}:`, err); return undefined; }
}
const AD_VISIBILIDAD = typeof AD?.onVisibility === 'function';
const AD_ORDENES = typeof AD?.onOrder === 'function';
// Visible: dentro de Electron lo dice el proceso principal (arranca oculta); fuera, la pestaña.
let visible = AD_VISIBILIDAD ? false : document.visibilityState === 'visible';

// ===================================================================== escena
const canvas = $('#scene');
const stage = $('#stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(0x000000, 0);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 100);
camera.position.set(0, 1.3, 3.6);
const controls = new OrbitControls(camera, canvas);
controls.enabled = !DESKTOP;                     // en el escritorio, arrastrar = mover a la avatar, no la cámara
controls.target.set(0, 1.0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = true;
controls.minDistance = 0.3;
controls.maxDistance = 12;
controls.update();

const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
keyLight.position.set(1, 2.2, 2.5);
const rimLight = new THREE.DirectionalLight(0xc9c2ff, 1.4);
rimLight.position.set(-1.8, 1.6, -2);
scene.add(keyLight, rimLight, new THREE.AmbientLight(0xffffff, 0.5));

const avatarRoot = new THREE.Group();
scene.add(avatarRoot);

// sombra suave bajo el avatar
const ground = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(0,0,0,0.45)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1.1, 1.1),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.002;
  avatarRoot.add(mesh);
  return mesh;
})();

function resize() {
  const { clientWidth: w, clientHeight: h } = stage;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);
resize();

// ===================================================================== estado del avatar
let vrm = null;
let modelName = '';
let modelSource = '';
let availableBones = [];
let availableExpressions = [];
let currentPose = 'relaxed';

const boneState = new Map();   // hueso -> { cur, from, to, t0, dur }  (radianes)
const exprState = new Map();   // expresión -> { cur, from, to, t0, dur }
const gestures = new Map();    // nombre -> { name, impl, t0, dur, fade, mirror, loop, resolve }
const root = { cur: { x: 0, z: 0, ry: 0 }, from: null, to: null, t0: 0, dur: 0, walk: false, resolve: null, phase: 0 };
// Caminar "en cinta" del modo escritorio: la caja se desplaza por la pantalla y las piernas usan la
// misma zancada que move con walk. peso 0..1 se suaviza en cada fotograma.
const andarLibre = { activo: false, peso: 0, ritmo: 1 };
let reflejoReposo = 1;          // multiplicador del reposo según el estado de R.A.M.S. (solo escritorio)
const camTween = { active: false };
const idle = { enabled: !params.has('noidle'), intensity: 1, blink: true };
const LOOK_INICIAL = DESKTOP ? 'mouse' : 'camera';   // en el escritorio "mira" el cursor global
const look = { mode: LOOK_INICIAL, head: 0.35, dir: null, yaw: 0, pitch: 0 };
const lookTarget = new THREE.Object3D();
scene.add(lookTarget);
const mouseNdc = new THREE.Vector2(0, 0);
let gestureExpr = {};
let exprHoldToken = 0;
let seqToken = 0;
let background = 'gradient';
let cameraPreset = 'full';

// Tema visual (§C2.5.5): se aplica solo dentro de loadModel, antes del primer render del modelo.
let temaDeseado = params.get('theme') === 'amadeus' ? 'amadeus' : 'none';
let temaOpciones = { rim: true, scanlines: THEME_LIMITS.scanlinesDefault };
let temaActivo = null;          // { update(t), dispose() } del tema aplicado, o null
let temaFallido = false;        // el último intento de aplicar "amadeus" falló (import o aplicación)
const temaNombre = () => (temaActivo ? 'amadeus' : 'none');

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();

function tweenStep(s, t) {
  if (s.to == null) return;
  const k = s.dur <= 0 ? 1 : clamp((t - s.t0) / s.dur, 0, 1);
  const e = ease(k);
  if (typeof s.to === 'number') s.cur = lerp(s.from, s.to, e);
  else for (const a of AXES) s.cur[a] = lerp(s.from[a], s.to[a], e);
  if (k >= 1) { s.cur = typeof s.to === 'number' ? s.to : { ...s.to }; s.to = null; }
}

function boneEntry(name) {
  let s = boneState.get(name);
  if (!s) { s = { cur: { x: 0, y: 0, z: 0 }, to: null }; boneState.set(name, s); }
  return s;
}

function assertBone(name) {
  if (!vrm) fail('No hay ningún modelo cargado todavía.');
  if (!vrm.humanoid.getNormalizedBoneNode(name)) {
    fail(`El hueso "${name}" no existe en este modelo. Disponibles: ${availableBones.join(', ')}`);
  }
}

/** Fija el objetivo de un hueso (grados). Ejes omitidos se conservan. */
function setBone(name, deg, dur = 0.4, relative = false) {
  const s = boneEntry(name);
  const target = s.to ? { ...s.to } : { ...s.cur };
  for (const a of AXES) {
    const v = num(deg?.[a], null);
    if (v === null) continue;
    target[a] = relative ? target[a] + v * DEG : v * DEG;
  }
  s.from = { ...s.cur };
  s.to = target;
  s.t0 = now();
  s.dur = Math.max(0, dur);
}

function setExpr(name, value, dur = 0.3) {
  let s = exprState.get(name);
  if (!s) { s = { cur: 0, to: null }; exprState.set(name, s); }
  s.from = s.cur;
  s.to = clamp(value, 0, 1);
  s.t0 = now();
  s.dur = Math.max(0, dur);
}

function clearEmotions(dur = 0.3, except = null) {
  for (const e of [...EMOTIONS, ...exprState.keys()]) {
    if (e === except || VISEMES.includes(e) || e.startsWith('blink') || e.startsWith('look')) continue;
    if (exprState.has(e) || EMOTIONS.includes(e)) setExpr(e, 0, dur);
  }
}

// ===================================================================== manos
const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'];
const SHAPES = {
  open:      { Thumb: 0,   Index: 0,    Middle: 0,    Ring: 0,    Little: 0 },
  relaxed:   { Thumb: 0.25, Index: 0.22, Middle: 0.28, Ring: 0.34, Little: 0.4 },
  fist:      { Thumb: 1,   Index: 1,    Middle: 1,    Ring: 1,    Little: 1 },
  point:     { Thumb: 0.9, Index: 0,    Middle: 1,    Ring: 1,    Little: 1 },
  peace:     { Thumb: 0.9, Index: 0,    Middle: 0,    Ring: 1,    Little: 1 },
  thumbs_up: { Thumb: 0,   Index: 1,    Middle: 1,    Ring: 1,    Little: 1 },
};
/** Devuelve {hueso: {x,y,z}} en grados para una forma de mano. */
function handShape(side, shape) {
  const c = SHAPES[shape] || fail(`Forma de mano desconocida "${shape}". Opciones: ${HAND_SHAPES.join(', ')}`);
  const sg = side === 'left' ? -1 : 1;
  const out = {};
  for (const f of FINGERS) {
    const k = c[f];
    if (f === 'Thumb') {
      out[`${side}ThumbMetacarpal`] = { x: 0, y: -sg * 38 * k, z: sg * 22 * k };
      out[`${side}ThumbProximal`] = { x: 0, y: -sg * 18 * k, z: sg * 26 * k };
      out[`${side}ThumbDistal`] = { x: 0, y: 0, z: sg * 40 * k };
    } else {
      out[`${side}${f}Proximal`] = { x: 0, y: 0, z: sg * 75 * k };
      out[`${side}${f}Intermediate`] = { x: 0, y: 0, z: sg * 90 * k };
      out[`${side}${f}Distal`] = { x: 0, y: 0, z: sg * 60 * k };
    }
  }
  return out;
}
const handsShape = (shape) => ({ ...handShape('left', shape), ...handShape('right', shape) });

function applyHand(side, shape, dur = 0.25) {
  const sides = side === 'both' || !side ? ['left', 'right'] : [side];
  for (const sd of sides) {
    if (!['left', 'right'].includes(sd)) fail('side debe ser left, right o both');
    for (const [b, r] of Object.entries(handShape(sd, shape))) {
      if (vrm?.humanoid.getNormalizedBoneNode(b)) setBone(b, r, dur);
    }
  }
}

const isFinger = (b) => /(Thumb|Index|Middle|Ring|Little)/.test(b);

function applyPose(name, dur = 0.6) {
  const pose = POSES[name] || fail(`Pose desconocida "${name}". Opciones: ${Object.keys(POSES).join(', ')}`);
  const names = new Set([...boneState.keys(), ...Object.keys(pose.bones)]);
  for (const b of names) {
    if (isFinger(b)) continue;
    setBone(b, { x: 0, y: 0, z: 0, ...(pose.bones[b] || {}) }, dur);
  }
  if (pose.hands) applyHand('both', pose.hands, dur);
  currentPose = name;
}

// ===================================================================== gestos
function squat(deg) {
  return {
    add: {
      leftUpperLeg: { x: -deg }, rightUpperLeg: { x: -deg },
      leftLowerLeg: { x: deg * 2 }, rightLowerLeg: { x: deg * 2 },
      leftFoot: { x: -deg }, rightFoot: { x: -deg },
    },
    rootY: -0.8 * (1 - Math.cos(deg * DEG)),
  };
}
const merge = (...fs) => {
  const out = { set: {}, add: {}, expr: {}, rootY: 0 };
  for (const f of fs) {
    if (!f) continue;
    Object.assign(out.set, f.set);
    for (const [b, r] of Object.entries(f.add || {})) {
      const o = (out.add[b] ||= {});
      for (const a of AXES) if (r[a] != null) o[a] = (o[a] || 0) + r[a];
    }
    Object.assign(out.expr, f.expr);
    out.rootY += f.rootY || 0;
  }
  return out;
};

const GESTURE_IMPL = {
  wave: (t) => {
    const o = S(t * 9);
    return {
      set: {
        rightUpperArm: { x: 0, y: 12, z: 14 },
        rightLowerArm: { x: 0, y: 0, z: -100 + 20 * o },
        rightHand: { x: 0, y: 0, z: -8 * o },
        ...handShape('right', 'open'),
      },
      add: { head: { z: -5 }, spine: { z: -2 } },
      expr: { happy: 0.6 },
    };
  },
  nod: (t, p) => {
    const k = Math.pow(S(TAU * p), 2);
    return { add: { head: { x: 15 * k }, neck: { x: 5 * k } } };
  },
  shake_head: (t, p) => {
    const k = S(TAU * 2.5 * p) * (1 - 0.3 * p);
    return { add: { head: { y: 22 * k }, neck: { y: 6 * k } } };
  },
  bow: (t, p) => {
    const k = plateau(p, 0.3);
    return {
      add: { spine: { x: 26 * k }, chest: { x: 10 * k }, head: { x: 12 * k } },
      set: { leftUpperArm: { z: -80 }, rightUpperArm: { z: 80 } },
    };
  },
  tilt_head: (t, p) => {
    const k = plateau(p, 0.25);
    return { add: { head: { z: 14 * k }, neck: { z: 4 * k } }, expr: { relaxed: 0.3 } };
  },
  jump: (t, p) => {
    if (p < 0.28) { const k = S((p / 0.28) * Math.PI); return merge(squat(26 * k), { add: { leftUpperArm: { x: 25 * k }, rightUpperArm: { x: 25 * k } } }); }
    if (p < 0.78) {
      const q = (p - 0.28) / 0.5;
      return {
        rootY: 0.22 * S(q * Math.PI),
        add: {
          leftUpperArm: { z: 40 * S(q * Math.PI) }, rightUpperArm: { z: -40 * S(q * Math.PI) },
          leftLowerLeg: { x: 20 * S(q * Math.PI) }, rightLowerLeg: { x: 20 * S(q * Math.PI) },
        },
        expr: { happy: 0.8 },
      };
    }
    const k = S(((p - 0.78) / 0.22) * Math.PI);
    return squat(18 * k);
  },
  clap: (t) => {
    const c = 0.5 + 0.5 * S(t * 13 - Math.PI / 2);
    return {
      set: {
        leftUpperArm: { x: 0, y: -72, z: -28 }, rightUpperArm: { x: 0, y: 72, z: 28 },
        leftLowerArm: { x: 0, y: -(38 + 24 * c), z: 32 }, rightLowerArm: { x: 0, y: 38 + 24 * c, z: -32 },
        leftHand: { x: -70, y: 0, z: 0 }, rightHand: { x: -70, y: 0, z: 0 },
        ...handsShape('open'),
      },
      expr: { happy: 0.8 },
    };
  },
  shrug: (t, p) => {
    const k = plateau(p, 0.3);
    return {
      add: { leftShoulder: { z: 14 * k }, rightShoulder: { z: -14 * k }, head: { z: 8 * k } },
      set: {
        leftUpperArm: { x: 0, y: -10, z: -70 }, rightUpperArm: { x: 0, y: 10, z: 70 },
        leftLowerArm: { x: 0, y: -70, z: 0 }, rightLowerArm: { x: 0, y: 70, z: 0 },
        leftHand: { x: 110, y: 0, z: 0 }, rightHand: { x: 110, y: 0, z: 0 },
        ...handsShape('open'),
      },
      expr: { relaxed: 0.4 },
    };
  },
  cheer: (t, p) => {
    const o = S(t * 8);
    return {
      set: {
        leftUpperArm: { x: 0, y: 0, z: 58 + 10 * o }, rightUpperArm: { x: 0, y: 0, z: -58 - 10 * o },
        leftLowerArm: { x: 0, y: 0, z: 14 }, rightLowerArm: { x: 0, y: 0, z: -14 },
        ...handsShape('fist'),
      },
      add: { head: { x: -8 } },
      expr: { happy: 1 },
      rootY: 0.035 * Math.abs(S(t * 8)) * plateau(p, 0.15),
    };
  },
  point: () => ({
    set: {
      rightUpperArm: { x: 0, y: 72, z: 12 }, rightLowerArm: { x: 0, y: 8, z: 0 },
      rightHand: { x: 0, y: 0, z: 0 },
      ...handShape('right', 'point'),
    },
    add: { head: { y: -4 } },
  }),
  dance: (t) => {
    const b = t * TAU * 1.1;
    const bounce = 0.5 + 0.5 * S(2 * b);
    return merge(
      {
        add: {
          hips: { z: 7 * S(b), y: 10 * S(b / 2) },
          spine: { z: -5 * S(b) }, chest: { y: -8 * S(b / 2) },
          head: { z: 6 * S(b + 0.6), x: 4 * S(2 * b) },
        },
        set: {
          leftUpperArm: { x: -22 * S(b), y: -10, z: -66 + 8 * S(2 * b) },
          rightUpperArm: { x: 22 * S(b), y: 10, z: 66 - 8 * S(2 * b) },
          leftLowerArm: { x: 0, y: -85, z: 20 }, rightLowerArm: { x: 0, y: 85, z: -20 },
          ...handsShape('fist'),
        },
        expr: { happy: 0.7 },
      },
      squat(10 * bounce),
    );
  },
  laugh: (t, p) => {
    const k = plateau(p, 0.2);
    const o = S(t * 22);
    return {
      add: {
        chest: { x: 3 * o * k }, spine: { x: -4 * k },
        head: { x: -10 * k + 2 * o * k, z: 5 * k },
        leftShoulder: { z: 2 * o * k }, rightShoulder: { z: -2 * o * k },
      },
      expr: { happy: 1, aa: (0.3 + 0.3 * Math.abs(S(t * 11))) * k },
    };
  },
  look_around: (t, p) => ({
    add: { head: { y: 32 * S(TAU * p), x: -4 * S(TAU * 2 * p) }, neck: { y: 12 * S(TAU * p) } },
  }),
  think: (t, p) => {
    const k = plateau(p, 0.2);
    const th = POSES.thinking.bones;
    return {
      set: { ...th, ...handShape('right', 'relaxed') },
      add: { head: { z: -6 * k, x: -6 * k + 3 * S(t * 2) * k } },
      expr: { relaxed: 0.3 },
    };
  },
  surprise: (t, p) => {
    const k = plateau(p, 0.15);
    return {
      add: {
        spine: { x: -8 * k }, head: { x: -6 * k },
        leftUpperArm: { z: 25 * k }, rightUpperArm: { z: -25 * k },
        leftLowerArm: { y: -40 * k }, rightLowerArm: { y: 40 * k },
      },
      expr: { surprised: 1 },
      rootY: 0.03 * S(clamp(p / 0.25, 0, 1) * Math.PI),
    };
  },
};

function mirrorMap(m) {
  const o = {};
  for (const [b, r] of Object.entries(m || {})) {
    const nb = b.startsWith('left') ? 'right' + b.slice(4) : b.startsWith('right') ? 'left' + b.slice(5) : b;
    o[nb] = { x: r.x, y: r.y != null ? -r.y : undefined, z: r.z != null ? -r.z : undefined };
  }
  return o;
}

function startGesture(name, opts = {}) {
  const impl = GESTURE_IMPL[name] || fail(`Gesto desconocido "${name}". Opciones: ${Object.keys(GESTURES).join(', ')}`);
  const meta = GESTURES[name];
  const prev = gestures.get(name);
  prev?.resolve?.();
  const dur = clamp(num(opts.duration, meta.duration), 0.3, 120);
  const side = opts.side || 'right';
  if (!['left', 'right'].includes(side)) fail('side debe ser left o right');
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  gestures.set(name, {
    name, impl, t0: now(), dur, fade: Math.min(0.35, dur * 0.25),
    mirror: meta.sided && side === 'left', loop: !!opts.loop, resolve,
  });
  return { dur, done };
}

function stopGestures() {
  for (const g of gestures.values()) g.resolve?.();
  gestures.clear();
}

// ===================================================================== movimiento por el escenario
function moveAvatar(c) {
  const cur = root.cur;
  const target = { ...cur };
  const rel = !!c.relative;
  const x = num(c.x, null), z = num(c.z, null), rot = num(c.rotation ?? c.rotationY ?? c.angle, null);
  if (x !== null) target.x = clamp(rel ? cur.x + x : x, -3, 3);
  if (z !== null) target.z = clamp(rel ? cur.z + z : z, -3, 3);
  if (rot !== null) target.ry = rel ? cur.ry + rot * DEG : rot * DEG;
  const dist = Math.hypot(target.x - cur.x, target.z - cur.z);
  const dur = clamp(num(c.duration, dist > 0.01 ? Math.max(0.6, dist / 0.8) : 0.7), 0.05, 30);
  root.resolve?.();
  root.from = { ...cur };
  root.to = target;
  root.t0 = now();
  root.dur = dur;
  root.walk = c.walk ?? dist > 0.05;
  return { dur, done: new Promise((r) => { root.resolve = r; }) };
}

// ===================================================================== mirada
const LOOK_DIRS = {
  forward: [0, 0], left: [1, 0], right: [-1, 0], up: [0, 1], down: [0, -1],
  up_left: [1, 1], up_right: [-1, 1], down_left: [1, -1], down_right: [-1, -1],
};
function setLook(c) {
  const at = c.at || c.target || 'camera';
  if (!LOOK_TARGETS.includes(at)) fail(`Mirada desconocida "${at}". Opciones: ${LOOK_TARGETS.join(', ')}`);
  look.mode = at;
  look.head = clamp(num(c.head, look.head), 0, 1);
  if (at === 'point') {
    const x = num(c.x, null), y = num(c.y, null), z = num(c.z, null);
    if (x === null || y === null || z === null) fail('at:"point" requiere x, y, z (metros).');
    lookTarget.position.set(x, y, z);
  }
  look.dir = LOOK_DIRS[at] || null;
  if (vrm?.lookAt) {
    if (at === 'none') {
      vrm.lookAt.target = null;
      vrm.lookAt.yaw = 0;
      vrm.lookAt.pitch = 0;
    } else {
      vrm.lookAt.target = at === 'camera' ? camera : lookTarget;
    }
  }
}

function headWorld(out) {
  const node = vrm?.humanoid.getRawBoneNode('head');
  if (node) node.getWorldPosition(out);
  else out.set(root.cur.x, 1.4, root.cur.z);
  return out;
}

const raycaster = new THREE.Raycaster();
const lookPlane = new THREE.Plane();
function updateLookTarget() {
  if (!vrm) return;
  if (look.mode === 'mouse') {
    headWorld(tmpV);
    lookPlane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1), tmpV2.set(0, 0, tmpV.z + 0.8));
    raycaster.setFromCamera(mouseNdc, camera);
    raycaster.ray.intersectPlane(lookPlane, lookTarget.position);
  } else if (look.dir) {
    headWorld(tmpV);
    const [h, v] = look.dir;
    tmpV2.set(h * 1.6, v * 0.9, 2).applyAxisAngle(new THREE.Vector3(0, 1, 0), root.cur.ry);
    lookTarget.position.copy(tmpV).add(tmpV2);
  }
}

// ===================================================================== cámara y fondo
function setCamera(preset, dur = 0.9) {
  if (!CAMERA_PRESETS.includes(preset)) fail(`Encuadre desconocido "${preset}". Opciones: ${CAMERA_PRESETS.join(', ')}`);
  cameraPreset = preset;
  // encuadra la posición final si el avatar se está moviendo
  const head = headWorld(new THREE.Vector3());
  if (root.to) { head.x += root.to.x - root.cur.x; head.z += root.to.z - root.cur.z; }
  const h = Math.max(0.6, head.y + 0.15);
  const fov = Math.tan((camera.fov * DEG) / 2) * 2;
  const portrait = camera.aspect < 0.9 ? 0.9 / camera.aspect : 1;
  let target, dist;
  if (preset === 'face') { target = head.clone().add(new THREE.Vector3(0, 0.02, 0)); dist = 0.36 / fov; }
  else if (preset === 'bust') { target = head.clone().add(new THREE.Vector3(0, -0.2, 0)); dist = (0.75 / fov) * Math.sqrt(portrait); }
  else if (preset === 'full' && DESKTOP) {
    // caja del escritorio: el cuerpo entero la llena y los pies quedan sobre la línea del suelo (borde inferior)
    target = new THREE.Vector3(head.x, h * 0.52, head.z); dist = (h * 1.12) / fov;
  }
  else if (preset === 'full') { target = new THREE.Vector3(head.x, h * 0.53, head.z); dist = ((h * 1.3) / fov) * portrait; }
  else { target = new THREE.Vector3(head.x, h * 0.5, head.z); dist = ((h * 2.1) / fov) * portrait; }
  const fwd = new THREE.Vector3(0, 0, 1); // la cámara siempre mira el escenario de frente
  const pos = target.clone().add(fwd.multiplyScalar(dist)).add(new THREE.Vector3(0, dist * 0.04, 0));
  Object.assign(camTween, {
    active: true, t0: now(), dur: Math.max(0.01, dur),
    fromPos: camera.position.clone(), fromTarget: controls.target.clone(), toPos: pos, toTarget: target,
  });
}

function setBackground(mode) {
  const isHex = typeof mode === 'string' && /^#[0-9a-f]{3,8}$/i.test(mode);
  if (!isHex && !BACKGROUNDS.includes(mode)) fail(`Fondo desconocido "${mode}". Opciones: ${BACKGROUNDS.join(', ')} o #rrggbb`);
  background = mode;
  document.body.dataset.bg = isHex ? 'custom' : mode;
  stage.style.background = isHex ? mode : '';
  ground.visible = mode === 'gradient' || isHex;
  syncChips('#bg-chips', mode);
}

// ===================================================================== voz y labios
// bubble: si el speak en curso mostró el globo (solo entonces lo esconde al terminar o al cortarse).
const speech = { active: false, text: '', start: 0, cps: 14, tts: false, boundaryIdx: 0, boundaryAt: 0, offset: 0, token: 0, bubble: false };
const visemes = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
const tts = { enabled: !OBS || params.has('tts'), voiceURI: '', pitch: 1.1, unlocked: false };
try {
  const saved = JSON.parse(localStorage.getItem('vtuber-tts') || '{}');
  if (typeof saved.enabled === 'boolean' && !OBS) tts.enabled = saved.enabled;
  if (saved.voiceURI) tts.voiceURI = saved.voiceURI;
  if (saved.pitch) tts.pitch = saved.pitch;
} catch {}
const saveTts = () => { try { localStorage.setItem('vtuber-tts', JSON.stringify({ enabled: tts.enabled, voiceURI: tts.voiceURI, pitch: tts.pitch })); } catch {} };

const bubble = $('#bubble');
let bubbleTimer = 0;
function showBubble(text) {
  clearTimeout(bubbleTimer);
  bubble.textContent = text;
  bubble.hidden = false;
  bubble.classList.remove('fade');
}
function hideBubble(delay = 1200) {
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => {
    bubble.classList.add('fade');
    bubbleTimer = setTimeout(() => { bubble.hidden = true; }, 300);
  }, delay);
}

// Nombres de voces femeninas habituales (Windows, macOS, Google, Edge) para voice: "female".
const FEMALE_VOICE_HINTS = ['sabina', 'helena', 'laura', 'dalia', 'elvira', 'salome', 'paloma', 'larissa',
  'hilda', 'lucia', 'monica', 'paulina', 'marisol', 'zira', 'female', 'mujer', 'femenina'];

/**
 * Elige la voz del TTS. `pref` (opcional) es un nombre o una lista separada por comas
 * ("Sabina,Helena" o "female"): gana la primera voz cuyo nombre la contenga, preferentemente
 * del idioma pedido. Si no hay coincidencia se usa la voz elegida en el panel o la del idioma.
 */
function pickVoice(lang, pref) {
  if (!('speechSynthesis' in window)) return null;
  const voices = speechSynthesis.getVoices();
  if (pref) {
    const want = (lang || 'es').toLowerCase().slice(0, 2);
    let hints = String(pref).toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
    if (hints.includes('female')) hints = [...hints.filter((h) => h !== 'female'), ...FEMALE_VOICE_HINTS];
    for (const sameLang of [true, false]) {
      for (const h of hints) {
        const v = voices.find((v) => (!sameLang || v.lang.toLowerCase().startsWith(want))
          && (v.name.toLowerCase().includes(h) || v.voiceURI.toLowerCase().includes(h)));
        if (v) return v;
      }
    }
  }
  if (tts.voiceURI && !lang) {
    const v = voices.find((v) => v.voiceURI === tts.voiceURI);
    if (v) return v;
  }
  const want = (lang || 'es').toLowerCase();
  return voices.find((v) => v.lang.toLowerCase() === want)
    || voices.find((v) => v.lang.toLowerCase().startsWith(want.slice(0, 2)))
    || null;
}

function splitChunks(text) {
  const parts = text.match(/[^.!?¡¿…]+[.!?…]*|[¡¿]+[^.!?…]*[.!?…]*/g) || [text];
  const chunks = [];
  let buf = '';
  for (const p of parts) {
    if ((buf + p).length > 180 && buf) { chunks.push(buf); buf = ''; }
    buf += p;
  }
  if (buf.trim()) chunks.push(buf);
  return chunks;
}

function stopSpeech() {
  speech.token++;
  if (speech.active) {
    speech.active = false;
    // se esconde el globo del habla que se corta, si lo mostró (uno con bubble:false no tiene globo)
    if (speech.bubble) hideBubble(200);
    speech.bubble = false;
  }
  try { if ('speechSynthesis' in window) speechSynthesis.cancel(); } catch {}
}

/** Dice un fragmento con TTS. Resuelve 'ok' al terminar o 'blocked' si el navegador no lo permite. */
function speakChunk(chunk, offset, opts) {
  return new Promise((res) => {
    let started = false;
    const u = new SpeechSynthesisUtterance(chunk);
    const voice = pickVoice(opts.lang, opts.voice);
    if (voice) { u.voice = voice; u.lang = voice.lang; } else if (opts.lang) u.lang = opts.lang;
    u.rate = opts.rate;
    u.pitch = opts.pitch;
    u.volume = opts.volume;
    u.onstart = () => {
      started = true;
      speech.tts = true; speech.offset = offset; speech.boundaryIdx = 0; speech.boundaryAt = now();
    };
    u.onboundary = (e) => { speech.boundaryIdx = e.charIndex; speech.boundaryAt = now(); };
    u.onend = () => res('ok');
    u.onerror = (e) => res(!started && !['interrupted', 'canceled'].includes(e.error) ? 'blocked' : 'ok');
    // si no arranca (sin permiso de audio, sin voces), seguimos con labios en silencio
    setTimeout(() => { if (!started) { try { speechSynthesis.cancel(); } catch {} res('blocked'); } }, 2500);
    // y si nunca llega onend, no nos quedamos colgados
    setTimeout(() => res('ok'), (chunk.length / speech.cps + 5) * 2000);
    speechSynthesis.speak(u);
  });
}

function speak(c) {
  const text = String(c.text ?? '').trim();
  if (!text) fail('speak requiere "text".');
  if (text.length > 2000) fail('El texto es demasiado largo (máx. 2000 caracteres).');
  if (c.gesture && !GESTURE_IMPL[c.gesture]) fail(`Gesto desconocido "${c.gesture}". Opciones: ${Object.keys(GESTURES).join(', ')}`);
  if (c.emotion && c.emotion !== 'neutral' && vrm && !vrm.expressionManager.getExpression(c.emotion)) {
    fail(`Emoción "${c.emotion}" no existe. Disponibles: ${availableExpressions.join(', ')}`);
  }
  // bubble:false = habla sin globo de texto; tampoco esconde ni reinicia el globo que se esté
  // desvaneciendo de otro speak. Por defecto true (panel manual, MCP y clientes antiguos).
  const conGlobo = speakBubble(c.bubble);
  if (conGlobo === null) fail('"bubble" debe ser true o false.');
  stopSpeech();
  const token = ++speech.token;
  const rate = clamp(num(c.rate, 1), 0.5, 2);
  const pitch = clamp(num(c.pitch, tts.pitch), 0, 2);
  Object.assign(speech, {
    active: true, text, start: now(), cps: 14 * rate, tts: false, boundaryIdx: 0, boundaryAt: 0, offset: 0, bubble: conGlobo,
  });
  if (conGlobo) showBubble(text);
  if (c.emotion && vrm) applyExpression({ name: c.emotion, value: num(c.emotionValue, 0.85) });
  if (c.gesture && vrm) startGesture(c.gesture, { side: c.side });

  const est = Math.max(1, text.length / speech.cps + 0.3);
  // ?obs=1 / ?desktop=1 sin ?tts=1 ignoran c.tts: nunca suenan dos voces a la vez.
  const useTts = TTS_PERMITIDO && (c.tts ?? tts.enabled) && 'speechSynthesis' in window;
  let done;
  if (useTts) {
    done = (async () => {
      let offset = 0;
      const opts = { lang: c.lang, voice: c.voice, rate, pitch, volume: clamp(num(c.volume, 1), 0, 1) };
      for (const chunk of splitChunks(text)) {
        if (token !== speech.token) return;
        const r = await speakChunk(chunk, offset, opts);
        if (r === 'blocked') {
          // sin audio: completamos la animación de labios con el tiempo estimado
          speech.tts = false;
          speech.start = now() - offset / speech.cps;
          await wait(((text.length - offset) / speech.cps + 0.3) * 1000);
          return;
        }
        offset += chunk.length;
      }
    })();
  } else {
    done = wait(est * 1000);
  }
  const finished = done.then(() => {
    if (token !== speech.token) return;
    speech.active = false;
    if (speech.bubble) hideBubble();
    speech.bubble = false;
    if (c.emotion && c.keepEmotion !== true) clearEmotions(0.6);
  });
  return { result: { estimatedSeconds: +est.toFixed(1), voice: useTts ? 'tts' : 'silent', bubble: conGlobo }, done: finished };
}

const VOWEL_MAP = { a: 'aa', á: 'aa', e: 'ee', é: 'ee', i: 'ih', í: 'ih', y: 'ih', o: 'oh', ó: 'oh', u: 'ou', ú: 'ou', ü: 'ou' };
function updateVisemes(t, dt) {
  const target = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
  if (speech.active) {
    let idx = speech.tts && speech.boundaryAt
      ? speech.offset + speech.boundaryIdx + (t - speech.boundaryAt) * speech.cps
      : (t - speech.start) * speech.cps;
    const len = speech.text.length;
    if (idx >= len) idx = speech.tts ? idx % len : len - 1;
    const ch = (speech.text[Math.floor(idx)] || ' ').toLowerCase();
    const v = VOWEL_MAP[ch];
    const jitter = 0.75 + 0.25 * S(t * 31) * S(t * 17);
    if (v) target[v] = 0.85 * jitter;
    else if (/[mbp]/.test(ch)) { /* boca cerrada */ }
    else if (/[a-zñ]/.test(ch)) target.aa = 0.22 * jitter;
  }
  const k = Math.min(1, dt * 22);
  for (const v of VISEMES) visemes[v] = lerp(visemes[v], target[v], k);
}

// ===================================================================== expresiones
function applyExpression(c) {
  if (!vrm) fail('No hay ningún modelo cargado todavía.');
  const dur = clamp(num(c.duration, 0.3), 0, 10);
  const exclusive = c.exclusive !== false;
  const token = ++exprHoldToken;
  if (c.values && typeof c.values === 'object') {
    if (exclusive) clearEmotions(dur);
    for (const [n, v] of Object.entries(c.values)) {
      if (!vrm.expressionManager.getExpression(n)) fail(`Expresión "${n}" no existe. Disponibles: ${availableExpressions.join(', ')}`);
      setExpr(n, clamp(num(v, 1), 0, 1), dur);
    }
  } else {
    const name = String(c.name || '');
    if (!name) fail('expression requiere "name" o "values".');
    if (name === 'neutral') {
      clearEmotions(dur);
    } else {
      if (!vrm.expressionManager.getExpression(name)) {
        fail(`Expresión "${name}" no existe en este modelo. Disponibles: ${availableExpressions.join(', ')}`);
      }
      if (exclusive && EMOTIONS.includes(name)) clearEmotions(dur, name);
      setExpr(name, clamp(num(c.value, 1), 0, 1), dur);
    }
    syncChips('#emotion-chips', name);
  }
  const hold = num(c.hold, 0);
  let done = wait(dur * 1000);
  if (hold > 0) {
    done = wait((dur + hold) * 1000).then(() => {
      if (token === exprHoldToken) { clearEmotions(0.5); syncChips('#emotion-chips', 'neutral'); }
    });
  }
  return { done };
}

// parpadeo automático
const blink = { next: now() + 2, start: -10, double: false };
function blinkValue(t) {
  if (!idle.blink) return 0;
  if (t >= blink.next) {
    blink.start = t;
    blink.double = Math.random() < 0.18;
    blink.next = t + (blink.double ? 0.35 : 2 + Math.random() * 4);
  }
  const bt = t - blink.start;
  if (bt < 0.06) return bt / 0.06;
  if (bt < 0.16) return 1 - (bt - 0.06) / 0.1;
  return 0;
}

// ===================================================================== bucle de animación por fotograma
const followSmooth = { yaw: 0, pitch: 0 };
function composeBones(t, dt) {
  for (const s of boneState.values()) tweenStep(s, t);
  const out = new Map();
  for (const [b, s] of boneState) out.set(b, { ...s.cur });
  const get = (b) => {
    let v = out.get(b);
    if (!v) { boneEntry(b); v = { x: 0, y: 0, z: 0 }; out.set(b, v); }
    return v;
  };
  const add = (b, x = 0, y = 0, z = 0) => { const v = get(b); v.x += x * DEG; v.y += y * DEG; v.z += z * DEG; };

  // gestos
  gestureExpr = {};
  let rootY = 0;
  for (const [name, g] of gestures) {
    let gt = t - g.t0;
    if (gt >= g.dur) {
      if (g.loop) { g.t0 = t; gt = 0; } else { gestures.delete(name); g.resolve?.(); continue; }
    }
    const w = g.loop ? smooth(0, g.fade, t - (g.firstT0 ??= g.t0)) : smooth(0, g.fade, gt) * smooth(0, g.fade, g.dur - gt);
    const f = g.impl(gt, gt / g.dur, g) || {};
    const set = g.mirror ? mirrorMap(f.set) : f.set;
    const ad = g.mirror ? mirrorMap(f.add) : f.add;
    for (const [b, r] of Object.entries(set || {})) {
      const v = get(b);
      for (const a of AXES) if (r[a] != null) v[a] = lerp(v[a], r[a] * DEG, w);
    }
    for (const [b, r] of Object.entries(ad || {})) {
      const v = get(b);
      for (const a of AXES) if (r[a] != null) v[a] += r[a] * DEG * w;
    }
    for (const [e, val] of Object.entries(f.expr || {})) gestureExpr[e] = Math.max(gestureExpr[e] || 0, val * w);
    rootY += (f.rootY || 0) * (g.loop ? w : 1);
  }

  // caminar (por el escenario con move, o por la pantalla en modo escritorio: misma zancada)
  let walkW = 0;
  let ritmo = 1;
  if (root.to && root.walk) {
    const k = clamp((t - root.t0) / root.dur, 0, 1);
    walkW = smooth(0, 0.12, k) * (1 - smooth(0.88, 1, k));
  }
  if (andarLibre.peso > walkW) { walkW = andarLibre.peso; ritmo = andarLibre.ritmo; }
  if (walkW > 0) {
    root.phase += dt * TAU * 1.7 * ritmo;
    const ph = root.phase, a = 24 * walkW;
    add('leftUpperLeg', -a * S(ph)); add('rightUpperLeg', a * S(ph));
    add('leftLowerLeg', 34 * walkW * Math.max(0, -S(ph - 0.6))); add('rightLowerLeg', 34 * walkW * Math.max(0, S(ph - 0.6)));
    add('leftUpperArm', a * 0.6 * S(ph)); add('rightUpperArm', -a * 0.6 * S(ph));
    add('spine', 0, 4 * walkW * S(ph));
    rootY += 0.018 * walkW * Math.abs(S(ph));
  }

  // reposo: respiración, balanceo y micro-movimientos (en el escritorio, modulados por el estado de R.A.M.S.)
  if (idle.enabled) {
    const i = idle.intensity * reflejoReposo * (1 - walkW * 0.7);
    const br = S(t * TAU / 4.2);
    add('spine', 0.8 * br * i);
    add('chest', 1.2 * br * i);
    add('upperChest', 0.8 * br * i);
    add('leftShoulder', 0, 0, 0.8 * br * i); add('rightShoulder', 0, 0, -0.8 * br * i);
    add('hips', 0, 1.2 * S(t * 0.37) * i, 1.0 * S(t * 0.5) * i);
    add('spine', 0, 0, -1.0 * S(t * 0.5) * i);
    add('neck', 1.2 * S(t * 0.61) * i, 2.0 * S(t * 0.23 + 1) * i, 0.8 * S(t * 0.31) * i);
    add('head', 1.0 * S(t * 0.7 + 2) * i, 1.5 * S(t * 0.29) * i, 1.2 * S(t * 0.43 + 0.5) * i);
    add('leftUpperArm', 0, 0, -1.5 * br * i); add('rightUpperArm', 0, 0, 1.5 * br * i);
  }

  // la cabeza acompaña a la mirada
  let tYaw = 0, tPitch = 0;
  if (look.mode !== 'none' && look.head > 0) {
    const target = look.mode === 'camera' ? camera.position : lookTarget.position;
    headWorld(tmpV);
    tmpV2.copy(target).sub(tmpV).applyAxisAngle(new THREE.Vector3(0, 1, 0), -root.cur.ry);
    if (tmpV2.z > 0.05) {
      tYaw = clamp(Math.atan2(tmpV2.x, tmpV2.z), -0.9, 0.9);
      tPitch = clamp(Math.atan2(tmpV2.y, Math.hypot(tmpV2.x, tmpV2.z)), -0.5, 0.5);
    }
  }
  const fk = Math.min(1, dt * 4);
  followSmooth.yaw = lerp(followSmooth.yaw, tYaw * look.head, fk);
  followSmooth.pitch = lerp(followSmooth.pitch, tPitch * look.head, fk);
  const hv = get('head'), nv = get('neck');
  hv.y += followSmooth.yaw * 0.6; nv.y += followSmooth.yaw * 0.4;
  hv.x -= followSmooth.pitch * 0.6; nv.x -= followSmooth.pitch * 0.4;

  // aplicar al modelo. Las poses y gestos están en la convención de VRM 1.0; en un VRM 0.x
  // (girado 180° por rotateVRM0) los ejes X y Z de los huesos normalizados quedan invertidos,
  // así que se niegan: R_y(π)·R(x,y,z)·R_y(π)⁻¹ = R(−x, y, −z). Sin esto los brazos «bajados»
  // de la pose relajada suben y los dedos se doblan hacia atrás.
  const vrm0 = vrm.meta?.metaVersion === '0';
  for (const [b, v] of out) {
    const node = vrm.humanoid.getNormalizedBoneNode(b);
    if (node) node.rotation.set(vrm0 ? -v.x : v.x, v.y, vrm0 ? -v.z : v.z);
  }
  vrm.scene.position.y = rootY;
}

function updateRoot(t) {
  if (root.to) {
    const k = clamp((t - root.t0) / root.dur, 0, 1);
    const e = root.walk ? k * k * (3 - 2 * k) : ease(k);
    root.cur = { x: lerp(root.from.x, root.to.x, e), z: lerp(root.from.z, root.to.z, e), ry: lerp(root.from.ry, root.to.ry, e) };
    if (k >= 1) { root.cur = { ...root.to }; root.to = null; root.resolve?.(); root.resolve = null; }
  }
  avatarRoot.position.set(root.cur.x, 0, root.cur.z);
  avatarRoot.rotation.y = root.cur.ry;
}

function updateExpressions(t, dt) {
  for (const s of exprState.values()) tweenStep(s, t);
  updateVisemes(t, dt);
  const em = vrm.expressionManager;
  const values = {};
  for (const n of availableExpressions) values[n] = 0; // lo que nadie controla vuelve a 0
  for (const [n, s] of exprState) values[n] = s.cur;
  for (const [n, v] of Object.entries(gestureExpr)) values[n] = Math.max(values[n] || 0, v);
  for (const v of VISEMES) values[v] = Math.max(values[v] || 0, visemes[v]);
  values.blink = Math.max(values.blink || 0, blinkValue(t));
  for (const [n, v] of Object.entries(values)) {
    if (em.getExpression(n)) em.setValue(n, clamp(v, 0, 1));
  }
}

function updateCamera(t) {
  if (!camTween.active) return;
  const k = clamp((t - camTween.t0) / camTween.dur, 0, 1);
  const e = ease(k);
  camera.position.lerpVectors(camTween.fromPos, camTween.toPos, e);
  controls.target.lerpVectors(camTween.fromTarget, camTween.toTarget, e);
  if (k >= 1) camTween.active = false;
}

function updateBubble() {
  if (bubble.hidden || !vrm) return;
  headWorld(tmpV).add(new THREE.Vector3(0, 0.22, 0)).project(camera);
  const r = stage.getBoundingClientRect();
  let x, y;
  if (DESKTOP) {
    // en el escritorio el globo puede salir de la caja (no recibe clics): se limita a la ventana
    const bw = bubble.offsetWidth || 240, bh = bubble.offsetHeight || 60;
    x = clamp((tmpV.x * 0.5 + 0.5) * r.width, -esc.x + bw / 2 + 8, Math.max(-esc.x + bw / 2 + 8, innerWidth - esc.x - bw / 2 - 8));
    y = clamp((-tmpV.y * 0.5 + 0.5) * r.height, -esc.y + bh + 8, r.height - 20);
  } else {
    x = clamp((tmpV.x * 0.5 + 0.5) * r.width, 120, r.width - 120);
    y = clamp((-tmpV.y * 0.5 + 0.5) * r.height, 90, r.height - 20);
  }
  bubble.style.left = `${x}px`;
  bubble.style.top = `${y}px`;
}

let last = now();
let ultimoRender = -1;
let renderActivo = false;
let gpuListo = Promise.resolve();   // se resuelve cuando terminan de compilar los shaders del modelo
let temaUpdateRoto = false;
let framesRender = 0;           // fotogramas dibujados (depuración: window.vtuber.escritorio.frames)
function frame() {
  const t = now();
  if (DESKTOP) {
    // escritorio: ≤ 30 fps en reposo y ≤ 60 fps caminando o arrastrando
    const fps = escritorioEnMovimiento() ? 60 : 30;
    if (ultimoRender >= 0 && t - ultimoRender < 1 / fps - 0.0015) return;
    ultimoRender = t;
  }
  const dt = Math.min(0.1, t - last);
  last = t;
  if (DESKTOP) actualizarEscritorio(t, dt);
  if (vrm) {
    updateRoot(t);
    updateLookTarget();
    composeBones(t, dt);
    updateExpressions(t, dt);
    vrm.update(dt);
  }
  if (temaActivo && !temaUpdateRoto) {
    try { temaActivo.update(t); } catch (err) {
      temaUpdateRoto = true;
      console.warn('El tema falló en update(); se deja de animar:', err);
    }
  }
  updateCamera(t);
  controls.update();
  // en el escritorio, con la caja entera fuera de la pantalla no hay nada que dibujar
  if (!(DESKTOP && cajaFueraDePantalla())) {
    renderer.render(scene, camera);
    framesRender++;
    if (DESKTOP) muestrearHit();   // el búfer de dibujo solo es legible ahora, en esta misma tarea
  }
  updateBubble();
}
function reanudarRender() {
  if (renderActivo) return;
  renderActivo = true;
  last = now();
  renderer.setAnimationLoop(frame);
}
function pausarRender() {
  if (!renderActivo) return;
  renderActivo = false;
  renderer.setAnimationLoop(null);
}

// ===================================================================== carga de modelos
const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));
if (DESKTOP) {
  // La CSP del overlay de Amadeus Desktop no permite fetch() de URLs blob: (connect-src), que es como
  // ImageBitmapLoader decodifica las texturas incrustadas en el .vrm. Con TextureLoader (<img>, bajo
  // img-src blob:) se decodifican igual; es el mismo camino que GLTFLoader usa en Safari/Firefox.
  loader.register((parser) => {
    const tl = new THREE.TextureLoader(parser.options.manager);
    tl.setCrossOrigin(parser.options.crossOrigin);
    if (parser.options.requestHeader) tl.setRequestHeader(parser.options.requestHeader);
    parser.textureLoader = tl;
    return { name: 'vtuber_texturas_img' };
  });
}
const overlay = $('#overlay');
const overlayText = $('#overlay-text');
function setOverlay(text, { error = false, show = true } = {}) {
  overlayText.textContent = text;
  overlay.classList.toggle('error', error);
  overlay.classList.toggle('hidden', !show);
}

let loadToken = 0;
let cargaEnCurso = 0;           // token de la carga en curso (0 = ninguna)
let modelUrl = '';              // URL y etiqueta del modelo actual (el comando theme lo recarga)
let modelLabel = '';

function envolverTema(h) {
  if (!h || typeof h !== 'object') return null;
  return {
    update: (t) => { if (typeof h.update === 'function') h.update(t); },
    dispose: () => { if (typeof h.dispose === 'function') h.dispose(); },
  };
}
function desecharTema() {
  const h = temaActivo;
  temaActivo = null;
  temaUpdateRoto = false;
  if (h) { try { h.dispose(); } catch (err) { console.warn('El tema falló en dispose():', err); } }
}
function registrarFalloTema(err) {
  temaFallido = true;
  const msg = `No se pudo aplicar el tema Amadeus: ${err?.message || err}`;
  console.warn(msg, err);
  logEntry('sistema', { type: 'theme', name: 'amadeus' }, { ok: false, error: msg });
}

/**
 * Con la ventana de escritorio oculta no se dibuja nada: compilar los shaders (MToon y tema) y subir
 * las texturas ahora evita un tirón de segundos en el primer fotograma, justo cuando ella aparece.
 */
function precargarGpu() {
  if (typeof renderer.compileAsync === 'function') {
    gpuListo = renderer.compileAsync(scene, camera)
      .then(() => {}, (err) => console.warn('No se pudieron precompilar los shaders:', err));
  }
  const subidas = new Set();
  const subir = (tex) => {
    if (!tex?.isTexture || subidas.has(tex)) return;
    subidas.add(tex);
    try { renderer.initTexture(tex); } catch { /* se subirá en el primer render */ }
  };
  scene.traverse((o) => {
    for (const m of [].concat(o.material || [])) {
      for (const v of Object.values(m)) subir(v);
      for (const u of Object.values(m.uniforms || {})) subir(u?.value);
    }
  });
}

async function loadModel(url, label) {
  const token = ++loadToken;
  cargaEnCurso = token;
  modelUrl = url;
  modelLabel = label;
  let info;
  try {
    info = await cargarModelo(url, label, token);
  } finally {
    if (cargaEnCurso === token) cargaEnCurso = 0;
  }
  // El tema pedido cambió mientras se cargaba: una recarga más para aplicarlo (sin bucle si falla).
  if (info && token === loadToken && temaDeseado !== temaNombre() && !(temaDeseado === 'amadeus' && temaFallido)) {
    return loadModel(url, label);
  }
  return info;
}

async function cargarModelo(url, label, token) {
  setOverlay('Cargando modelo…');
  // precarga del módulo del tema en paralelo con la descarga del modelo
  if (temaDeseado === 'amadeus') import('/amadeus_theme.js').catch(() => {});
  let gltf;
  try {
    gltf = await loader.loadAsync(url, (e) => {
      if (token !== loadToken) return;
      if (e.total && e.loaded <= e.total) setOverlay(`Cargando modelo… ${Math.round((e.loaded / e.total) * 100)}%`);
      else setOverlay(`Cargando modelo… ${(e.loaded / 1048576).toFixed(1)} MB`);
    });
  } catch (err) {
    setOverlay(`No se pudo cargar el modelo: ${err?.message || err}`, { error: true });
    throw new CommandError(`No se pudo cargar el modelo: ${err?.message || err}`);
  }
  if (token !== loadToken) return null;
  const next = gltf.userData.vrm;
  if (!next) {
    setOverlay('El archivo no es un modelo VRM válido.', { error: true });
    throw new CommandError('El archivo no es un modelo VRM válido.');
  }
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  if (VRMUtils.combineSkeletons) VRMUtils.combineSkeletons(gltf.scene);
  else if (VRMUtils.removeUnnecessaryJoints) VRMUtils.removeUnnecessaryJoints(gltf.scene);
  VRMUtils.rotateVRM0(next);
  next.scene.traverse((o) => { o.frustumCulled = false; });

  desecharTema();
  if (vrm) { avatarRoot.remove(vrm.scene); VRMUtils.deepDispose(vrm.scene); }
  vrm = next;
  next.scene.visible = false;     // no se dibuja hasta aplicar (o descartar) el tema
  avatarRoot.add(next.scene);

  // Tema: tras añadir el modelo a la escena y antes de su primer render.
  temaFallido = false;
  if (temaDeseado === 'amadeus') {
    try {
      const mod = await import('/amadeus_theme.js');             // import dinámico (archivo del grupo kurisu)
      if (vrm === next) {
        if (typeof mod.aplicarTemaAmadeus !== 'function') throw new Error('amadeus_theme.js no exporta aplicarTemaAmadeus');
        temaActivo = envolverTema(mod.aplicarTemaAmadeus(next, {
          THREE, rim: temaOpciones.rim, scanlines: temaOpciones.scanlines,
          escena: scene, avatarRoot, modoEscritorio: DESKTOP,
          // La paleta de Kurisu, la corbata y las medias solo se aplican al modelo de ejemplo: un
          // .vrm propio del usuario conserva sus colores y recibe solo rim, scanlines y marco.
          paleta: modelUrl === DEFAULT_MODEL_URL,
        }));
      }
    } catch (err) {
      temaActivo = null;
      registrarFalloTema(err);
    }
  }
  next.scene.visible = true;
  if (vrm !== next) return null;  // otra carga lo reemplazó mientras se importaba el tema

  modelName = vrm.meta?.name || vrm.meta?.title || label || 'Modelo VRM';
  modelSource = label || url;
  availableBones = Object.keys(vrm.humanoid.rawHumanBones || vrm.humanoid.humanBones)
    .filter((b) => vrm.humanoid.getNormalizedBoneNode(b));
  availableExpressions = vrm.expressionManager.expressions.map((e) => e.expressionName);

  boneState.clear(); exprState.clear(); stopGestures(); stopSpeech();
  applyPose('relaxed', 0);
  setLook({ at: look.mode === 'point' ? 'camera' : look.mode });
  $('#model-name').textContent = modelName;
  populateBoneSelect();
  setOverlay('', { show: false });
  setCamera(cameraPreset, 0.01);
  if (!renderActivo) precargarGpu();
  postState();
  logEntry('sistema', { type: 'load_model', name: modelName }, { ok: true });
  return { model: modelName, vrmVersion: vrm.meta?.metaVersion, bones: availableBones.length, expressions: availableExpressions };
}

async function resolveModelUrl(url) {
  if (!url || url === 'sample' || url === 'default') return [DEFAULT_MODEL_URL, 'Modelo de ejemplo'];
  if (/^(https?:|blob:|data:|\/)/.test(url)) return [url, url.split('/').pop()];
  return [`/models/${encodeURIComponent(url)}`, url];
}

// ===================================================================== ejecución de comandos
function snapshot() {
  const exprs = {};
  for (const [n, s] of exprState) if (s.cur > 0.01) exprs[n] = +s.cur.toFixed(2);
  return {
    ready: !!vrm,
    model: modelName || null,
    vrmVersion: vrm?.meta?.metaVersion ?? null,
    expressionsAvailable: availableExpressions,
    bonesAvailable: availableBones,
    poses: Object.keys(POSES),
    gestures: Object.keys(GESTURES),
    handShapes: HAND_SHAPES,
    commandTypes: COMMAND_TYPES,
    mode: DESKTOP ? 'desktop' : OBS ? 'obs' : 'panel',
    current: {
      pose: currentPose,
      expressions: exprs,
      gestures: [...gestures.keys()],
      speaking: speech.active,
      look: look.mode,
      position: { x: +root.cur.x.toFixed(2), z: +root.cur.z.toFixed(2) },
      rotation: +(root.cur.ry / DEG).toFixed(1),
      camera: cameraPreset,
      background,
      idle: idle.enabled,
      theme: temaNombre(),
    },
  };
}

let viewerId = null;            // id que asigna el servidor en el evento SSE "hello"
let stateTimer = 0;
function postState() {
  clearTimeout(stateTimer);
  stateTimer = setTimeout(() => {
    const body = {
      ...snapshot(),
      viewerId,
      viewer: { desktop: DESKTOP, visible, theme: temaActivo ? 'amadeus' : 'none' },
    };
    fetch('/api/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
  }, 250);
}

/** Nota para el log de actividad (y la consola: en ?obs=1 / ?desktop=1 no hay panel). */
function anotar(texto, cmd = {}) {
  console.info(`[visor] ${texto}`);
  logEntry('sistema', { ...cmd, nota: texto }, { ok: true });
}

const HANDLERS = {
  expression: (c) => applyExpression(c),
  pose: (c) => {
    if (!vrm) fail('No hay ningún modelo cargado todavía.');
    const dur = clamp(num(c.duration, 0.6), 0, 10);
    applyPose(c.name, dur);
    syncChips('#pose-chips', c.name);
    return { done: wait(dur * 1000) };
  },
  gesture: (c) => {
    if (!vrm) fail('No hay ningún modelo cargado todavía.');
    const { dur, done } = startGesture(c.name, c);
    return { result: { seconds: dur }, done: c.loop ? Promise.resolve() : done };
  },
  bones: (c) => {
    const rot = c.rotations || c.bones;
    if (!rot || typeof rot !== 'object') fail('bones requiere "rotations": {hueso: {x,y,z}} en grados.');
    const dur = clamp(num(c.duration, 0.4), 0, 10);
    for (const b of Object.keys(rot)) assertBone(b);
    for (const [b, r] of Object.entries(rot)) setBone(b, r, dur, !!c.relative);
    currentPose = 'custom';
    return { done: wait(dur * 1000) };
  },
  hand: (c) => {
    if (!vrm) fail('No hay ningún modelo cargado todavía.');
    applyHand(c.side || 'both', c.shape, clamp(num(c.duration, 0.25), 0, 5));
    return { done: wait(250) };
  },
  speak: (c) => speak(c),
  look: (c) => { setLook(c); syncChips('#look-chips', look.mode); return {}; },
  move: (c) => {
    let cmd = c;
    let ignored;
    if (DESKTOP && (c.x != null || c.z != null)) {
      // en el escritorio el avatar no se desplaza por el escenario: la locomoción es el comando "desktop"
      cmd = { ...c };
      delete cmd.x;
      delete cmd.z;
      ignored = ['x', 'z'];
      anotar('move: x/z ignorados en modo escritorio (se respetan rotation y walk).', { type: 'move' });
    }
    if (locomocionDeElectron() && cmd.rotation != null) {
      // entrando o saliendo por el borde mira hacia donde camina: el giro es de esa locomoción
      cmd = { ...cmd };
      delete cmd.rotation;
      ignored = [...(ignored || []), 'rotation'];
      anotar('move: rotation ignorado mientras entra o sale por el borde.', { type: 'move' });
    }
    const { dur, done } = moveAvatar(cmd);
    return { result: { seconds: +dur.toFixed(2), ...(ignored ? { ignored } : {}) }, done };
  },
  camera: (c) => {
    if (DESKTOP) {
      // la caja de 340×600 está encuadrada para el cuerpo entero: no se cambia el encuadre
      if (!CAMERA_PRESETS.includes(c.preset || 'bust')) fail(`Encuadre desconocido "${c.preset}". Opciones: ${CAMERA_PRESETS.join(', ')}`);
      anotar('camera: ignorado en modo escritorio.', { type: 'camera', preset: c.preset });
      return { result: { ignored: true, camera: cameraPreset } };
    }
    const dur = clamp(num(c.duration, 0.9), 0, 10);
    setCamera(c.preset || 'bust', dur);
    syncChips('#camera-chips', c.preset || 'bust');
    return { done: wait(dur * 1000) };
  },
  background: (c) => {
    const mode = c.mode || c.color || 'gradient';
    if (DESKTOP && mode !== 'transparent') {
      anotar('background: el modo escritorio siempre es transparente.', { type: 'background', mode });
      return { result: { ignored: true, background } };
    }
    setBackground(mode);
    return {};
  },
  idle: (c) => {
    if (c.enabled != null) idle.enabled = !!c.enabled;
    if (c.intensity != null) idle.intensity = clamp(num(c.intensity, 1), 0, 2);
    if (c.blink != null) idle.blink = !!c.blink;
    $('#idle-on').checked = idle.enabled;
    $('#blink-on').checked = idle.blink;
    return {};
  },
  wait: (c) => ({ done: wait(clamp(num(c.seconds, 1), 0, 120) * 1000) }),
  stop: (c) => {
    const what = c.what || 'all';
    if (what === 'all' || what === 'sequence') seqToken++;
    if (what === 'all' || what === 'gestures') stopGestures();
    if (what === 'all' || what === 'speech') stopSpeech();
    if (what === 'all' || what === 'move') {
      if (DESKTOP) esc.diferida++;             // descarta la acción "desktop" que esperaba a la entrada
      // en el escritorio también para la locomoción por la pantalla, salvo la del proceso principal
      // (entrada y salida por el borde: cortarla la dejaría varada fuera de la pantalla)
      if (!locomocionDeElectron()) {
        if (root.to) { root.to = null; root.resolve?.(); root.resolve = null; }
        if (DESKTOP) cancelarLocomocion(false);
      }
    }
    return {};
  },
  reset: () => {
    seqToken++;
    stopGestures(); stopSpeech();
    if (vrm) { applyPose('relaxed', 0.6); clearEmotions(0.4); }
    setLook({ at: LOOK_INICIAL, head: 0.35 });
    if (DESKTOP) esc.diferida++;
    const deElectron = locomocionDeElectron();
    if (DESKTOP && !deElectron) cancelarLocomocion(false);
    const m = deElectron
      ? { done: Promise.resolve() }
      : moveAvatar({ x: 0, z: 0, rotation: 0, walk: false, duration: 0.6 });
    idle.enabled = true; idle.intensity = 1; idle.blink = true;
    syncChips('#emotion-chips', 'neutral'); syncChips('#pose-chips', 'relaxed'); syncChips('#look-chips', LOOK_INICIAL);
    return { done: m.done };
  },
  sequence: (c) => {
    const steps = c.steps;
    if (!Array.isArray(steps) || !steps.length) fail('sequence requiere "steps": [comandos].');
    steps.forEach((s, i) => {
      if (!s || !COMMAND_TYPES.includes(s.type)) fail(`Paso ${i + 1}: tipo inválido "${s?.type}". Válidos: ${COMMAND_TYPES.join(', ')}`);
      if (RESTRICTED_TYPES.includes(s.type)) fail(`Paso ${i + 1}: "${s.type}" no puede ir dentro de un sequence.`);
    });
    const token = ++seqToken;
    const done = (async () => {
      do {
        for (const [i, step] of steps.entries()) {
          if (token !== seqToken) return;
          try {
            const r = await execute(step, 'secuencia');
            if (step.await !== false) await r.done;
          } catch (err) {
            console.warn(`Secuencia detenida en el paso ${i + 1}:`, err.message);
            return;
          }
        }
      } while (c.loop && token === seqToken);
    })();
    return { result: { steps: steps.length }, done };
  },
  load_model: async (c) => {
    const [url, label] = await resolveModelUrl(c.url || c.name);
    const info = await loadModel(url, label);
    return { result: info || {} };
  },
  state: () => ({ result: snapshot() }),
  desktop: (c) => comandoEscritorio(c),
  theme: (c) => {
    const name = c.name;
    if (!THEMES.includes(name)) fail(`Tema desconocido "${name}". Opciones: ${THEMES.join(', ')}`);
    if (c.rim != null && typeof c.rim !== 'boolean') fail('theme: rim debe ser booleano.');
    temaDeseado = name;
    temaOpciones = {
      rim: c.rim ?? true,
      scanlines: clamp(num(c.scanlines, THEME_LIMITS.scanlinesDefault), THEME_LIMITS.scanlinesMin, THEME_LIMITS.scanlinesMax),
    };
    syncChips('#theme-chips', name);
    if (name === temaNombre()) return { result: { theme: name, changed: false } };    // idempotente
    // se aplica al terminar la carga en curso (loadModel reconcilia el tema al acabar)
    if (cargaEnCurso || !modelUrl) return { result: { theme: name, changed: true, pending: true } };
    // distinto del activo (también "none"): recargar el modelo actual; el ack no espera a la descarga
    const done = loadModel(modelUrl, modelLabel).then(() => {}, (err) => {
      console.warn('No se pudo recargar el modelo para cambiar el tema:', err);
    });
    return { result: { theme: name, changed: true, reloading: true }, done };
  },
};

async function execute(cmd, source = 'manual', { quiet = false } = {}) {
  if (!cmd || typeof cmd !== 'object') fail('El comando debe ser un objeto JSON.');
  const h = HANDLERS[cmd.type] || fail(`Tipo desconocido "${cmd.type}". Válidos: ${COMMAND_TYPES.join(', ')}`);
  let r;
  try {
    r = (await h(cmd)) || {};
  } catch (err) {
    if (!quiet) logEntry(source, cmd, { ok: false, error: err.message });
    throw err;
  }
  if (!quiet) logEntry(source, cmd, { ok: true });
  postState();
  return { result: r.result || {}, done: r.done || Promise.resolve() };
}

async function runLocal(cmds, source = 'manual') {
  for (const c of Array.isArray(cmds) ? cmds : [cmds]) {
    try { await execute(c, source); } catch (err) { console.warn(err); }
  }
}

// ===================================================================== modo escritorio (Amadeus Desktop)
// La ventana de Electron cubre el área de trabajo y es transparente; el canvas es una caja de
// DESKTOP_BOX px CSS que se mueve con transform. El proceso principal de Electron es el único dueño
// de la visibilidad (onVisibility / onOrder aparecer|esconderse); R.A.M.S. decide la locomoción
// (comando "desktop"). Aquí solo hay reflejos: mirar el cursor, hit-test, física al soltarla y la
// curva de caminar del visor. Nada de esto decide cuándo salir ni qué hacer.
const BOX = { w: DESKTOP_BOX.w, h: DESKTOP_BOX.h };
const PX_POR_SEG = 280;          // velocidad de paseo base (px CSS/s)
const GIRO_CAMINAR = 70;         // grados: + = gira a SU izquierda = hacia la derecha de la pantalla
const GRAVEDAD_PX = 3000;        // px/s² al soltarla en el aire
const CURSOR_ENCIMA_CADA_S = 10; // cursor_encima como mucho una vez cada 10 s
const HIT_CADA_MS = 50;          // lectura del hit-test por píxel: ≤ 20 Hz con el cursor moviéndose…
const HIT_QUIETO_MS = 150;       // …y ≤ ~7 Hz con el cursor quieto (ella se mueve bajo él)
const HIT_RESPALDO_MS = 250;     // respaldo por raycast (sin lectura de píxeles): ≤ 4 Hz pase lo que pase
const HIT_ALFA_MIN = 24;         // alfa (0..255) a partir del cual un píxel del canvas es "cuerpo"
const REPORTE_CADA_MS = 34;      // reportAvatar ≤ 30 Hz
const esc = {
  x: 0, y: 0, suelo: 0,
  oculta: true, saliendo: false, asomada: false,
  entrada: null,                 // promesa de la entrada por el borde en curso (orden "aparecer" de Electron)
  diferida: 0,                   // turno de la acción "desktop" que espera a que termine la entrada
  cursor: null, dentro: false, interactivo: false,
  drag: null, caida: null, tween: null, seguir: null,
  token: 0,                      // cada orden/acción nueva invalida la locomoción anterior
  ultimoEncima: -Infinity,
  hit: { t: -1, lx: NaN, ly: NaN, r: false },   // última muestra del hit-test (px CSS relativos a la caja)
  estado: { aburrimiento: 0, fatiga: 0, valencia: 0 },
  reporte: { t: -1, clave: '', timer: 0 },
  respaldo: 0,
};

const sueloY = () => Math.max(0, innerHeight - BOX.h - esc.suelo);
const limiteX = (x) => clamp(x, -BOX.w * 0.7, Math.max(-BOX.w * 0.7, innerWidth - BOX.w * 0.3));
const xFueraDe = (borde) => (borde === 'left' ? -BOX.w - 20 : innerWidth + 20);
const xDentroDe = (borde) => (borde === 'left' ? 60 : Math.max(0, innerWidth - BOX.w - 60));
const xAsomada = (borde) => (borde === 'left' ? -BOX.w * 0.62 : innerWidth - BOX.w * 0.38);
const bordeCercano = () => (esc.x + BOX.w / 2 > innerWidth / 2 ? 'right' : 'left');
const velocidadPx = (vel) => PX_POR_SEG * clamp(vel, DESKTOP_LIMITS.speedMin, DESKTOP_LIMITS.speedMax)
  * (1 - 0.35 * esc.estado.fatiga);

const cajaFueraDePantalla = () => esc.x >= innerWidth || esc.x + BOX.w <= 0 || esc.y >= innerHeight || esc.y + BOX.h <= 0;

function escritorioEnMovimiento() {
  return !!(esc.tween || esc.seguir || esc.drag || esc.caida || andarLibre.peso > 0.01 || (root.to && root.walk));
}

function colocar() {
  stage.style.transform = `translate3d(${Math.round(esc.x)}px, ${Math.round(esc.y)}px, 0)`;
  reportarCaja();
}

/** reportAvatar(rect) a ≤ 30 Hz con el último valor garantizado; rect recortado a la ventana. */
function reportarCaja(forzar = false) {
  if (!AD) return;
  const x0 = Math.max(0, Math.round(esc.x)), y0 = Math.max(0, Math.round(esc.y));
  const x1 = Math.min(innerWidth, Math.round(esc.x + BOX.w)), y1 = Math.min(innerHeight, Math.round(esc.y + BOX.h));
  if (x1 - x0 < 1 || y1 - y0 < 1) return;               // fuera de la pantalla: nada que informar
  const r = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  const clave = `${r.x},${r.y},${r.w},${r.h}`;
  if (!forzar && clave === esc.reporte.clave) return;
  const t = performance.now();
  const espera = REPORTE_CADA_MS - (t - esc.reporte.t);
  if (!forzar && espera > 0) {
    if (!esc.reporte.timer) {
      esc.reporte.timer = setTimeout(() => { esc.reporte.timer = 0; reportarCaja(); }, espera + 1);
    }
    return;
  }
  esc.reporte.t = t;
  esc.reporte.clave = clave;
  ad('reportAvatar', r);
}

function visibleEnArbol(o) {
  for (let n = o; n; n = n.parent) if (n.visible === false) return false;
  return true;
}

// hit-test: ¿el punto (px CSS de la ventana) cae sobre el cuerpo? Se lee el alfa del propio canvas
// tras dibujarlo: lo que se ve es lo que se agarra (pelo, corbata del tema, contorno). El raycast contra
// las mallas con skinning costaba 27–87 ms de CPU por consulta (13 SkinnedMesh, ~25 000 vértices) y
// saturaba el hilo principal con el cursor encima de ella. La lectura de cada fotograma es asíncrona
// (WebGL2: readPixels a un PIXEL_PACK_BUFFER + fenceSync, recogida en un fotograma posterior): nunca
// espera a la GPU. Solo un clic sin muestra reciente bajo el puntero dibuja y lee en el acto.
const hitRay = new THREE.Raycaster();
const hitNdc = new THREE.Vector2();
const hitPx = new Uint8Array(4 * 9);
const hitTam = new THREE.Vector2();
const hitGpu = { pbo: null, sync: null, lx: NaN, ly: NaN, t: 0, async: true };
let hitPorPixel = true;          // false si el contexto no deja leer píxeles → respaldo por raycast
canvas.addEventListener('webglcontextlost', () => { hitGpu.pbo = null; hitGpu.sync = null; });

/** Punto relativo a la caja si cae en la zona donde puede estar el cuerpo; si no, null. */
function zonaDelCuerpo(p) {
  if (!vrm || !p || esc.oculta) return null;
  const lx = p.x - esc.x, ly = p.y - esc.y;
  if (lx < 0 || ly < 0 || lx > BOX.w || ly > BOX.h) return null;
  if (lx < BOX.w * 0.08 || lx > BOX.w * 0.92) return null;    // descarte barato: el cuerpo va centrado
  return { lx, ly };
}

/** Esquina inferior izquierda (px del búfer de dibujo; GL tiene el origen abajo) del bloque 3×3 bajo (lx, ly). */
function pixelBajo(lx, ly) {
  const gl = renderer.getContext();
  if (!gl || gl.isContextLost()) return null;
  const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
  renderer.getSize(hitTam);                            // tamaño CSS del canvas (= la caja)
  if (W < 3 || H < 3 || !hitTam.x || !hitTam.y) return null;
  return {
    gl,
    px: clamp(Math.floor((lx / hitTam.x) * W) - 1, 0, W - 3),
    py: clamp(Math.floor(((hitTam.y - ly) / hitTam.y) * H) - 1, 0, H - 3),
  };
}

const hayAlfa = () => {
  for (let i = 3; i < hitPx.length; i += 4) if (hitPx[i] >= HIT_ALFA_MIN) return true;
  return false;
};

/**
 * Lectura SÍNCRONA del entorno 3×3 bajo (lx, ly): espera a la GPU, así que solo se usa para un clic
 * (o si no hay lectura asíncrona). Válida justo después de renderer.render() en la misma tarea (el
 * búfer no se conserva entre fotogramas). null si no se puede leer.
 */
function alfaEnCaja(lx, ly) {
  const c = pixelBajo(lx, ly);
  if (!c) return null;
  hitPx.fill(0);
  try { c.gl.readPixels(c.px, c.py, 3, 3, c.gl.RGBA, c.gl.UNSIGNED_BYTE, hitPx); } catch { return null; }
  return hayAlfa();
}

/** Encola la lectura asíncrona del 3×3 bajo (lx, ly) del fotograma recién dibujado. false si no se puede. */
function pedirAlfa(lx, ly) {
  const c = pixelBajo(lx, ly);
  if (!c || typeof c.gl.fenceSync !== 'function') return false;
  const { gl } = c;
  try {
    if (!hitGpu.pbo) {
      hitGpu.pbo = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, hitGpu.pbo);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, hitPx.byteLength, gl.STREAM_READ);
    } else {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, hitGpu.pbo);
    }
    gl.readPixels(c.px, c.py, 3, 3, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!sync) return false;
    gl.flush();
    Object.assign(hitGpu, { sync, lx, ly, t: performance.now() });
    return true;
  } catch {
    try { gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); } catch {}
    return false;
  }
}

/** Lectura en vuelo: true/false si la GPU ya la terminó, null si aún no, undefined si no hay o falló. */
function recogerAlfa() {
  const sync = hitGpu.sync;
  if (!sync) return undefined;
  const gl = renderer.getContext();
  if (gl.isContextLost()) { hitGpu.sync = null; return undefined; }
  const st = gl.clientWaitSync(sync, 0, 0);            // sin espera: el estado cambia entre tareas
  if (st === gl.TIMEOUT_EXPIRED) return null;
  gl.deleteSync(sync);
  hitGpu.sync = null;
  if (st === gl.WAIT_FAILED) return undefined;
  hitPx.fill(0);
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, hitGpu.pbo);
  gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, hitPx);
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  return hayAlfa();
}

function hitPorRaycast(lx, ly) {
  hitNdc.set((lx / BOX.w) * 2 - 1, -(ly / BOX.h) * 2 + 1);
  hitRay.setFromCamera(hitNdc, camera);
  try { return hitRay.intersectObject(vrm.scene, true).some((i) => visibleEnArbol(i.object)); } catch { return false; }
}

/** Guarda una muestra y, si cambia lo que hay bajo el cursor, reevalúa si la ventana pide los clics. */
function anotarMuestra(lx, ly, r) {
  Object.assign(esc.hit, { t: performance.now(), lx, ly, r });
  if (r !== esc.dentro && !esc.drag) evaluarInteractivo();
}

/**
 * Tras cada fotograma dibujado: recoge la lectura en vuelo (de un fotograma anterior) y pide otra del
 * píxel bajo el cursor (≤ 20 Hz moviéndose, ≤ ~7 Hz quieto, una sola en vuelo). Sin WebGL2 /
 * fenceSync, lectura síncrona al mismo ritmo.
 */
function muestrearHit() {
  if (!hitPorPixel) return;
  if (hitGpu.sync) {
    let r;
    try { r = recogerAlfa(); } catch { r = undefined; hitGpu.sync = null; }
    if (r === null) {
      if (performance.now() - hitGpu.t < 1000) return;   // la GPU aún no terminó: se recoge luego
      try { renderer.getContext().deleteSync(hitGpu.sync); } catch {}
      hitGpu.sync = null;                                  // una lectura atascada no bloquea las siguientes
    } else if (r !== undefined) {
      anotarMuestra(hitGpu.lx, hitGpu.ly, r);
    }
  }
  if (esc.drag) return;
  const h = esc.hit;
  const l = zonaDelCuerpo(esc.cursor);
  if (!l) { h.t = -1; h.r = false; return; }          // al volver a entrar en la caja, muestra nueva
  const t = performance.now();
  const quieto = Math.abs(l.lx - h.lx) < 1 && Math.abs(l.ly - h.ly) < 1;
  if (h.t >= 0 && t - h.t < (quieto ? HIT_QUIETO_MS : HIT_CADA_MS)) return;
  if (hitGpu.async) {
    if (pedirAlfa(l.lx, l.ly)) return;
    hitGpu.async = false;                                  // sin lectura asíncrona: síncrona desde ahora
  }
  const r = alfaEnCaja(l.lx, l.ly);
  if (r === null) { hitPorPixel = false; return; }
  anotarMuestra(l.lx, l.ly, r);
}

/**
 * ¿El punto cae sobre el cuerpo? Sin `forzar` (cursor que se mueve, hasta 30 Hz) devuelve la última
 * muestra de muestrearHit() (llega uno o dos fotogramas tarde), sin coste. Con `forzar` (pulsar, clic
 * derecho): la muestra si es de ese mismo punto y reciente (lo normal: la ventana solo recibe clics
 * con el cursor encima); si no, dibuja ahora y lee el píxel exacto.
 */
function sobreElCuerpo(p, forzar = false) {
  const l = zonaDelCuerpo(p);
  if (!l) return false;
  const h = esc.hit;
  if (hitPorPixel) {
    if (!forzar) return h.t >= 0 && h.r;
    if (h.t >= 0 && performance.now() - h.t < 250 && Math.abs(l.lx - h.lx) <= 2 && Math.abs(l.ly - h.ly) <= 2) return h.r;
    let r = null;
    try { renderer.render(scene, camera); r = alfaEnCaja(l.lx, l.ly); } catch { r = null; }
    if (r !== null) { Object.assign(h, { t: performance.now(), lx: l.lx, ly: l.ly, r }); return r; }
    hitPorPixel = false;
  }
  // respaldo sin lectura de píxeles: raycast limitado a ≤ 4 Hz aunque el cursor se mueva
  const t = performance.now();
  if (!forzar && h.t >= 0 && t - h.t < HIT_RESPALDO_MS) return h.r;
  const r = hitPorRaycast(l.lx, l.ly);
  Object.assign(h, { t, lx: l.lx, ly: l.ly, r });
  return r;
}

/** El renderer solo PIDE ser interactivo; decide el proceso principal (autoridad del overlay). */
function pedirInteractivo(v) {
  if (v === esc.interactivo) return;
  esc.interactivo = v;
  document.body.classList.toggle('sobre-avatar', v);
  ad('setInteractive', v);
}

function evaluarInteractivo() {
  const dentro = !!esc.drag || sobreElCuerpo(esc.cursor);
  if (dentro !== esc.dentro) {
    esc.dentro = dentro;
    if (dentro && !esc.drag) {
      const t = now();
      if (t - esc.ultimoEncima >= CURSOR_ENCIMA_CADA_S) { esc.ultimoEncima = t; ad('event', 'cursor_encima', {}); }
    }
  }
  pedirInteractivo(dentro);
}

/** Cursor global (onCursor de Electron o pointermove local), en px CSS de la ventana. */
function actualizarCursor(p) {
  if (!p || !Number.isFinite(+p.x) || !Number.isFinite(+p.y)) return;
  esc.cursor = { x: +p.x, y: +p.y };
  // "mirarlo": NDC relativas a la caja (fuera de ±1 si el cursor está lejos; la cabeza ya se limita)
  mouseNdc.set(((esc.cursor.x - esc.x) / BOX.w) * 2 - 1, -((esc.cursor.y - esc.y) / BOX.h) * 2 + 1);
  if (!esc.oculta) evaluarInteractivo();
}

function girarHacia(grados, dur) {
  moveAvatar({ rotation: grados, walk: false, duration: dur });
}

function enderezar() {
  if (!esc.asomada) return;
  esc.asomada = false;
  if (vrm?.humanoid.getNormalizedBoneNode('spine')) setBone('spine', { z: 0 }, 0.4);
}

function cancelarLocomocion(deFrente = true) {
  esc.token++;
  const tw = esc.tween; esc.tween = null;
  if (tw) tw.resolve(false);
  const sg = esc.seguir; esc.seguir = null;
  if (sg) sg.resolve(false);
  andarLibre.activo = false;
  if (deFrente) girarHacia(0, 0.35);
}

/** Camina hasta x (borde izquierdo de la caja, px CSS) con la curva de caminar del visor. */
async function caminarA(x1, { vel = 1, libre = false } = {}) {
  const token = esc.token;
  if (!libre) x1 = limiteX(x1);
  if (Math.abs(x1 - esc.x) < 4) return true;
  const dir = Math.sign(x1 - esc.x);
  enderezar();
  girarHacia(dir * GIRO_CAMINAR, 0.25);
  await wait(220);
  if (token !== esc.token) return false;
  const pxs = velocidadPx(vel);
  const dur = Math.max(0.5, Math.abs(x1 - esc.x) / pxs);
  andarLibre.activo = true;
  andarLibre.ritmo = clamp(pxs / PX_POR_SEG, 0.6, 2);
  const ok = await new Promise((resolve) => { esc.tween = { x0: esc.x, x1, t0: now(), dur, resolve }; });
  if (token !== esc.token) return false;
  andarLibre.activo = false;
  if (!ok) return false;
  girarHacia(0, 0.4);                                   // de frente al usuario al llegar
  return true;
}

function perseguirCursor(segundos, vel) {
  return new Promise((resolve) => {
    esc.seguir = { hasta: now() + segundos, vel, token: esc.token, dir: 0, v: 0, resolve };
  });
}

function terminarPersecucion(completa) {
  const sg = esc.seguir;
  if (!sg) return;
  esc.seguir = null;
  andarLibre.activo = false;
  girarHacia(0, 0.35);
  sg.resolve(completa);
}

async function asomarse(borde, vel = 0.8) {
  const token = esc.token;
  const ok = await caminarA(xAsomada(borde), { vel, libre: true });
  if (!ok || token !== esc.token) return false;
  girarHacia(borde === 'right' ? -35 : 35, 0.5);        // hacia el centro de la pantalla
  if (vrm?.humanoid.getNormalizedBoneNode('spine')) setBone('spine', { z: borde === 'right' ? 10 : -10 }, 0.6);
  esc.asomada = true;
  setLook({ at: 'mouse', head: Math.max(look.head, 0.45) });
  syncChips('#look-chips', 'mouse');
  return true;
}

/**
 * Entrada por el borde (orden "aparecer" del proceso principal de Electron, su dueño). Mientras dura
 * (también la espera a los shaders) esc.entrada está puesta: stop/reset/move no la cancelan y las
 * acciones "desktop" de R.A.M.S. esperan a que termine (manda la última). Solo la cancelan el propio
 * main (esconderse, ocultar la ventana, otro aparecer) o el usuario al agarrarla; si algo más la
 * cortara, se la deja dentro de la pantalla en vez de varada fuera del borde.
 */
async function aparecer(borde, modo) {
  borde = DESKTOP_EDGES.includes(borde) ? borde : 'right';
  clearTimeout(esc.respaldo);
  cancelarLocomocion(false);
  const token = esc.token;
  esc.saliendo = false;
  let terminar;
  const entrada = new Promise((r) => { terminar = r; });
  esc.entrada = entrada;
  let ok = false;
  try {
    if (esc.oculta) {
      esc.oculta = false;
      esc.caida = null;
      esc.x = xFueraDe(borde);
      esc.y = sueloY();
      colocar();
      postState();
      // que el primer paso no se trabe si los shaders aún se compilan (fuera de la pantalla no se dibuja)
      await Promise.race([gpuListo, wait(4000)]);
      if (token !== esc.token) return false;
    }
    if (modo === 'asomarse') ok = await asomarse(borde);
    else if (esc.x >= 0 && esc.x + BOX.w <= innerWidth) { enderezar(); girarHacia(0, 0.35); ok = true; }
    else ok = await caminarA(xDentroDe(esc.x + BOX.w / 2 < innerWidth / 2 ? 'left' : 'right'));
    return ok;
  } finally {
    if (esc.entrada === entrada) {
      esc.entrada = null;
      if (!ok) rescatarEntrada(borde, modo);
    }
    terminar();
  }
}

/** Red de seguridad: una entrada cortada por algo que no es su dueño no la deja fuera de la pantalla. */
function rescatarEntrada(borde, modo) {
  if (esc.oculta || esc.saliendo || esc.drag || esc.caida || esc.tween || esc.seguir || !visible) return;
  const destino = modo === 'asomarse' ? xAsomada(borde) : xDentroDe(borde);
  const fuera = borde === 'left' ? esc.x < destino : esc.x > destino;
  if (!fuera) return;
  esc.x = destino;
  girarHacia(0, 0.35);
  colocar();
}

/** Espera a que no haya ninguna entrada por el borde en curso (un aparecer puede sustituir a otro). */
async function esperarEntrada() {
  while (esc.entrada) await esc.entrada;
}

/** La locomoción en curso es del proceso principal (entrada o salida por el borde): no se toca. */
const locomocionDeElectron = () => DESKTOP && !!(esc.entrada || esc.saliendo);

/** Sale caminando por el borde más cercano y al terminar llama a amadeusDesktop.hidden(). */
async function esconderse() {
  clearTimeout(esc.respaldo);
  if (esc.oculta) { ad('hidden'); return true; }
  esc.saliendo = true;
  if (esc.drag || esc.caida) return false;              // se reanuda al soltarla o al tocar el suelo
  cancelarLocomocion(false);
  const token = esc.token;
  let ok = false;
  try { ok = await caminarA(xFueraDe(bordeCercano()), { vel: 1.15, libre: true }); } catch { ok = false; }
  if (!ok || token !== esc.token || !esc.saliendo) return false;
  esc.saliendo = false;
  esc.oculta = true;
  enderezar();
  pedirInteractivo(false);
  postState();
  ad('hidden');
  return true;
}

async function buscarUsuario(vel) {
  const token = esc.token;
  const cx = esc.cursor ? esc.cursor.x : innerWidth / 2;
  const desdeIzquierda = esc.x + BOX.w / 2 <= cx;       // se queda al lado del cursor, no encima
  const centro = cx + (desdeIzquierda ? -1 : 1) * BOX.w * 0.55;
  const ok = await caminarA(limiteX(centro - BOX.w / 2), { vel });
  if (!ok || token !== esc.token) return false;
  setLook({ at: 'mouse', head: Math.max(look.head, 0.5) });
  syncChips('#look-chips', 'mouse');
  girarHacia(desdeIzquierda ? 20 : -20, 0.4);           // un poco hacia el cursor
  if (vrm) { try { startGesture('wave', { side: desdeIzquierda ? 'left' : 'right' }); } catch {} }
  return true;
}

async function pasear(segundos, vel) {
  const token = esc.token;
  const hasta = now() + segundos;
  while (token === esc.token && now() < hasta) {
    let destino = Math.random() * Math.max(1, innerWidth - BOX.w);
    if (Math.abs(destino - esc.x) < 120) destino = esc.x + (destino >= esc.x ? 160 : -160);
    const ok = await caminarA(limiteX(destino), { vel: vel * 0.8 });
    if (!ok || token !== esc.token) return false;
    if (now() >= hasta) break;
    await wait(600 + Math.random() * 1000);
  }
  return token === esc.token;
}

/** Comando "desktop" (de R.A.M.S. por /api/command): locomoción por la pantalla. */
function comandoEscritorio(c) {
  if (!DESKTOP) fail('El comando desktop solo funciona en visores de escritorio (?desktop=1).');
  const action = c.action;
  if (!DESKTOP_ACTIONS.includes(action)) fail(`Acción desconocida "${action}". Acciones: ${DESKTOP_ACTIONS.join(', ')}`);
  if (c.edge != null && !DESKTOP_EDGES.includes(c.edge)) fail(`edge debe ser ${DESKTOP_EDGES.join(' o ')}.`);
  if (!visible || esc.oculta || esc.saliendo) fail('oculta');
  if (esc.drag) fail('arrastrada');
  if (action === 'walk_to' && num(c.x, null) === null) fail('walk_to requiere "x" (0..1, o px con unit:"px").');
  if (action === 'chase_cursor' && !esc.cursor) fail('sin cursor global (este sistema no informa la posición del ratón)');
  const turno = ++esc.diferida;              // la última acción manda (y "stop" descarta la que esperaba)
  if (esc.entrada) {
    // la entrada por el borde es del proceso principal de Electron: no se corta, la acción va después
    if (action === 'stop') return { result: { action: 'stop', entrando: true } };
    const done = esperarEntrada().then(() => {
      if (turno !== esc.diferida || !visible || esc.oculta || esc.saliendo || esc.drag || esc.entrada) return false;
      try { return accionEscritorio(c).done; } catch (err) { console.warn('desktop (tras la entrada):', err); return false; }
    });
    anotar(`desktop ${action}: espera a que termine la entrada por el borde.`, { type: 'desktop', action });
    return { result: { action, tras: 'entrada' }, done };
  }
  return accionEscritorio(c);
}

/** Ejecuta una acción "desktop" ya validada (con la ventana visible y sin entrada en curso). */
function accionEscritorio(c) {
  const action = c.action;
  const vel = clamp(num(c.speed, 1), DESKTOP_LIMITS.speedMin, DESKTOP_LIMITS.speedMax);
  const segundos = (d) => clamp(num(c.seconds, d), 0.5, DESKTOP_LIMITS.secondsMax);
  const sinFallo = (p) => p.catch((err) => { console.warn('desktop:', err); return false; });
  switch (action) {
    case 'walk_to': {
      const xv = num(c.x, null);
      if (xv === null) fail('walk_to requiere "x" (0..1, o px con unit:"px").');
      // x = centro del avatar: fracción del ancho útil (caja entera visible) o px CSS con unit:"px"
      const centro = c.unit === 'px'
        ? clamp(xv, 0, DESKTOP_LIMITS.pxMax)
        : BOX.w / 2 + clamp(xv, 0, 1) * Math.max(0, innerWidth - BOX.w);
      cancelarLocomocion(false);
      const destino = limiteX(centro - BOX.w / 2);
      const seconds = +(0.22 + Math.abs(destino - esc.x) / velocidadPx(vel)).toFixed(2);
      return { result: { action, x: Math.round(destino + BOX.w / 2), seconds }, done: sinFallo(caminarA(destino, { vel })) };
    }
    case 'peek': {
      const edge = c.edge || bordeCercano();
      cancelarLocomocion(false);
      return { result: { action, edge }, done: sinFallo(asomarse(edge, Math.min(vel, 1))) };
    }
    case 'chase_cursor': {
      if (!esc.cursor) fail('sin cursor global (este sistema no informa la posición del ratón)');
      const s = segundos(8);
      cancelarLocomocion(false);
      return { result: { action, seconds: s }, done: perseguirCursor(s, vel) };
    }
    case 'seek_user': {
      cancelarLocomocion(false);
      return { result: { action }, done: sinFallo(buscarUsuario(vel)) };
    }
    case 'wander': {
      const s = segundos(10);
      cancelarLocomocion(false);
      return { result: { action, seconds: s }, done: sinFallo(pasear(s, vel)) };
    }
    default: {                                          // 'stop'
      cancelarLocomocion(true);
      enderezar();
      return { result: { action: 'stop' } };
    }
  }
}

/** Avance por fotograma: caminar, persecución del cursor, caída y peso de la zancada. */
function actualizarEscritorio(t, dt) {
  let mover = false;
  const tw = esc.tween;
  if (tw) {
    const k = clamp((t - tw.t0) / tw.dur, 0, 1);
    esc.x = lerp(tw.x0, tw.x1, k * k * (3 - 2 * k));    // misma curva que updateRoot con walk
    mover = true;
    if (k >= 1) { esc.tween = null; tw.resolve(true); }
  }
  const sg = esc.seguir;
  if (sg) {
    if (t >= sg.hasta || !esc.cursor || sg.token !== esc.token) {
      terminarPersecucion(true);
    } else {
      const diff = limiteX(esc.cursor.x - BOX.w / 2) - esc.x;
      if (Math.abs(diff) > 28) {
        const dir = Math.sign(diff);
        if (sg.dir !== dir) { sg.dir = dir; sg.v = Math.min(sg.v, 60); girarHacia(dir * GIRO_CAMINAR, 0.2); }
        sg.v = Math.min(velocidadPx(sg.vel * 1.35), sg.v + 900 * dt);
        esc.x += dir * Math.min(Math.abs(diff), sg.v * dt);
        andarLibre.activo = true;
        andarLibre.ritmo = clamp(sg.v / PX_POR_SEG, 0.6, 2);
        mover = true;
      } else if (sg.dir !== 0) {
        sg.dir = 0;
        sg.v = 0;
        andarLibre.activo = false;
        girarHacia(0, 0.3);
      }
    }
  }
  const cd = esc.caida;
  if (cd) {
    const k = clamp((t - cd.t0) / cd.dur, 0, 1);
    esc.y = lerp(cd.y0, sueloY(), k * k);
    mover = true;
    if (k >= 1) {
      esc.caida = null;
      if (esc.saliendo) esconderse();
    }
  }
  andarLibre.peso = lerp(andarLibre.peso, andarLibre.activo ? 1 : 0, Math.min(1, dt * 7));
  if (!andarLibre.activo && andarLibre.peso < 0.005) andarLibre.peso = 0;
  if (mover) colocar();
}

// ---- arrastrar, tocar y clic derecho sobre la caja
function alPulsar(e) {
  if (e.button !== 0 || esc.oculta) return;
  const p = { x: e.clientX, y: e.clientY };
  if (!sobreElCuerpo(p, true)) return;                  // fuera del cuerpo no se la agarra
  e.preventDefault();
  cancelarLocomocion(true);
  enderezar();
  esc.caida = null;
  try { stage.setPointerCapture(e.pointerId); } catch {}
  esc.drag = { id: e.pointerId, dx: p.x - esc.x, dy: p.y - esc.y, x0: p.x, y0: p.y, movido: false };
  pedirInteractivo(true);
}

function alMover(e) {
  const d = esc.drag;
  if (!d || e.pointerId !== d.id) return;
  if (!d.movido && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > 6) {
    d.movido = true;
    document.body.classList.add('arrastrando');
  }
  if (!d.movido) return;
  esc.x = limiteX(e.clientX - d.dx);
  esc.y = clamp(e.clientY - d.dy, -BOX.h * 0.5, sueloY());
  colocar();
}

function alSoltar(e, cancelado) {
  const d = esc.drag;
  if (!d || e.pointerId !== d.id) return;
  esc.drag = null;
  document.body.classList.remove('arrastrando');
  try { stage.releasePointerCapture(e.pointerId); } catch {}
  if (!d.movido) {
    if (!cancelado) ad('event', 'toque', {});           // pointerup sin arrastre
  } else {
    const suelo = sueloY();
    const altura = suelo > 0 ? clamp((suelo - esc.y) / suelo, 0, 1) : 0;
    if (!cancelado) ad('event', 'soltada', { altura: +altura.toFixed(3) });
    const caer = suelo - esc.y;
    if (caer > 1) esc.caida = { y0: esc.y, t0: now(), dur: Math.max(0.12, Math.sqrt((2 * caer) / GRAVEDAD_PX)) };
  }
  if (esc.cursor) evaluarInteractivo(); else pedirInteractivo(false);
  if (esc.saliendo && !esc.caida) esconderse();
}

// ---- órdenes y visibilidad del proceso principal de Electron (tabla de §C2.5.5)
function fijarEstado(o) {
  esc.estado = {
    aburrimiento: clamp(num(o.aburrimiento, 0), 0, 1),
    fatiga: clamp(num(o.fatiga, 0), 0, 1),
    valencia: clamp(num(o.valencia, 0), -1, 1),
  };
  // solo modula los reflejos de reposo y el paso (no decide nada)
  reflejoReposo = clamp(1 + 0.3 * esc.estado.aburrimiento - 0.4 * esc.estado.fatiga, 0.5, 1.4);
}

function relayout() {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  resize();
  if (esc.oculta) esc.x = xFueraDe(esc.x + BOX.w / 2 < 0 ? 'left' : 'right');
  else if (!esc.tween && !esc.drag && !esc.saliendo && !esc.seguir && !esc.entrada) esc.x = limiteX(esc.x);
  if (!esc.drag && !esc.caida) esc.y = sueloY();
  colocar();
  reportarCaja(true);
}

function alOrden(o) {
  if (!o || typeof o !== 'object') return;
  const avisar = (p) => Promise.resolve(p).catch((err) => console.warn(`orden ${o.accion}:`, err));
  switch (o.accion) {
    case 'aparecer': avisar(aparecer(o.borde, o.modo === 'asomarse' ? 'asomarse' : 'entrar')); break;
    case 'esconderse': avisar(esconderse()); break;
    case 'estado': fijarEstado(o); break;
    case 'suelo':
      esc.suelo = Math.round(clamp(num(o.inferior, 0), 0, innerHeight * 0.5));
      if (!esc.drag && !esc.caida) { esc.y = sueloY(); colocar(); }
      break;
    case 'relayout': relayout(); break;
    case 'camara': {   // indicador visible de cámara abierta (§C2.13): lo decide R.A.M.S., aquí solo se pinta
      const ojo = $('#ojo-camara');
      if (ojo) ojo.hidden = o.activa !== true;
      break;
    }
    default: console.debug('Orden de escritorio desconocida:', o.accion);
  }
}

function alVisibilidad(v) {
  v = !!v;
  if (v === visible) return;
  visible = v;
  clearTimeout(esc.respaldo);
  if (v) {
    reanudarRender();
    reportarCaja(true);
    // respaldo: si se muestra la ventana sin orden "aparecer", entra caminando igualmente
    if (esc.oculta) esc.respaldo = setTimeout(() => { if (visible && esc.oculta) aparecer('right', 'entrar'); }, 700);
  } else {
    cancelarLocomocion(false);
    esc.diferida++;                    // una acción que esperaba a la entrada ya no tiene sentido
    esc.drag = null;
    esc.caida = null;
    esc.saliendo = false;
    esc.oculta = true;
    document.body.classList.remove('arrastrando');
    pedirInteractivo(false);
    pausarRender();
  }
  postState();
}

function iniciarEscritorio() {
  esc.y = sueloY();
  if (AD_ORDENES) { esc.oculta = true; esc.x = xFueraDe('right'); }   // espera a "aparecer"
  else { esc.oculta = false; esc.x = xDentroDe('right'); }           // en un navegador: visible ya
  colocar();
  window.addEventListener('resize', relayout);
  window.addEventListener('pointermove', (e) => actualizarCursor({ x: e.clientX, y: e.clientY }), { passive: true });
  stage.addEventListener('pointerdown', alPulsar);
  stage.addEventListener('pointermove', alMover);
  stage.addEventListener('pointerup', (e) => alSoltar(e, false));
  stage.addEventListener('pointercancel', (e) => alSoltar(e, true));
  stage.addEventListener('lostpointercapture', (e) => alSoltar(e, true));
  stage.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (sobreElCuerpo({ x: e.clientX, y: e.clientY }, true)) ad('openChat');   // abre el chat (acción del usuario)
  });
  stage.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
  if (AD) {
    ad('onCursor', (p) => actualizarCursor(p));
    ad('onOrder', (o) => alOrden(o));
    ad('onVisibility', (v) => alVisibilidad(v));
  }
}

// ===================================================================== conexión con la IA (SSE)
const conn = $('#conn');
function setConn(state, text) {
  conn.className = `pill ${state}`;
  conn.querySelector('span').textContent = text;
}
let fuenteSse = null;
let buildVisor = null;   // huella del código con el que se cargó esta página (del primer "hello")
// Modelo con el que arrancar sin ?model=: lo dice el servidor en el primer "hello" (último load_model
// confirmado, VTUBER_AI_MODELO o el primer .vrm de models/). Así el overlay de Amadeus Desktop, que se
// abre sin ?model=, carga el mismo modelo propio que el panel también tras recargarse.
let avisarModeloInicial;
const modeloDelServidor = new Promise((r) => { avisarModeloInicial = r; });
function connect() {
  const q = new URLSearchParams();
  if (OBS) q.set('obs', '1');
  if (DESKTOP) q.set('desktop', '1');
  const qs = q.toString();
  fuenteSse?.close();
  const es = new EventSource(`/api/events${qs ? `?${qs}` : ''}`);
  fuenteSse = es;
  es.addEventListener('hello', (ev) => {
    let h = {};
    try { h = JSON.parse(ev.data) || {}; } catch { h = {}; }
    viewerId = typeof h.id === 'string' ? h.id : null;
    // El servidor se reinició con otro código del visor: recargar para no seguir con el app.js viejo.
    if (typeof h.build === 'string' && h.build) {
      if (buildVisor && h.build !== buildVisor) { location.reload(); return; }
      buildVisor = h.build;
    }
    avisarModeloInicial(typeof h.defaultModel === 'string' && h.defaultModel ? h.defaultModel : null);
    setConn('ok', 'IA conectada');
    postState();
  });
  es.addEventListener('command', async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const results = [];
    for (const c of msg.commands || []) {
      try {
        const { result } = await execute(c, msg.source || 'ia');
        results.push({ ok: true, type: c.type, ...result });
      } catch (err) {
        results.push({ ok: false, type: c?.type, error: err.message });
      }
    }
    // viewerId: con panel y overlay a la vez, el servidor prefiere el ack del panel (el overlay ignora x/z…)
    fetch('/api/ack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: msg.id, viewerId, results }),
    }).catch(() => {});
  });
  es.onerror = () => setConn('err', 'Servidor desconectado — reintentando…');
}
connect();
// Una página guardada en la caché atrás/adelante no debe seguir contando como visor (ni recibir comandos).
window.addEventListener('pagehide', () => { fuenteSse?.close(); fuenteSse = null; });
window.addEventListener('pageshow', (e) => { if (e.persisted) connect(); });

// ===================================================================== interfaz
const logEl = $('#log');
function logEntry(source, cmd, res) {
  if (OBS) return;
  logEl.querySelector('.empty')?.remove();
  const li = document.createElement('li');
  const time = new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const src = String(source);
  const label = { api: 'IA', mcp: 'IA · MCP', ia: 'IA', rams: 'R.A.M.S.', manual: 'Manual', secuencia: 'Secuencia', sistema: 'Sistema' }[src] || src;
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = `<span class="src ${src}"></span><span></span>`;
  meta.children[0].textContent = label;
  meta.children[1].textContent = time;
  const code = document.createElement('code');
  const short = { ...cmd };
  if (short.steps) short.steps = `[${short.steps.length} pasos]`;
  code.textContent = JSON.stringify(short);
  li.append(meta, code);
  if (!res.ok) {
    const e = document.createElement('div');
    e.className = 'err';
    e.textContent = res.error;
    li.append(e);
  }
  logEl.prepend(li);
  while (logEl.children.length > 80) logEl.lastChild.remove();
}
function emptyLog() {
  logEl.innerHTML = '<li class="empty">Aún no hay actividad. Envía un comando desde la consola o desde una IA.</li>';
}
emptyLog();
$('#log-clear').onclick = emptyLog;

function chips(sel, items, onClick) {
  const el = $(sel);
  el.innerHTML = '';
  for (const [value, label] of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.value = value;
    b.textContent = label;
    b.onclick = () => onClick(value);
    el.append(b);
  }
}
function syncChips(sel, value) {
  for (const b of document.querySelectorAll(`${sel} button`)) b.classList.toggle('on', b.dataset.value === value);
}

const LOOK_LABELS = {
  camera: 'Cámara', mouse: 'Ratón', forward: 'Al frente', left: 'Su izquierda', right: 'Su derecha',
  up: 'Arriba', down: 'Abajo', none: 'Libre',
};
const HAND_LABELS = { open: 'Abierta', relaxed: 'Relajada', fist: 'Puño', point: 'Señalar', peace: 'Paz ✌', thumbs_up: 'Pulgar 👍' };
const CAMERA_LABELS = { face: 'Rostro', bust: 'Busto', full: 'Cuerpo', wide: 'Amplio' };
const BG_LABELS = { gradient: 'Degradado', green: 'Verde (chroma)', blue: 'Azul', magenta: 'Magenta', transparent: 'Transparente' };

const intensity = () => +$('#expr-int').value / 100;
$('#expr-int').oninput = () => { $('#expr-int-out').textContent = `${$('#expr-int').value}%`; };
chips('#emotion-chips', [...EMOTIONS, 'neutral'].map((e) => [e, EMOTION_LABELS[e]]), (e) => runLocal({ type: 'expression', name: e, value: intensity() }));
chips('#gesture-chips', Object.entries(GESTURES).map(([k, g]) => [k, g.label]), (g) => runLocal({ type: 'gesture', name: g }));
chips('#pose-chips', Object.entries(POSES).map(([k, p]) => [k, p.label]), (p) => runLocal({ type: 'pose', name: p }));
chips('#look-chips', Object.entries(LOOK_LABELS), (l) => runLocal({ type: 'look', at: l }));
chips('#hand-chips', HAND_SHAPES.map((h) => [h, HAND_LABELS[h]]), (h) => runLocal({ type: 'hand', side: $('#hand-side').value, shape: h }));
chips('#camera-chips', CAMERA_PRESETS.map((c) => [c, CAMERA_LABELS[c]]), (c) => runLocal({ type: 'camera', preset: c }));
chips('#bg-chips', BACKGROUNDS.map((b) => [b, BG_LABELS[b]]), (b) => runLocal({ type: 'background', mode: b }));
const THEME_LABELS = { amadeus: 'Amadeus (Kurisu)', none: 'Ninguno' };
if ($('#theme-chips')) {
  chips('#theme-chips', THEMES.map((n) => [n, THEME_LABELS[n] || n]), (n) => runLocal({ type: 'theme', name: n }));
  syncChips('#theme-chips', temaDeseado);
}
syncChips('#emotion-chips', 'neutral'); syncChips('#pose-chips', 'relaxed'); syncChips('#look-chips', LOOK_INICIAL);
syncChips('#camera-chips', cameraPreset); syncChips('#bg-chips', 'gradient');

// hablar
function fillSelect(sel, items) {
  const el = $(sel);
  el.replaceChildren(...items.map(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; return o; }));
}
fillSelect('#say-emotion', [['', 'Sin emoción'], ...EMOTIONS.map((e) => [e, EMOTION_LABELS[e]])]);
fillSelect('#say-gesture', [['', 'Sin gesto'], ...Object.entries(GESTURES).map(([k, g]) => [k, g.label])]);
$('#say-btn').onclick = () => {
  const c = { type: 'speak', text: $('#say-text').value };
  if ($('#say-emotion').value) c.emotion = $('#say-emotion').value;
  if ($('#say-gesture').value) c.gesture = $('#say-gesture').value;
  runLocal(c);
};

// huesos
function populateBoneSelect() {
  const order = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head'];
  const sorted = [...availableBones].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return isFinger(a) - isFinger(b) || a.localeCompare(b);
  });
  fillSelect('#bone-select', sorted.map((b) => [b, b]));
  $('#bone-select').value = availableBones.includes('head') ? 'head' : sorted[0];
  syncBoneSliders();
}
function syncBoneSliders() {
  const s = boneState.get($('#bone-select').value);
  const v = s ? (s.to || s.cur) : { x: 0, y: 0, z: 0 };
  for (const a of AXES) {
    const deg = Math.round(v[a] / DEG);
    $(`#b${a}`).value = deg;
    $(`#b${a}-out`).textContent = `${deg}°`;
  }
}
$('#bone-select').onchange = syncBoneSliders;
for (const a of AXES) {
  $(`#b${a}`).oninput = () => {
    const bone = $('#bone-select').value;
    if (!bone || !vrm) return;
    $(`#b${a}-out`).textContent = `${$(`#b${a}`).value}°`;
    setBone(bone, { [a]: +$(`#b${a}`).value }, 0.08);
    currentPose = 'custom';
  };
  $(`#b${a}`).onchange = () => logEntry('manual', { type: 'bones', rotations: { [$('#bone-select').value]: { [a]: +$(`#b${a}`).value } } }, { ok: true });
}
$('#bone-zero').onclick = () => {
  const bone = $('#bone-select').value;
  if (bone) runLocal({ type: 'bones', rotations: { [bone]: { x: 0, y: 0, z: 0 } } }).then(syncBoneSliders);
};

// mover
for (const b of document.querySelectorAll('[data-move]')) {
  b.onclick = () => {
    const v = b.dataset.move;
    if (v === 'center') return runLocal({ type: 'move', x: 0, z: 0 });
    const [x, z] = v.split(',').map(Number);
    runLocal({ type: 'move', x, z, relative: true });
  };
}
for (const b of document.querySelectorAll('[data-turn]')) {
  b.onclick = () => {
    const deg = +b.dataset.turn;
    runLocal(deg === 0 ? { type: 'move', rotation: 0 } : { type: 'move', rotation: deg, relative: true });
  };
}

// consola
const EXAMPLES = {
  'Saludo completo': {
    type: 'sequence',
    steps: [
      { type: 'speak', text: '¡Hola! Bienvenidos al stream.', emotion: 'happy', gesture: 'wave' },
      { type: 'gesture', name: 'nod' },
      { type: 'speak', text: 'Hoy vamos a hacer algo muy divertido.', emotion: 'relaxed' },
      { type: 'gesture', name: 'cheer' },
    ],
  },
  'Mover huesos libremente': { type: 'bones', rotations: { head: { y: 25, z: 10 }, rightUpperArm: { z: -30 }, rightLowerArm: { z: -60 } }, duration: 0.6 },
  'Paseo por el escenario': {
    type: 'sequence',
    steps: [
      { type: 'move', rotation: 90, duration: 0.5 },
      { type: 'move', x: 0.8 },
      { type: 'move', rotation: 0, duration: 0.5 },
      { type: 'gesture', name: 'point', side: 'left' },
      { type: 'move', rotation: -90, duration: 0.5 },
      { type: 'move', x: 0 },
      { type: 'move', rotation: 0, duration: 0.5 },
    ],
  },
  'Mezcla de expresiones': { type: 'expression', values: { happy: 0.5, surprised: 0.6 }, hold: 2 },
  'Bailar en bucle': { type: 'gesture', name: 'dance', loop: true },
  'Detener todo': { type: 'stop', what: 'all' },
  'Modo OBS (fondo verde)': [{ type: 'background', mode: 'green' }, { type: 'camera', preset: 'bust' }],
};
fillSelect('#example-select', [['', 'Ejemplos…'], ...Object.keys(EXAMPLES).map((k) => [k, k])]);
$('#console-input').value = JSON.stringify(EXAMPLES['Saludo completo'], null, 2);
$('#example-select').onchange = () => {
  const ex = EXAMPLES[$('#example-select').value];
  if (ex) $('#console-input').value = JSON.stringify(ex, null, 2);
};
$('#console-run').onclick = () => {
  let data;
  try { data = JSON.parse($('#console-input').value); } catch (e) {
    logEntry('manual', { error: 'JSON inválido' }, { ok: false, error: e.message });
    return;
  }
  runLocal(data);
};
$('#console-format').onclick = () => {
  try { $('#console-input').value = JSON.stringify(JSON.parse($('#console-input').value), null, 2); } catch {}
};
$('#console-input').addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); $('#console-run').click(); }
});

const endpoint = `${location.origin}/api/command`;
$('#endpoint').textContent = `POST ${endpoint}`;
$('#copy-curl').onclick = async () => {
  const body = JSON.stringify({ type: 'speak', text: 'Hola desde la IA', emotion: 'happy', gesture: 'wave' });
  const cmd = `curl -X POST ${endpoint} -H "Content-Type: application/json" -d '${body}'`;
  try { await navigator.clipboard.writeText(cmd); $('#copy-curl').textContent = '¡Copiado!'; }
  catch { $('#copy-curl').textContent = 'No se pudo copiar'; }
  setTimeout(() => { $('#copy-curl').textContent = 'Copiar ejemplo curl'; }, 1500);
};

// pestañas
for (const tab of document.querySelectorAll('.tab')) {
  tab.onclick = () => {
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
    for (const p of document.querySelectorAll('.tab-page')) p.classList.toggle('active', p.dataset.page === tab.dataset.tab);
    try { localStorage.setItem('vtuber-tab', tab.dataset.tab); } catch {}
  };
}
try { const t = localStorage.getItem('vtuber-tab'); if (t) document.querySelector(`.tab[data-tab="${t}"]`)?.click(); } catch {}

// mostrar/ocultar panel
const togglePanel = () => { document.body.classList.toggle('panel-hidden'); setTimeout(resize, 0); };
$('#toggle-panel').onclick = togglePanel;
window.addEventListener('keydown', (e) => {
  if (OBS) return;
  if (e.key?.toLowerCase() === 'h' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) togglePanel();
});

// voz
const voiceSel = $('#voice-select');
function populateVoices() {
  if (!('speechSynthesis' in window)) { voiceSel.innerHTML = '<option>TTS no disponible</option>'; return; }
  const voices = speechSynthesis.getVoices().slice().sort((a, b) => (b.lang.startsWith('es') - a.lang.startsWith('es')) || a.lang.localeCompare(b.lang));
  fillSelect('#voice-select', [['', 'Automática (español)'], ...voices.map((v) => [v.voiceURI, `${v.name} — ${v.lang}`])]);
  voiceSel.value = tts.voiceURI;
}
if ('speechSynthesis' in window) { populateVoices(); speechSynthesis.onvoiceschanged = populateVoices; }
voiceSel.onchange = () => { tts.voiceURI = voiceSel.value; saveTts(); };
$('#tts-on').checked = tts.enabled;
$('#tts-on').onchange = () => { tts.enabled = $('#tts-on').checked; saveTts(); updateAudioHint(); };
$('#pitch').value = Math.round(tts.pitch * 100);
$('#pitch-out').textContent = tts.pitch.toFixed(1);
$('#pitch').oninput = () => { tts.pitch = +$('#pitch').value / 100; $('#pitch-out').textContent = tts.pitch.toFixed(1); saveTts(); };
function updateAudioHint() { $('#audio-hint').hidden = tts.unlocked || !tts.enabled; }
const unlock = () => {
  if (tts.unlocked) return;
  tts.unlocked = true;
  updateAudioHint();
};
window.addEventListener('pointerdown', unlock, { once: true });
window.addEventListener('keydown', unlock, { once: true });
updateAudioHint();

// reposo y reset
$('#idle-on').onchange = () => runLocal({ type: 'idle', enabled: $('#idle-on').checked });
$('#blink-on').onchange = () => runLocal({ type: 'idle', blink: $('#blink-on').checked });
$('#reset-btn').onclick = () => runLocal({ type: 'reset' });

// ratón (para mirar al cursor)
canvas.addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect();
  mouseNdc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
});

// modelos
async function refreshModelList() {
  let list = [];
  try { list = await (await fetch('/api/models')).json(); } catch {}
  fillSelect('#model-select', [['', 'Elegir modelo…'], ['sample', 'Modelo de ejemplo'], ...list.map((m) => [m.name, m.name])]);
}
refreshModelList();
/**
 * Pide a TODOS los visores (este panel y el overlay de Amadeus Desktop) que carguen un modelo de
 * models/. El servidor lo recuerda como modelo inicial para los visores que se conecten después.
 * Si no hay servidor (página abierta sin él), lo carga solo aquí.
 */
async function cargarEnTodos(nombre) {
  try {
    const r = await fetch('/api/command', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Source': 'panel' },
      body: JSON.stringify({ type: 'load_model', url: nombre }),
    });
    if (r.ok) return;
  } catch { /* sin servidor: solo local */ }
  runLocal({ type: 'load_model', url: nombre });
}
$('#model-select').onchange = () => {
  const v = $('#model-select').value;
  if (v) cargarEnTodos(v);
};
async function loadFile(file) {
  if (!file || !/\.vrm$/i.test(file.name)) {
    logEntry('manual', { type: 'load_model', file: file?.name }, { ok: false, error: 'Elige un archivo .vrm' });
    return;
  }
  // Se sube a models/ para que el overlay del escritorio (y cualquier visor nuevo) use el mismo modelo.
  setOverlay('Subiendo modelo…');
  try {
    const r = await fetch('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
      body: file,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
    refreshModelList();
    await cargarEnTodos(j.name);
  } catch (err) {
    console.warn('[visor] No se pudo subir el modelo; se carga solo en esta pestaña:', err?.message || err);
    loadModel(URL.createObjectURL(file), file.name).catch(() => {});
  }
}
$('#file-input').onchange = (e) => loadFile(e.target.files[0]);
if (!DESKTOP) {
  // arrastrar un .vrm a la ventana (en el escritorio no: la ventana deja pasar los clics)
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    loadFile(e.dataTransfer.files[0]);
  });
}

// parámetros de URL: ?bg=green&camera=bust&model=archivo.vrm (en el escritorio el fondo es siempre transparente)
if (DESKTOP) {
  setBackground('transparent');
} else if (params.get('bg')) {
  try { setBackground(params.get('bg')); } catch {}
} else if (OBS) {
  setBackground('transparent');
}
if (params.get('camera') && CAMERA_PRESETS.includes(params.get('camera'))) cameraPreset = params.get('camera');
else if (DESKTOP) cameraPreset = 'full';
else if (OBS) cameraPreset = 'bust';
syncChips('#camera-chips', cameraPreset);

// visibilidad sin Electron: la de la pestaña
if (!AD_VISIBILIDAD) {
  document.addEventListener('visibilitychange', () => {
    visible = document.visibilityState === 'visible';
    postState();
  });
}
if (DESKTOP) iniciarEscritorio();
if (!AD_VISIBILIDAD || visible) reanudarRender();     // dentro de Electron arranca con la ventana oculta

// expuesto para depuración y para IAs que corren dentro de la página
window.vtuber = {
  execute: (c) => runLocal(c, 'api'),
  state: snapshot,
  COMMANDS,
  get vrm() { return vrm; },
  get escritorio() {
    return DESKTOP ? {
      x: Math.round(esc.x), y: Math.round(esc.y), oculta: esc.oculta, saliendo: esc.saliendo, visible,
      interactivo: esc.interactivo, caminando: escritorioEnMovimiento(), render: renderActivo, tema: temaNombre(),
      frames: framesRender,
    } : null;
  },
  /** Depuración del hit-test: ¿el punto (px CSS de la ventana) cae sobre el cuerpo? (píxel y raycast) */
  probarHit(x, y) {
    if (!DESKTOP || !vrm) return null;
    const lx = x - esc.x, ly = y - esc.y;
    const dentro = sobreElCuerpo({ x, y }, true);
    hitNdc.set((lx / BOX.w) * 2 - 1, -(ly / BOX.h) * 2 + 1);
    hitRay.setFromCamera(hitNdc, camera);
    let n = 0, error = null;
    try { n = hitRay.intersectObject(vrm.scene, true).length; } catch (err) { error = String(err?.message || err); }
    return {
      dentro, porPixel: hitPorPixel, intersecciones: n, error,
      ndc: [+hitNdc.x.toFixed(3), +hitNdc.y.toFixed(3)],
    };
  },
};

// arranque: ?model= manda; si no, el modelo que indica el servidor ("hello"); si no llega a tiempo o
// falla al cargar, el de ejemplo (CDN). Una carga pedida mientras tanto (load_model) no se pisa.
const modeloPedido = params.get('model');
const modeloInicial = modeloPedido
  || await Promise.race([modeloDelServidor, wait(2500).then(() => null)])
  || 'sample';
if (!loadToken) {
  const [startUrl, startLabel] = await resolveModelUrl(modeloInicial);
  loadModel(startUrl, startLabel).catch((err) => {
    console.error(err);
    if (!modeloPedido && startUrl !== DEFAULT_MODEL_URL && !vrm && !cargaEnCurso) {
      console.warn(`[visor] No se pudo cargar "${modeloInicial}"; se usa el modelo de ejemplo.`);
      loadModel(DEFAULT_MODEL_URL, 'Modelo de ejemplo').catch((e) => console.error(e));
    }
  });
}
