// Pruebas de server.js con servidores propios en 127.0.0.1:0 (nunca el :3939 en vivo).
// Ejecutar: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, existsSync, readdirSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, resolverPuerto } from '../server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

// ---------------------------------------------------------------- ayudas
async function arrancar(env = {}) {
  const app = createServer({ port: 0, host: '127.0.0.1', env });
  const { port } = await app.listen();
  assert.notEqual(port, 3939);
  return { app, port };
}

function peticion(port, { method = 'GET', path: ruta = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const h = { ...headers };
    const tieneCt = Object.keys(h).some((k) => k.toLowerCase() === 'content-type');
    if (data !== null && !tieneCt) h['Content-Type'] = 'application/json';
    if (data !== null) h['Content-Length'] = Buffer.byteLength(data);
    const req = http.request({ host: '127.0.0.1', port, method, path: ruta, headers: h }, (res) => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { s += c; });
      res.on('end', () => {
        let json = null;
        try { json = s ? JSON.parse(s) : null; } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text: s, json });
      });
    });
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

const post = (port, ruta, body, headers = {}) => peticion(port, { method: 'POST', path: ruta, body, headers });
const get = (port, ruta, headers = {}) => peticion(port, { path: ruta, headers });

/** Cabeceras de un EventSource del propio visor (Chromium con Fetch Metadata). */
const CABECERAS_SSE = { Accept: 'text/event-stream', 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors' };

/**
 * Visor SSE de prueba: guarda los eventos y puede confirmar (ack) los comandos solo, con su viewerId
 * (como app.js) y, si se pide, con retraso.
 */
function abrirVisor(port, query = '', { ack = null, retrasoAck = 0, headers = CABECERAS_SSE } = {}) {
  return new Promise((resolve, reject) => {
    const eventos = [];
    const esperando = [];
    let buf = '';
    const req = http.get({ host: '127.0.0.1', port, path: `/api/events${query}`, headers }, (res) => {
      if (res.statusCode !== 200) { reject(new Error(`SSE ${res.statusCode}`)); res.resume(); return; }
      res.setEncoding('utf8');
      const visor = {
        id: null,
        eventos,
        comandos: () => eventos.filter((e) => e.event === 'command'),
        esperar(pred, ms = 3000, desde = 0) {
          const ya = eventos.slice(desde).find(pred);
          if (ya) return Promise.resolve(ya);
          return new Promise((ok, mal) => {
            const w = { pred, ok };
            esperando.push(w);
            setTimeout(() => {
              const k = esperando.indexOf(w);
              if (k >= 0) { esperando.splice(k, 1); mal(new Error('tiempo agotado esperando un evento SSE')); }
            }, ms);
          });
        },
        cerrar() { req.destroy(); },
      };
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const bloque = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let event = 'message';
          let data = '';
          for (const linea of bloque.split('\n')) {
            if (linea.startsWith('event: ')) event = linea.slice(7);
            else if (linea.startsWith('data: ')) data += linea.slice(6);
          }
          if (!data) continue;                       // ": ping"
          const ev = { event, data: JSON.parse(data) };
          eventos.push(ev);
          for (const w of [...esperando]) {
            if (w.pred(ev)) { esperando.splice(esperando.indexOf(w), 1); w.ok(ev); }
          }
          if (ev.event === 'command' && ack) {
            const cuerpo = { id: ev.data.id, viewerId: visor.id, results: ev.data.commands.map((c) => ack(c)) };
            setTimeout(() => { post(port, '/api/ack', cuerpo).catch(() => {}); }, retrasoAck);
          }
        }
      });
      visor.esperar((e) => e.event === 'hello').then((h) => { visor.id = h.data.id; visor.hello = h.data; resolve(visor); }, reject);
    });
    req.on('error', reject);
  });
}

const ackOk = (c) => ({ ok: true, type: c.type });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- puerto
test('resolverPuerto: PORT entero ≥ 0 (acepta 0); si no, 3939', () => {
  assert.equal(resolverPuerto({}), 3939);
  assert.equal(resolverPuerto({ PORT: '0' }), 0);
  assert.equal(resolverPuerto({ PORT: '4000' }), 4000);
  assert.equal(resolverPuerto({ PORT: '' }), 3939);
  assert.equal(resolverPuerto({ PORT: '  ' }), 3939);
  assert.equal(resolverPuerto({ PORT: 'abc' }), 3939);
  assert.equal(resolverPuerto({ PORT: '-1' }), 3939);
  assert.equal(resolverPuerto({ PORT: '3.5' }), 3939);
  assert.equal(resolverPuerto({ PORT: '70000' }), 3939);
});

