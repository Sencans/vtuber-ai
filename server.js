// VTuber AI Studio — servidor local sin dependencias.
//   - Sirve el visor (public/) y los modelos (models/)
//   - API HTTP para que cualquier IA mande comandos:  POST /api/command
//   - Empuja los comandos al navegador por SSE:       GET  /api/events
//   - Endpoint MCP (Streamable HTTP, JSON):           POST /mcp
//
// Seguridad (todo POST): Content-Type application/json (fuerza el preflight CORS) y Origin ausente o
// local (http://127.0.0.1|localhost:<puerto real>); CORS solo refleja ese Origin. 'desktop' y 'theme'
// exigen X-Source: rams (o mcp con MCP_DESKTOP=1). El SSE de los visores exige además lo que manda un
// EventSource (Accept: text/event-stream y, si el navegador las envía, Sec-Fetch-Dest: empty y
// Sec-Fetch-Site same-origin): un <iframe>/<audio>/<video> de otra web no se registra como visor.
// El estado es por instancia de createServer() y por visor: GET /api/state publica el del panel
// (visor no-escritorio más reciente) y el del overlay solo si no hay otro.
import http from 'node:http';
import { readFile, readdir, stat, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { HELP, THEMES } from './lib/protocol.js';
import { handleRpc } from './lib/mcp.js';
import {
  normalizeCommands, targetsFor, desktopCount, desktopTotal, fuentePermitida,
} from './lib/dispatch.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const MODELS_DIR = path.join(ROOT, 'models');
const LIB_DIR = path.join(ROOT, 'lib');
const MAX_BODY = 1024 * 1024;

/**
 * Huella del código del visor (public/*.js|css|html y lib/protocol.js) al arrancar el servidor. Va en
 * el "hello": si un visor ya abierto se reconecta a un servidor con otro código, se recarga solo
 * (si no, seguiría ejecutando el app.js viejo, p. ej. el overlay de Amadeus Desktop).
 */
function huellaVisor() {
  const h = createHash('sha256');
  try {
    const archivos = readdirSync(PUBLIC_DIR).filter((f) => /\.(js|css|html)$/i.test(f)).sort()
      .map((f) => path.join(PUBLIC_DIR, f));
    archivos.push(path.join(LIB_DIR, 'protocol.js'));
    for (const f of archivos) { h.update(f); h.update(readFileSync(f)); }
  } catch { h.update(String(Date.now())); }
  return h.digest('hex').slice(0, 16);
}
const MAX_VRM = 128 * 1024 * 1024;   // tope de un .vrm subido desde el panel
const DEFAULT_PORT = 3939;
const MAX_HISTORY = 100;
// Claves que calcula el servidor: un visor no puede fijarlas con POST /api/state.
const CLAVES_CALCULADAS = ['viewers', 'desktopViewers', 'desktopViewersTotal', 'viewerSeq', 'viewerId', 'viewer'];
// Lote difundido a panel y overlay: si confirma primero el overlay (que ignora x/z, camera y fondo), se
// espera como mucho esto al ack de un visor que no sea de escritorio antes de devolver el del overlay.
const GRACIA_ACK_MS = 600;
const GRACIA_ACK_CARGA_MS = 5000;     // load_model: los dos descargan el mismo archivo
const MAX_MODELO = 512;               // longitud máxima de una URL/nombre de modelo recordado

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.vrm': 'model/gltf-binary',
  '.glb': 'model/gltf-binary',
};

/** Puerto: PORT definido y entero ≥ 0 (acepta 0 = puerto libre) → ese; si no, 3939. */
export function resolverPuerto(env = {}) {
  const raw = env.PORT;
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_PORT;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : DEFAULT_PORT;
}

// ---------------------------------------------------------------- utilidades sin estado
function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && body !== null && !(body instanceof Buffer);
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isObj ? JSON.stringify(body, null, 2) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let aborted = false;
    const chunks = [];
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY) { aborted = true; reject(new Error('Cuerpo demasiado grande')); req.resume(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve(null);
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('JSON inválido')); }
    });
    req.on('error', reject);
  });
}

const esJson = (req) => String(req.headers['content-type'] || '').trim().toLowerCase().startsWith('application/json');