test('importar server.js no arranca nada y listen() da un puerto real', async () => {
  const { app, port } = await arrancar();
  assert.ok(port > 0);
  const r = await get(port, '/api/help');
  assert.equal(r.status, 200);
  assert.ok(r.json.commands.desktop && r.json.commands.theme);
  await app.close();
});

// ---------------------------------------------------------------- seguridad de los POST
test('POST con Content-Type text/plain → 403 origen (también /api/ack, /api/state y /mcp)', async () => {
  const { app, port } = await arrancar();
  try {
    for (const ruta of ['/api/command', '/api/ack', '/api/state', '/mcp']) {
      const r = await post(port, ruta, JSON.stringify({ type: 'reset' }), { 'Content-Type': 'text/plain' });
      assert.equal(r.status, 403, ruta);
      assert.equal(r.json.code, 'origen', ruta);
    }
    const sinCt = await peticion(port, { method: 'POST', path: '/api/command', body: '{"type":"reset"}', headers: { 'Content-Type': '' } });
    assert.equal(sinCt.status, 403);
  } finally { await app.close(); }
});

test('Origin ajeno → 403; Origin local con el puerto real → permitido; CORS nunca "*"', async () => {
  const { app, port } = await arrancar();
  try {
    for (const origin of ['http://evil.example', `http://127.0.0.1:${port + 1}`, 'null', `https://localhost:${port}`]) {
      const r = await post(port, '/api/command', { type: 'reset' }, { Origin: origin });
      assert.equal(r.status, 403, origin);
      assert.equal(r.json.code, 'origen', origin);
      assert.equal(r.headers['access-control-allow-origin'], undefined, origin);
      const pre = await peticion(port, {
        method: 'OPTIONS', path: '/api/command',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-source' },
      });
      assert.equal(pre.status, 403, `preflight ${origin}`);
    }
    for (const origin of [`http://127.0.0.1:${port}`, `http://localhost:${port}`]) {
      const r = await post(port, '/api/state', { ready: false }, { Origin: origin });
      assert.equal(r.status, 200, origin);
      assert.equal(r.headers['access-control-allow-origin'], origin);
      assert.match(r.headers.vary, /Origin/);
      const pre = await peticion(port, { method: 'OPTIONS', path: '/api/command', headers: { Origin: origin } });
      assert.equal(pre.status, 204);
      assert.equal(pre.headers['access-control-allow-origin'], origin);
      assert.match(pre.headers['access-control-allow-headers'], /Content-Type/);
      assert.match(pre.headers['access-control-allow-headers'], /X-Source/);
    }
    // sin Origin (procesos locales: R.A.M.S., mcp-server.js, curl) → permitido y sin ACAO
    const sinOrigin = await get(port, '/api/state');
    assert.equal(sinOrigin.status, 200);
    assert.equal(sinOrigin.headers['access-control-allow-origin'], undefined);
    assert.match(sinOrigin.headers.vary, /Origin/);
    // un Origin ajeno no puede registrarse como visor
    const sse = await get(port, '/api/events?desktop=1', { Origin: 'http://evil.example' });
    assert.equal(sse.status, 403);
    // Host ajeno (DNS rebinding) → 403
    const host = await get(port, '/api/state', { Host: 'evil.example' });
    assert.equal(host.status, 403);
  } finally { await app.close(); }
});

// ---------------------------------------------------------------- /api/command
test('sin visores → 409 sin_visores', async () => {
  const { app, port } = await arrancar();
  try {
    const r = await post(port, '/api/command', { type: 'speak', text: 'hola' });
    assert.equal(r.status, 409);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.code, 'sin_visores');
    assert.ok(r.json.error);
    const d = await app.dispatch({ type: 'reset' }, 'api');
    assert.equal(d.code, 'sin_visores');
  } finally { await app.close(); }
});

test('desktop/theme sin X-Source: rams → 403 fuente', async () => {
  const { app, port } = await arrancar();
  const visor = await abrirVisor(port, '?obs=1&desktop=1', { ack: ackOk });
  try {
    for (const cmd of [{ type: 'desktop', action: 'wander' }, { type: 'theme', name: 'amadeus' }]) {
      for (const headers of [{}, { 'X-Source': 'api' }, { 'X-Source': 'mcp' }]) {
        const r = await post(port, '/api/command', cmd, headers);
        assert.equal(r.status, 403, `${cmd.type} ${JSON.stringify(headers)}`);
        assert.equal(r.json.code, 'fuente');
      }
    }
    assert.equal(visor.comandos().length, 0);
    // con X-Source: rams pasa (y se confirma)
    const ok = await post(port, '/api/command', { type: 'desktop', action: 'wander' }, { 'X-Source': 'rams' });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
  } finally { visor.cerrar(); await app.close(); }
});

test('mcp con MCP_DESKTOP=1 puede mandar desktop', async () => {
  const { app, port } = await arrancar({ MCP_DESKTOP: '1' });
  const visor = await abrirVisor(port, '?desktop=1', { ack: ackOk });
  try {
    const r = await post(port, '/api/command', { type: 'desktop', action: 'stop' }, { 'X-Source': 'mcp' });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
  } finally { visor.cerrar(); await app.close(); }
});

test('desktop sin ningún visor de escritorio → 409 sin_overlay', async () => {
  const { app, port } = await arrancar();
  const panel = await abrirVisor(port, '', { ack: ackOk });
  try {
    const r = await post(port, '/api/command', { type: 'desktop', action: 'seek_user' }, { 'X-Source': 'rams' });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'sin_overlay');
    assert.ok(r.json.error);
    await dormir(50);
    assert.equal(panel.comandos().length, 0);
  } finally { panel.cerrar(); await app.close(); }
});

test('lote mixto desktop + otro tipo → 400; JSON inválido → 400', async () => {
  const { app, port } = await arrancar();
  const visor = await abrirVisor(port, '?desktop=1', { ack: ackOk });
  try {
    const r = await post(port, '/api/command', [{ type: 'desktop', action: 'stop' }, { type: 'speak', text: 'x' }], { 'X-Source': 'rams' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /mezclarse/);
    const mal = await post(port, '/api/command', '{no es json', { 'Content-Type': 'application/json' });
    assert.equal(mal.status, 400);
    const anidado = await post(port, '/api/command', { type: 'sequence', steps: [{ type: 'desktop', action: 'stop' }] }, { 'X-Source': 'rams' });
    assert.equal(anidado.status, 400);
  } finally { visor.cerrar(); await app.close(); }
});

test('un lote desktop solo llega a los visores ?desktop=1 y el ack sale de ellos', async () => {
  const { app, port } = await arrancar();
  const panel = await abrirVisor(port, '', { ack: ackOk });
  const obs = await abrirVisor(port, '?obs=1', { ack: ackOk });
  const esc = await abrirVisor(port, '?obs=1&desktop=1', { ack: (c) => ({ ok: false, type: c.type, error: 'oculta' }) });
  try {
    assert.equal(esc.hello.desktop, true);
    assert.equal(panel.hello.desktop, false);
    const r = await post(port, '/api/command', { type: 'desktop', action: 'walk_to', x: 0.5 }, { 'X-Source': 'rams' });
    assert.equal(r.status, 200);
    assert.equal(r.json.delivered, 1);
    assert.equal(r.json.ok, false);
    assert.deepEqual(r.json.results, [{ ok: false, type: 'desktop', error: 'oculta' }]);
    assert.equal(esc.comandos().length, 1);
    assert.equal(esc.comandos()[0].data.source, 'rams');
    await dormir(50);
    assert.equal(panel.comandos().length, 0);
    assert.equal(obs.comandos().length, 0);
    // un comando normal llega a todos
    const n = await post(port, '/api/command', { type: 'look', at: 'camera' });
    assert.equal(n.status, 200);
    assert.equal(n.json.delivered, 3);
    await panel.esperar((e) => e.event === 'command' && e.data.commands[0].type === 'look');
    await obs.esperar((e) => e.event === 'command' && e.data.commands[0].type === 'look');
    await esc.esperar((e) => e.event === 'command' && e.data.commands[0].type === 'look');
    // theme (de R.A.M.S.) también va a todos
    const t = await post(port, '/api/command', { type: 'theme', name: 'amadeus' }, { 'X-Source': 'rams' });
    assert.equal(t.json.delivered, 3);
  } finally { panel.cerrar(); obs.cerrar(); esc.cerrar(); await app.close(); }
});

// ---------------------------------------------------------------- /api/state
test('GET /api/state: calculados al final; POST /api/state actualiza el visor y no puede fijarlos', async () => {
  const { app, port } = await arrancar();
  const panel = await abrirVisor(port, '');
  const esc = await abrirVisor(port, '?obs=1&desktop=1');
  try {
    let s = (await get(port, '/api/state')).json;
    assert.equal(s.viewers, 2);
    assert.equal(s.desktopViewers, 0);            // el visor de escritorio arranca oculto
    assert.equal(s.desktopViewersTotal, 1);
    assert.equal(s.viewerSeq, 2);
    assert.deepEqual(Object.keys(s).slice(-4), ['viewers', 'desktopViewers', 'desktopViewersTotal', 'viewerSeq']);

    // el visor de escritorio informa que está visible, e intenta fijar los calculados
    const r = await post(port, '/api/state', {
      ready: true, model: 'Kurisu', current: { theme: 'amadeus' },
      viewers: 99, desktopViewers: 7, desktopViewersTotal: 8, viewerSeq: 1234,
      viewerId: esc.id, viewer: { desktop: true, visible: true, theme: 'amadeus' },
    });
    assert.equal(r.status, 200);
    s = (await get(port, '/api/state')).json;
    assert.equal(s.ready, true);
    assert.equal(s.model, 'Kurisu');
    assert.equal(s.viewers, 2);
    assert.equal(s.desktopViewers, 1);
    assert.equal(s.desktopViewersTotal, 1);
    assert.equal(s.viewerSeq, 2);
    assert.equal('viewerId' in s, false);
    assert.equal('viewer' in s, false);
    assert.deepEqual(Object.keys(s).slice(-4), ['viewers', 'desktopViewers', 'desktopViewersTotal', 'viewerSeq']);

    // el panel (no desktop) visible no cuenta; un viewerId desconocido no cambia nada
    await post(port, '/api/state', { ready: true, viewerId: panel.id, viewer: { desktop: false, visible: true } });
    await post(port, '/api/state', { ready: true, viewerId: 'nadie', viewer: { visible: false } });
    s = (await get(port, '/api/state')).json;
    assert.equal(s.desktopViewers, 1);

    // se oculta → deja de contar en desktopViewers pero sigue en el total
    await post(port, '/api/state', { ready: true, viewerId: esc.id, viewer: { desktop: true, visible: false, theme: 'none' } });
    s = (await get(port, '/api/state')).json;
    assert.equal(s.desktopViewers, 0);
    assert.equal(s.desktopViewersTotal, 1);

    // al cerrarse el visor desaparece; viewerSeq sube con cada conexión (recarga)
    esc.cerrar();
    await dormir(80);
    s = (await get(port, '/api/state')).json;
    assert.equal(s.viewers, 1);
    assert.equal(s.desktopViewersTotal, 0);
    const otra = await abrirVisor(port, '?desktop=1');
    s = (await get(port, '/api/state')).json;
    assert.equal(s.viewerSeq, 3);
    assert.equal(otra.hello.viewerSeq, 3);
    otra.cerrar();
  } finally { panel.cerrar(); await app.close(); }
});

test('GET /api/state publica el estado del panel, no el del overlay (y el del overlay solo si está solo)', async () => {
  const { app, port } = await arrancar();
  const panel = await abrirVisor(port, '');
  const esc = await abrirVisor(port, '?obs=1&desktop=1');
  try {
    const estadoPanel = { ready: true, model: 'Kurisu', mode: 'panel', current: { position: { x: 1.2, z: 0.5 }, camera: 'face', background: 'gradient' } };
    const estadoEsc = { ready: true, model: 'Otro', mode: 'desktop', current: { position: { x: 0, z: 0 }, camera: 'full', background: 'transparent' } };
    await post(port, '/api/state', { ...estadoPanel, viewerId: panel.id, viewer: { desktop: false, visible: true } });
    // el overlay informa después (y más veces): no pisa el estado del panel
    for (let i = 0; i < 3; i++) {
      await post(port, '/api/state', { ...estadoEsc, viewerId: esc.id, viewer: { desktop: true, visible: true, theme: 'amadeus' } });
    }
    let s = (await get(port, '/api/state')).json;
    assert.equal(s.mode, 'panel');
    assert.deepEqual(s.current.position, { x: 1.2, z: 0.5 });
    assert.equal(s.current.camera, 'face');
    assert.equal(s.model, 'Kurisu');
    assert.equal(s.desktopViewers, 1);                   // la visibilidad del overlay sí cuenta
    // un POST sin visor conocido tampoco lo pisa
    await post(port, '/api/state', { ready: false, mode: 'fantasma' });
    s = (await get(port, '/api/state')).json;
    assert.equal(s.mode, 'panel');
    // el más reciente de los no-escritorio manda
    const obs = await abrirVisor(port, '?obs=1');
    await post(port, '/api/state', { ready: true, mode: 'obs', current: { camera: 'bust' }, viewerId: obs.id, viewer: { desktop: false, visible: true } });
    s = (await get(port, '/api/state')).json;
    assert.equal(s.mode, 'obs');
    obs.cerrar();
    await dormir(80);
    s = (await get(port, '/api/state')).json;
    assert.equal(s.mode, 'panel');
    // sin panel ni OBS, el del overlay
    panel.cerrar();
    await dormir(80);
    s = (await get(port, '/api/state')).json;
    assert.equal(s.mode, 'desktop');
    assert.equal(s.viewers, 1);
    // MCP ve lo mismo
    const st = await post(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'avatar_get_state', arguments: {} } });
    assert.deepEqual(JSON.parse(st.json.result.content[0].text), s);
    // sin ningún visor queda el último estado publicado (como antes de guardar el estado por visor)
    esc.cerrar();
    await dormir(80);
    s = (await get(port, '/api/state')).json;
    assert.equal(s.viewers, 0);
    assert.equal(s.mode, 'desktop');
    assert.equal(s.ready, true);
  } finally { panel.cerrar(); esc.cerrar(); await app.close(); }
});