/** Binario de un .vrm: tipo no "simple" para CORS, así que un navegador ajeno siempre hace preflight. */
const esBinarioVrm = (req) => /^(application\/octet-stream|model\/gltf-binary)\s*(;|$)/i
  .test(String(req.headers['content-type'] || '').trim());

/**
 * Nombre seguro para un .vrm subido (cabecera X-Filename, codificada con encodeURIComponent): solo el
 * nombre base, letras/dígitos/espacio/._-, termina en .vrm, ≤ 100 caracteres; si no, null.
 */
function nombreVrmSeguro(crudo) {
  let n;
  try { n = decodeURIComponent(String(crudo || '')); } catch { return null; }
  n = n.split(/[\\/]/).pop().normalize('NFC').trim();
  if (!/^[\p{L}\p{N} ._()-]{1,96}\.vrm$/iu.test(n) || n.startsWith('.')) return null;
  return n;
}

const BUILD = huellaVisor();

/** Lee el cuerpo binario con tope de tamaño (rechaza en cuanto lo supera). */
function readBinary(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let aborted = false;
    const chunks = [];
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > max) { aborted = true; reject(new Error('El archivo es demasiado grande')); req.resume(); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!aborted) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

/** Nombre de la fuente (cabecera X-Source) saneado: [a-z0-9_-]{1,32} o 'api'. */
function fuenteDe(req) {
  const s = String(req.headers['x-source'] || '').trim().toLowerCase();
  return /^[a-z0-9_-]{1,32}$/.test(s) ? s : 'api';
}

async function serveFile(res, filePath, baseDir, method = 'GET') {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, filePath);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) return send(res, 403, 'Prohibido');
  try {
    const info = await stat(resolved);
    if (!info.isFile()) return send(res, 404, 'No encontrado');
    const data = method === 'HEAD' ? null : await readFile(resolved);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  } catch {
    send(res, 404, 'No encontrado');
  }
}

function decodificar(p) {
  try { return decodeURIComponent(p); } catch { return null; }
}

/** Nombre/URL de modelo que se puede recordar y volver a pedir (nada de blob:/data:, ni vacío). */
function modeloRecordable(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > MAX_MODELO || /^(blob|data):/i.test(s)) return null;
  return s;
}

/**
 * ¿La petición a /api/events la hace un EventSource de la propia página? EventSource siempre manda
 * Accept: text/event-stream; los navegadores con Fetch Metadata añaden Sec-Fetch-Dest: empty y
 * Sec-Fetch-Site same-origin. Un <iframe>, <audio>, <video>, <img> o <script> de otra web no envía
 * Origin, así que el control de Origin no basta para impedir que se registre como visor fantasma.
 */
function esEventSourcePropio(req) {
  const accept = String(req.headers.accept || '').toLowerCase();
  if (!accept.includes('text/event-stream')) return false;
  const dest = req.headers['sec-fetch-dest'];
  if (dest !== undefined && String(dest).toLowerCase() !== 'empty') return false;
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && !['same-origin', 'none'].includes(String(site).toLowerCase())) return false;
  return true;
}

// ---------------------------------------------------------------- servidor por instancia
/**
 * Crea un servidor de VTuber AI Studio con su propio estado (visores, acks, historial, estado del avatar).
 * @param {{port?: number, host?: string, env?: object, modelsDir?: string}} opciones  port/host mandan
 *        sobre env.PORT/env.HOST; modelsDir (por defecto ./models) es la carpeta de los .vrm propios
 * @returns {{server: http.Server, listen(): Promise<{port:number}>, close(): Promise<void>,
 *            dispatch(body, source?): Promise<object>}}
 */