test('ack de un lote difundido: manda el del panel aunque el overlay conteste antes', async () => {
  const { app, port } = await arrancar();
  const panel = await abrirVisor(port, '', { ack: (c) => ({ ok: true, type: c.type, seconds: 0.2 }), retrasoAck: 150 });
  const esc = await abrirVisor(port, '?obs=1&desktop=1', { ack: (c) => ({ ok: true, type: c.type, ignored: ['x', 'z'] }) });
  try {
    for (let i = 0; i < 3; i++) {
      const r = await post(port, '/api/command', { type: 'move', x: 1.2, z: 0.5 });
      assert.equal(r.status, 200);
      assert.equal(r.json.delivered, 2);
      assert.deepEqual(r.json.results, [{ ok: true, type: 'move', seconds: 0.2 }], `ronda ${i}`);
    }
    // un lote desktop solo va al overlay: su ack, sin esperar a nadie
    const t0 = Date.now();
    const d = await post(port, '/api/command', { type: 'desktop', action: 'stop' }, { 'X-Source': 'rams' });
    assert.deepEqual(d.json.results, [{ ok: true, type: 'desktop', ignored: ['x', 'z'] }]);
    assert.ok(Date.now() - t0 < 500);
  } finally { panel.cerrar(); esc.cerrar(); await app.close(); }

  // si el panel no confirma, tras el margen de gracia vale el del overlay (no "sin confirmar")
  const otra = await arrancar();
  const mudo = await abrirVisor(otra.port, '');
  const esc2 = await abrirVisor(otra.port, '?desktop=1', { ack: (c) => ({ ok: true, type: c.type, ignored: true }) });
  try {
    const t0 = Date.now();
    const r = await post(otra.port, '/api/command', { type: 'camera', preset: 'face' });
    const ms = Date.now() - t0;
    assert.equal(r.json.ok, true);
    assert.deepEqual(r.json.results, [{ ok: true, type: 'camera', ignored: true }]);
    assert.ok(ms >= 500 && ms < 2000, `${ms} ms`);
  } finally { mudo.cerrar(); esc2.cerrar(); await otra.app.close(); }
});

test('/api/events: solo un EventSource propio se registra (iframe/audio/video de otra web → 403)', async () => {
  const { app, port } = await arrancar();
  try {
    const rechazos = [
      {},                                                                         // sin Accept
      { Accept: '*/*', 'Sec-Fetch-Dest': 'audio', 'Sec-Fetch-Site': 'cross-site' },
      { Accept: '*/*', 'Sec-Fetch-Dest': 'video', 'Sec-Fetch-Site': 'cross-site' },
      { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Site': 'cross-site' },
      { Accept: 'text/event-stream', 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Site': 'same-origin' },
      { Accept: 'text/event-stream', 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Site': 'cross-site' },   // fetch no-cors
      { Accept: 'text/event-stream', 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Site': 'same-site' },    // otro puerto
    ];
    for (const h of rechazos) {
      const r = await get(port, '/api/events?desktop=1', h);
      assert.equal(r.status, 403, JSON.stringify(h));
      assert.equal(r.json.code, 'origen');
    }
    let s = (await get(port, '/api/state')).json;
    assert.equal(s.viewers, 0);
    assert.equal(s.desktopViewersTotal, 0);
    assert.equal(s.viewerSeq, 0);
    // sin overlay real, un lote desktop sigue siendo 409 sin_overlay (no 200 "no confirmó")
    const d = await post(port, '/api/command', { type: 'desktop', action: 'wander' }, { 'X-Source': 'rams' });
    assert.equal(d.status, 409);
    // un EventSource propio sí (con o sin Fetch Metadata: navegadores antiguos y clientes locales)
    const v1 = await abrirVisor(port, '?desktop=1');
    const v2 = await abrirVisor(port, '', { headers: { Accept: 'text/event-stream' } });
    s = (await get(port, '/api/state')).json;
    assert.equal(s.viewers, 2);
    assert.equal(s.desktopViewersTotal, 1);
    v1.cerrar(); v2.cerrar();
  } finally { await app.close(); }
});

test('hello.defaultModel: último load_model confirmado > VTUBER_AI_MODELO > primer .vrm de models/ > sample', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vtuber-modelos-'));
  const vacio = mkdtempSync(path.join(tmpdir(), 'vtuber-sin-modelos-'));
  try {
    writeFileSync(path.join(dir, 'zeta.vrm'), 'x');
    writeFileSync(path.join(dir, 'Kurisu.vrm'), 'x');
    writeFileSync(path.join(dir, 'notas.txt'), 'x');
    // sin modelos propios → sample
    let a = createServer({ port: 0, host: '127.0.0.1', env: {}, modelsDir: vacio });
    let { port } = await a.listen();
    let v = await abrirVisor(port, '?desktop=1');
    assert.equal(v.hello.defaultModel, 'sample');
    v.cerrar(); await a.close();

    // el primer .vrm de la carpeta (orden alfabético sin mayúsculas)
    a = createServer({ port: 0, host: '127.0.0.1', env: {}, modelsDir: dir });
    ({ port } = await a.listen());
    v = await abrirVisor(port, '?desktop=1');
    assert.equal(v.hello.defaultModel, 'Kurisu.vrm');
    assert.deepEqual((await get(port, '/api/models')).json.map((m) => m.name).sort(), ['Kurisu.vrm', 'zeta.vrm']);
    v.cerrar(); await a.close();

    // VTUBER_AI_MODELO manda sobre la carpeta; un load_model confirmado, sobre todo (también tras recargar)
    a = createServer({ port: 0, host: '127.0.0.1', env: { VTUBER_AI_MODELO: 'zeta.vrm' }, modelsDir: dir });
    ({ port } = await a.listen());
    const panel = await abrirVisor(port, '', { ack: (c) => (c.url === 'roto.vrm' ? { ok: false, type: c.type, error: 'no' } : { ok: true, type: c.type }) });
    assert.equal(panel.hello.defaultModel, 'zeta.vrm');
    let r = await post(port, '/api/command', { type: 'load_model', url: 'otro.vrm' });
    assert.equal(r.json.ok, true);
    // ni un fallo ni una URL blob:/data: cambian el recordado
    await post(port, '/api/command', { type: 'load_model', url: 'roto.vrm' });
    await post(port, '/api/command', { type: 'load_model', url: 'blob:http://127.0.0.1/abc' });
    v = await abrirVisor(port, '?obs=1&desktop=1');
    assert.equal(v.hello.defaultModel, 'otro.vrm');
    v.cerrar();
    r = await post(port, '/api/command', { type: 'load_model', name: 'Kurisu.vrm' });
    assert.equal(r.json.ok, true);
    v = await abrirVisor(port, '?desktop=1');
    assert.equal(v.hello.defaultModel, 'Kurisu.vrm');
    v.cerrar(); panel.cerrar(); await a.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(vacio, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- MCP
async function rpc(port, method, params, id = 1) {
  const r = await post(port, '/mcp', { jsonrpc: '2.0', id, method, params });
  assert.equal(r.status, 200);
  return r.json;
}

test('MCP: avatar_desktop solo con MCP_DESKTOP=1; avatar_command rechaza desktop/theme', async () => {
  const { app, port } = await arrancar({});
  try {
    const lista = await rpc(port, 'tools/list', {});
    const nombres = lista.result.tools.map((t) => t.name);
    assert.ok(nombres.includes('avatar_command'));
    assert.ok(!nombres.includes('avatar_desktop'));
    const cmd = lista.result.tools.find((t) => t.name === 'avatar_command');
    assert.ok(!cmd.inputSchema.properties.commands.items.properties.type.enum.includes('desktop'));

    for (const commands of [[{ type: 'desktop', action: 'stop' }], [{ type: 'theme', name: 'amadeus' }]]) {
      const r = await rpc(port, 'tools/call', { name: 'avatar_command', arguments: { commands } });
      assert.ok(r.error, JSON.stringify(r));
      assert.equal(r.error.code, -32602);
    }
    const seq = await rpc(port, 'tools/call', { name: 'avatar_sequence', arguments: { steps: [{ type: 'theme', name: 'none' }] } });
    assert.equal(seq.error?.code, -32602);
    const nodesk = await rpc(port, 'tools/call', { name: 'avatar_desktop', arguments: { action: 'stop' } });
    assert.equal(nodesk.error?.code, -32602);

    // getState del MCP == GET /api/state
    const st = await rpc(port, 'tools/call', { name: 'avatar_get_state', arguments: {} });
    const estadoMcp = JSON.parse(st.result.content[0].text);
    const estadoHttp = (await get(port, '/api/state')).json;
    assert.deepEqual(estadoMcp, estadoHttp);
  } finally { await app.close(); }

  const con = await arrancar({ MCP_DESKTOP: '1' });
  const panel = await abrirVisor(con.port, '', { ack: ackOk });
  try {
    const lista = await rpc(con.port, 'tools/list', {});
    assert.ok(lista.result.tools.some((t) => t.name === 'avatar_desktop'));
    // pasa la fuente (mcp + MCP_DESKTOP=1) y el servidor contesta sin_overlay: no hay visor de escritorio
    const r = await rpc(con.port, 'tools/call', { name: 'avatar_desktop', arguments: { action: 'wander', seconds: 5 } });
    assert.equal(r.result.isError, true);
    assert.equal(JSON.parse(r.result.content[0].text).code, 'sin_overlay');
    // avatar_command sigue rechazando desktop aunque MCP_DESKTOP=1
    const c = await rpc(con.port, 'tools/call', { name: 'avatar_command', arguments: { commands: [{ type: 'desktop', action: 'stop' }] } });
    assert.equal(c.error?.code, -32602);
  } finally { panel.cerrar(); await con.app.close(); }
});

// ---------------------------------------------------------------- cierre
test('close() termina aunque haya visores SSE abiertos', async () => {
  const { app, port } = await arrancar();
  const v1 = await abrirVisor(port, '');
  const v2 = await abrirVisor(port, '?desktop=1');
  const t0 = Date.now();
  await app.close();
  assert.ok(Date.now() - t0 < 2000);
  v1.cerrar();
  v2.cerrar();
});

// ---------------------------------------------------------------- vendor e imports
const RE_IMPORT = /(?:^|[;\n}])\s*(?:import|export)\s*(?:[\w*{}\s,$]*?\s*from\s*)?["']([^"']+)["']/g;

function importsEstaticos(src) {
  return [...src.matchAll(RE_IMPORT)].map((m) => m[1]);
}

function importmap() {
  const html = readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  assert.ok(m, 'index.html sin importmap');
  return JSON.parse(m[1]).imports;
}

/** Resuelve un especificador como el navegador (importmap + rutas relativas) a una ruta de public/. */
function resolver(spec, desdeUrl, mapa) {
  let url;
  if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')) {
    url = new URL(spec, `http://visor${desdeUrl}`).pathname;
  } else if (mapa[spec]) {
    url = mapa[spec];
  } else {
    const pref = Object.keys(mapa).filter((k) => k.endsWith('/') && spec.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    assert.ok(pref, `sin entrada en el importmap para "${spec}" (desde ${desdeUrl})`);
    url = mapa[pref] + spec.slice(pref.length);
  }
  return url;
}

test('el importmap apunta a /vendor y todo import de app.js (y su cierre) resuelve en public/vendor', async () => {
  const mapa = importmap();
  for (const [k, v] of Object.entries(mapa)) {
    assert.ok(v.startsWith('/vendor/'), `${k} → ${v} no es local`);
    assert.ok(!/^https?:/.test(v));
  }
  const app = readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
  const cabecera = app.split('\n').filter((l) => !/^(const|let|function|class|async) /.test(l)).join('\n').split('\n// =====')[0];
  const specs = importsEstaticos(cabecera);
  assert.ok(specs.includes('three'));
  assert.ok(specs.includes('@pixiv/three-vrm'));
  const addons = specs.filter((s) => s.startsWith('three/addons/'));
  assert.ok(addons.length >= 2, 'app.js debería importar GLTFLoader y OrbitControls');
  for (const s of addons) {
    const url = resolver(s, '/app.js', mapa);
    assert.ok(url.startsWith('/vendor/'), `${s} → ${url}`);
    assert.ok(existsSync(path.join(PUBLIC_DIR, url)), `${s} → ${url} no existe en public/`);
  }
  // cierre transitivo desde los imports de terceros de app.js
  const pendientes = specs.filter((s) => s !== '/protocol.js').map((s) => resolver(s, '/app.js', mapa));
  const vistos = new Set();
  while (pendientes.length) {
    const url = pendientes.pop();
    if (vistos.has(url)) continue;
    vistos.add(url);
    const archivo = path.join(PUBLIC_DIR, url);
    assert.ok(url.startsWith('/vendor/') && existsSync(archivo), `${url} no existe en public/vendor`);
    for (const s of importsEstaticos(readFileSync(archivo, 'utf8'))) pendientes.push(resolver(s, url, mapa));
  }
  for (const necesario of ['/vendor/three/build/three.module.js', '/vendor/three/build/three.core.js',
    '/vendor/three/examples/jsm/utils/BufferGeometryUtils.js', '/vendor/three-vrm/lib/three-vrm.module.min.js']) {
    assert.ok(vistos.has(necesario), `${necesario} no está en el cierre`);
  }
  assert.ok(existsSync(path.join(PUBLIC_DIR, 'vendor', 'VENDOR.md')));
  // y el servidor los sirve como JavaScript
  const { app: srv, port } = await arrancar();
  try {
    const r = await get(port, '/vendor/three/build/three.module.js');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/javascript/);
    const idx = await get(port, '/');
    assert.equal(idx.status, 200);
    assert.ok(!idx.text.includes('cdn.jsdelivr.net/npm/three'));
  } finally { await srv.close(); }
});

// ---------------------------------------------------------------- sintaxis
function archivosJs(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (['node_modules', '.git', 'vendor', '.claude'].includes(n)) continue;
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) archivosJs(p, out);
    else if (/\.(m?js)$/.test(n)) out.push(p);
  }
  return out;
}

test('node --check de todos los .js del proyecto (sin vendor)', () => {
  const lista = archivosJs(ROOT);
  for (const f of ['server.js', 'mcp-server.js', 'lib/dispatch.js', 'lib/protocol.js', 'lib/mcp.js', 'public/app.js']) {
    assert.ok(lista.includes(path.join(ROOT, f)), f);
  }
  for (const f of lista) execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
});

// ---------------------------------------------------------------- subida de .vrm desde el panel
function postBinario(port, ruta, buf, headers = {}) {
  return new Promise((resolve, reject) => {
    const h = { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length, ...headers };
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: ruta, headers: h }, (res) => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { s += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(s); } catch {} resolve({ status: res.statusCode, json }); });
    });
    req.on('error', reject);
    req.end(buf);
  });
}