export function createServer({ port, host, env = process.env, modelsDir = MODELS_DIR } = {}) {
  const PORT = Number.isInteger(port) && port >= 0 ? port : resolverPuerto(env);
  const HOST = host || env.HOST || '127.0.0.1';

  const viewers = new Set();      // { id, res, obs, desktop, visible, theme, ping, state, stateAt }
  const pending = new Map();      // commandId -> recibir(ack)
  const history = [];             // últimos comandos (para depurar)
  // Estado de reserva: el inicial y el de visores sin viewerId (versiones antiguas del visor). Cada visor
  // guarda el suyo en viewer.state; estadoPublico() elige cuál se publica.
  let avatarState = { ready: false, note: 'Todavía no hay ningún visor conectado.' };
  let stateSeq = 0;               // orden de llegada de los POST /api/state (desempata el "más reciente")
  let viewerSeq = 0;              // +1 por cada conexión SSE (nuevo visor o recarga)
  let ultimoModelo = null;        // último load_model difundido y confirmado (lo carga un visor nuevo)
  let realPort = PORT;

  const origenesPermitidos = () => new Set([`http://127.0.0.1:${realPort}`, `http://localhost:${realPort}`]);
  /** Origin ausente → permitido; presente → solo el local con el puerto real. */
  const origenPermitido = (origin) => origin === undefined || origenesPermitidos().has(origin);

  // Protección contra DNS rebinding: solo aceptamos Host local.
  function isLocalHost(req) {
    const h = (req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    return ['localhost', '127.0.0.1', '::1'].includes(h) || h === HOST;
  }

  /**
   * Estado que se publica: el del visor no-escritorio (panel u OBS) que informó más recientemente; si no
   * hay ninguno con estado, el del overlay de escritorio más reciente; si tampoco, el de reserva. El
   * overlay ignora x/z, el encuadre y el fondo, así que su "current" no describe al avatar del panel.
   */
  function estadoElegido() {
    let mejor = null;
    for (const v of viewers) {
      if (!v.state) continue;
      if (!mejor || (mejor.desktop && !v.desktop) || (mejor.desktop === v.desktop && v.stateAt > mejor.stateAt)) mejor = v;
    }
    return mejor ? mejor.state : avatarState;
  }

  function estadoPublico() {
    const calculados = {
      viewers: viewers.size,
      desktopViewers: desktopCount(viewers),
      desktopViewersTotal: desktopTotal(viewers),
      viewerSeq,
    };
    const base = { ...estadoElegido() };
    for (const k of CLAVES_CALCULADAS) delete base[k];
    return { ...base, ...calculados };   // los calculados, al final
  }

  /**
   * Modelo con el que arranca un visor sin ?model= (va en el evento SSE "hello"): el último load_model
   * difundido y confirmado; si no, VTUBER_AI_MODELO; si no, el primer .vrm de models/; si no, 'sample'.
   */
  async function modeloInicial() {
    if (ultimoModelo) return ultimoModelo;
    const delEntorno = modeloRecordable(env.VTUBER_AI_MODELO);
    if (delEntorno) return delEntorno;
    try {
      const vrms = (await readdir(modelsDir)).filter((f) => /\.vrm$/i.test(f))
        .sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
      if (vrms.length) return vrms[0];
    } catch { /* sin carpeta models/ */ }
    return 'sample';
  }

  /** Recuerda el último load_model que confirmó el visor (para los visores que se conecten después). */
  function recordarModelo(commands, results) {
    commands.forEach((c, i) => {
      if (c?.type !== 'load_model' || !results[i]?.ok) return;
      const m = modeloRecordable(c.url || c.name);
      if (m) ultimoModelo = m;
    });
  }

  function difundir(targets, event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const v of targets) {
      try { v.res.write(payload); } catch { /* el cierre lo limpia */ }
    }
  }

  /**
   * Envía comandos a los visores destinatarios y espera la confirmación del primero que responda.
   * Lanza Error si el lote no es válido (→ 400). Devuelve {ok:false, code} para fuente/visores.
   */
  async function dispatch(body, source = 'api') {
    const commands = normalizeCommands(body);
    if (!fuentePermitida(commands, source, env)) {
      return {
        ok: false, code: 'fuente',
        error: 'Los comandos "desktop" y "theme" solo se aceptan de R.A.M.S. (X-Source: rams) o de MCP con MCP_DESKTOP=1.',
      };
    }
    const hayDesktop = commands.some((c) => c.type === 'desktop');
    if (hayDesktop) targetsFor([], commands);   // lote mixto → Error (400) antes de mirar los visores
    if (viewers.size === 0) {
      return {
        ok: false, code: 'sin_visores',
        error: `No hay ningún visor abierto. Abre http://localhost:${realPort} en el navegador para ver y mover el avatar.`,
      };
    }
    if (hayDesktop && desktopTotal(viewers) === 0) {
      return {
        ok: false, code: 'sin_overlay',
        error: 'No hay ningún visor de escritorio (?desktop=1) abierto: arranca Amadeus Desktop.',
      };
    }
    const targets = targetsFor(viewers, commands);
    const id = randomUUID();
    const cargaModelo = commands.some((c) => c.type === 'load_model');
    const waitMs = cargaModelo ? 60000 : 2500;
    // Si el lote llega a algún visor que no es de escritorio, su ack manda: el del overlay (x/z, camera
    // y fondo ignorados) solo se usa si ninguno de ellos confirma dentro del margen de gracia.
    const preferirPanel = targets.some((v) => !v.desktop);
    const ack = new Promise((resolve) => {
      let reserva = null;
      let gracia = 0;
      const fin = (data) => { clearTimeout(timer); clearTimeout(gracia); pending.delete(id); resolve(data); };
      const timer = setTimeout(() => fin(reserva), waitMs);
      pending.set(id, (data) => {
        if (!data) return fin(reserva);                     // close(): se acabó la espera
        const v = typeof data.viewerId === 'string' ? targets.find((x) => x.id === data.viewerId) : null;
        // sin viewerId (visor antiguo, siempre sin modo escritorio) cuenta como panel
        if (!preferirPanel || !v?.desktop) return fin(data);
        if (!reserva) reserva = data;
        if (!gracia) gracia = setTimeout(() => fin(reserva), cargaModelo ? GRACIA_ACK_CARGA_MS : GRACIA_ACK_MS);
      });
    });
    difundir(targets, 'command', { id, source, commands });
    history.push({ at: new Date().toISOString(), source, commands });
    if (history.length > MAX_HISTORY) history.shift();

    const result = await ack;
    if (!result) return { ok: true, delivered: targets.length, confirmed: false, note: 'Enviado, pero el visor no confirmó a tiempo.' };
    const results = Array.isArray(result.results) ? result.results : [];
    recordarModelo(commands, results);
    return { ok: results.every((r) => r && r.ok), delivered: targets.length, results };
  }

  const mcpCtx = {
    env,
    dispatch: (cmds) => dispatch(cmds, 'mcp'),
    getState: async () => estadoPublico(),
  };

  /** Cabeceras CORS: solo para el Origin local permitido (nunca '*'). */
  function cors(req, res) {
    res.setHeader('Vary', 'Origin');
    const origin = req.headers.origin;
    if (origin !== undefined && origenPermitido(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Source');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    }
  }

  const rechazoOrigen = (res, msg) => send(res, 403, { ok: false, code: 'origen', error: msg });

  async function abrirSse(req, res, url) {
    // el modelo inicial se resuelve antes de registrar el visor: así "hello" es siempre su primer evento
    const defaultModel = await modeloInicial();
    if (req.destroyed || res.destroyed) return;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    viewerSeq += 1;
    const viewer = {
      id: randomUUID(),
      res,
      obs: url.searchParams.has('obs'),
      desktop: url.searchParams.has('desktop'),
      visible: false,
      theme: null,
      ping: null,
      state: null,                 // último POST /api/state de este visor
      stateAt: 0,
    };
    viewers.add(viewer);
    res.write(`event: hello\ndata: ${JSON.stringify({ id: viewer.id, viewers: viewers.size, desktop: viewer.desktop, viewerSeq, defaultModel, build: BUILD })}\n\n`);
    viewer.ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
    const cerrar = () => {
      clearInterval(viewer.ping);
      if (!viewers.has(viewer)) return;
      // si era el estado publicado, queda como el último conocido cuando ya no haya ningún visor con estado
      if (viewer.state && estadoElegido() === viewer.state) avatarState = viewer.state;
      viewers.delete(viewer);
    };
    req.on('close', cerrar);
    res.on('close', cerrar);
  }

  async function manejar(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (!isLocalHost(req)) return send(res, 403, { ok: false, error: 'Host no permitido' });

    const esApi = p.startsWith('/api/') || p === '/mcp';
    if (esApi) cors(req, res);
    const origin = req.headers.origin;

    if (esApi && req.method === 'OPTIONS') {
      if (!origenPermitido(origin)) return rechazoOrigen(res, 'Origen no permitido.');
      return send(res, 204, '');
    }

    // Todo POST: JSON (o el binario de un .vrm en POST /api/models) y Origin ausente o local.
    if (req.method === 'POST') {
      const subidaVrm = p === '/api/models' && esBinarioVrm(req);
      if (!esJson(req) && !subidaVrm) return rechazoOrigen(res, 'Content-Type debe ser application/json.');
      if (!origenPermitido(origin)) return rechazoOrigen(res, 'Origen no permitido.');
    }

    // --- SSE para los visores: solo un EventSource de la propia página (ni Origin ajeno, ni un
    //     <iframe>/<audio>/<video> de otra web, que no mandan Origin)
    if (p === '/api/events' && req.method === 'GET') {
      if (!origenPermitido(origin)) return rechazoOrigen(res, 'Origen no permitido.');
      if (!esEventSourcePropio(req)) {
        return rechazoOrigen(res, 'Solo un EventSource del propio visor (Accept: text/event-stream, misma origen) puede registrarse.');
      }
      return abrirSse(req, res, url);
    }

    if (p === '/api/command' && req.method === 'POST') {
      let body;
      try { body = await readBody(req); } catch (e) { return send(res, 400, { ok: false, code: 'invalido', error: e.message }); }
      let result;
      try { result = await dispatch(body, fuenteDe(req)); }
      catch (e) { return send(res, 400, { ok: false, code: 'invalido', error: e.message }); }
      const status = result.code === 'fuente' ? 403
        : (result.code === 'sin_visores' || result.code === 'sin_overlay') ? 409 : 200;
      return send(res, status, result);
    }

    if (p === '/api/ack' && req.method === 'POST') {
      let body;
      try { body = await readBody(req); } catch (e) { return send(res, 400, { ok: false, error: e.message }); }
      const resolve = body && typeof body.id === 'string' && pending.get(body.id);
      if (resolve) resolve(body);
      return send(res, 200, { ok: true });
    }

    if (p === '/api/state') {
      if (req.method === 'POST') {
        let body;
        try { body = await readBody(req); } catch (e) { return send(res, 400, { ok: false, error: e.message }); }
        if (body && typeof body === 'object' && !Array.isArray(body)) {
          const v = typeof body.viewerId === 'string' ? [...viewers].find((x) => x.id === body.viewerId) : null;
          const limpio = { ...body };
          for (const k of CLAVES_CALCULADAS) delete limpio[k];
          const estado = { ...limpio, updatedAt: new Date().toISOString() };
          if (v) {
            const info = body.viewer && typeof body.viewer === 'object' ? body.viewer : {};
            v.visible = !!info.visible;
            v.theme = THEMES.includes(info.theme) ? info.theme : null;
            v.state = estado;          // cada visor el suyo: el overlay no pisa el del panel
            v.stateAt = ++stateSeq;
          } else {
            avatarState = estado;      // sin visor conocido: solo el de reserva
          }
        }
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' || req.method === 'HEAD') return send(res, 200, estadoPublico());
      return send(res, 405, { ok: false, error: 'Usa GET o POST' }, { Allow: 'GET, POST' });
    }

    if (p === '/api/help') return send(res, 200, HELP);
    if (p === '/api/log') return send(res, 200, history);

    // Subida de un .vrm desde el panel (para que el overlay y los demás visores puedan cargarlo).
    if (p === '/api/models' && req.method === 'POST') {
      const nombre = nombreVrmSeguro(req.headers['x-filename']);
      if (!nombre) return send(res, 400, { ok: false, error: 'Nombre de archivo inválido (debe terminar en .vrm).' });
      let datos;
      try { datos = await readBinary(req, MAX_VRM); } catch (e) { return send(res, 413, { ok: false, error: e.message }); }
      // Un VRM es glTF binario: cabecera "glTF", versión 2 y longitud coherente.
      if (datos.length < 20 || datos.toString('latin1', 0, 4) !== 'glTF' || datos.readUInt32LE(4) !== 2
        || datos.readUInt32LE(8) !== datos.length) {
        return send(res, 400, { ok: false, error: 'El archivo no es un glTF binario (.vrm) válido.' });
      }
      const destino = path.join(modelsDir, nombre);
      if (path.dirname(destino) !== path.resolve(modelsDir)) return send(res, 400, { ok: false, error: 'Ruta inválida' });
      const temporal = `${destino}.${randomUUID()}.parcial`;
      try {
        await mkdir(modelsDir, { recursive: true });
        await writeFile(temporal, datos);
        await rename(temporal, destino);
      } catch (e) {
        unlink(temporal).catch(() => {});
        return send(res, 500, { ok: false, error: `No se pudo guardar el modelo: ${e.message}` });
      }
      return send(res, 200, { ok: true, name: nombre, url: `/models/${encodeURIComponent(nombre)}`, bytes: datos.length });
    }

    if (p === '/api/models') {
      let files = [];
      try { files = (await readdir(modelsDir)).filter((f) => /\.vrm$/i.test(f)); } catch {}
      return send(res, 200, files.map((f) => ({ name: f, url: `/models/${encodeURIComponent(f)}` })));
    }

    // --- MCP (Streamable HTTP, solo respuestas JSON)
    if (p === '/mcp') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Usa POST' }, { Allow: 'POST' });
      let body;
      try { body = await readBody(req); } catch (e) {
        return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: e.message } });
      }
      const msgs = Array.isArray(body) ? body : [body];
      const out = (await Promise.all(msgs.map((m) => handleRpc(m, mcpCtx)))).filter(Boolean);
      if (!out.length) return send(res, 202, '');
      return send(res, 200, Array.isArray(body) ? out : out[0]);
    }

    if (p.startsWith('/api/')) return send(res, 404, { ok: false, error: 'Ruta de la API desconocida. Ver GET /api/help' });

    // --- archivos estáticos
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Método no permitido');
    if (p === '/protocol.js') return serveFile(res, 'protocol.js', LIB_DIR, req.method);
    if (p.startsWith('/models/')) {
      const rel = decodificar(p.slice('/models/'.length));
      return rel === null ? send(res, 400, 'Ruta inválida') : serveFile(res, rel, modelsDir, req.method);
    }
    const rel = p === '/' ? 'index.html' : decodificar(p.slice(1));
    if (rel === null) return send(res, 400, 'Ruta inválida');
    return serveFile(res, rel, PUBLIC_DIR, req.method);
  }

  const server = http.createServer((req, res) => {
    manejar(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) send(res, 500, { ok: false, error: String(err?.message || err) });
      else try { res.end(); } catch {}
    });
  });

  function listen() {
    return new Promise((resolve, reject) => {
      const onError = (err) => { server.off('listening', onListening); reject(err); };
      const onListening = () => {
        server.off('error', onError);
        realPort = server.address().port;
        resolve({ port: realPort });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(PORT, HOST);
    });
  }

  function close() {
    for (const resolve of [...pending.values()]) resolve(null);
    pending.clear();
    for (const v of [...viewers]) {
      clearInterval(v.ping);
      try { v.res.end(); } catch {}
    }
    viewers.clear();
    return new Promise((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  return { server, listen, close, dispatch };
}

// ---------------------------------------------------------------- arranque como programa
function esModuloPrincipal() {
  const arg = process.argv[1];
  if (!arg) return false;
  if (import.meta.url === pathToFileURL(arg).href) return true;
  // `node server` (sin extensión) o rutas con enlaces: comparar rutas reales.
  for (const candidato of [arg, `${arg}.js`]) {
    try { if (realpathSync(candidato) === realpathSync(fileURLToPath(import.meta.url))) return true; } catch {}
  }
  return false;
}

if (esModuloPrincipal()) {
  const app = createServer();
  app.listen().then(({ port }) => {
    const base = `http://localhost:${port}`;
    console.log('');
    console.log('  VTuber AI Studio');
    console.log(`  Visor ............ ${base}`);
    console.log(`  Vista para OBS ... ${base}/?obs=1`);
    console.log(`  Modo escritorio .. ${base}/?desktop=1  (lo abre Amadeus Desktop)`);
    console.log(`  API de comandos .. POST ${base}/api/command`);
    console.log(`  Ayuda ............ ${base}/api/help`);
    console.log(`  MCP (HTTP) ....... ${base}/mcp`);
    console.log('');
  }).catch((err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`El puerto ${resolverPuerto(process.env)} está ocupado. Cierra la otra instancia o usa: PORT=4000 npm start`);
    } else {
      console.error(err);
    }
    process.exit(1);
  });
}