/** glTF binario mínimo válido en cabecera ("glTF", v2, longitud total coherente). */
function glbFalso(extra = 32) {
  const b = Buffer.alloc(12 + extra);
  b.write('glTF', 0, 'latin1'); b.writeUInt32LE(2, 4); b.writeUInt32LE(b.length, 8);
  return b;
}

async function arrancarConModelos() {
  const modelsDir = mkdtempSync(path.join(tmpdir(), 'vtai-models-'));
  const app = createServer({ port: 0, host: '127.0.0.1', env: {}, modelsDir });
  const { port } = await app.listen();
  return { app, port, modelsDir };
}

test('POST /api/models guarda un .vrm válido y aparece en la lista y como modelo inicial', async () => {
  const { app, port, modelsDir } = await arrancarConModelos();
  try {
    const r = await postBinario(port, '/api/models', glbFalso(), { 'X-Filename': encodeURIComponent('Kurisu Makise.vrm') });
    assert.equal(r.status, 200);
    assert.equal(r.json.name, 'Kurisu Makise.vrm');
    assert.ok(existsSync(path.join(modelsDir, 'Kurisu Makise.vrm')));
    assert.deepEqual(readdirSync(modelsDir).filter((f) => f.endsWith('.parcial')), []);
    const lista = await get(port, '/api/models');
    assert.deepEqual(lista.json.map((m) => m.name), ['Kurisu Makise.vrm']);
    const v = await abrirVisor(port);
    assert.equal(v.hello.defaultModel, 'Kurisu Makise.vrm');
    v.cerrar();
  } finally { await app.close(); rmSync(modelsDir, { recursive: true, force: true }); }
});

test('POST /api/models rechaza nombre, contenido, tipo y origen inválidos', async () => {
  const { app, port, modelsDir } = await arrancarConModelos();
  try {
    assert.equal((await postBinario(port, '/api/models', glbFalso(), { 'X-Filename': '..%2F..%2Fmalo.vrm' })).json.name, 'malo.vrm');
    assert.equal((await postBinario(port, '/api/models', glbFalso(), { 'X-Filename': 'modelo.exe' })).status, 400);
    assert.equal((await postBinario(port, '/api/models', glbFalso(), {})).status, 400);
    assert.equal((await postBinario(port, '/api/models', Buffer.from('no es un glb, solo texto plano'), { 'X-Filename': 'x.vrm' })).status, 400);
    const malLargo = glbFalso(); malLargo.writeUInt32LE(9999, 8);
    assert.equal((await postBinario(port, '/api/models', malLargo, { 'X-Filename': 'x.vrm' })).status, 400);
    assert.equal((await postBinario(port, '/api/models', glbFalso(), { 'X-Filename': 'x.vrm', 'Content-Type': 'text/plain' })).status, 403);
    assert.equal((await postBinario(port, '/api/models', glbFalso(), { 'X-Filename': 'x.vrm', Origin: 'https://evil.example' })).status, 403);
    // nada escapó de la carpeta de modelos
    assert.deepEqual(readdirSync(modelsDir).sort(), ['malo.vrm']);
  } finally { await app.close(); rmSync(modelsDir, { recursive: true, force: true }); }
});

test('el "hello" trae la huella del código del visor (los visores se recargan si cambia)', async () => {
  const { app, port } = await arrancar();
  try {
    const v = await abrirVisor(port);
    assert.match(v.hello.build, /^[0-9a-f]{16}$/);
    const v2 = await abrirVisor(port);
    assert.equal(v2.hello.build, v.hello.build);
    v.cerrar(); v2.cerrar();
  } finally { await app.close(); }
});
