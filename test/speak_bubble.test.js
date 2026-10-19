// Pruebas del campo "bubble" de speak (globo de texto sobre el avatar). Sin navegador ni red externa:
//   node --test test/speak_bubble.test.js
// Los servidores de prueba escuchan en 127.0.0.1:0 (nunca el :3939 en vivo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS, HELP, SPEAK_BUBBLE_DEFAULT, speakBubble } from '../lib/protocol.js';
import { TOOLS, handleRpc } from '../lib/mcp.js';
import { normalizeCommands } from '../lib/dispatch.js';
import { createServer } from '../server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- protocolo
test('speakBubble: por defecto true; booleanos, 1/0 y "true"/"false"; lo demás es inválido (null)', () => {
  assert.equal(SPEAK_BUBBLE_DEFAULT, true);
  assert.equal(speakBubble(undefined), true);
  assert.equal(speakBubble(null), true);
  assert.equal(speakBubble(true), true);
  assert.equal(speakBubble(false), false);
  assert.equal(speakBubble(1), true);
  assert.equal(speakBubble(0), false);
  for (const v of ['true', 'TRUE', ' True ', '1']) assert.equal(speakBubble(v), true, v);
  for (const v of ['false', 'False', ' 0 ', '0']) assert.equal(speakBubble(v), false, v);
  for (const v of ['', 'si', 'no', 'off', 2, -1, 0.5, NaN, {}, [], [false]]) assert.equal(speakBubble(v), null, String(v));
});

test('protocol: speak documenta bubble (también en /api/help)', () => {
  assert.match(COMMANDS.speak.fields, /bubble bool \(por defecto true/);
  assert.match(COMMANDS.speak.desc, /bubble:false/);
  assert.equal(HELP.commands.speak, COMMANDS.speak);
  // el ejemplo sigue siendo el de siempre: sin bubble = con globo
  assert.ok(!('bubble' in COMMANDS.speak.example));
});

test('dispatch: normalizeCommands conserva bubble (suelto y dentro de un sequence)', () => {
  const suelto = { type: 'speak', text: 'hola', bubble: false };
  assert.deepEqual(normalizeCommands(suelto), [suelto]);
  const seq = { type: 'sequence', steps: [{ type: 'speak', text: 'a', bubble: false }, { type: 'speak', text: 'b' }] };
  assert.deepEqual(normalizeCommands(seq), [seq]);
});

// ---------------------------------------------------------------- MCP
test('MCP: avatar_speak declara bubble booleano y lo pasa tal cual (sin él, el visor usa el globo)', async () => {
  const tool = TOOLS.find((t) => t.name === 'avatar_speak');
  assert.equal(tool.inputSchema.properties.bubble.type, 'boolean');
  assert.match(tool.inputSchema.properties.bubble.description, /por defecto true/);
  assert.deepEqual(tool.inputSchema.required, ['text']);
  assert.match(tool.description, /bubble:false/);

  const enviados = [];
  const ctx = { env: {}, dispatch: async (c) => { enviados.push(c); return { ok: true }; }, getState: async () => ({}) };
  const llamar = (args) => handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'avatar_speak', arguments: args } }, ctx);
  const r1 = await llamar({ text: 'hola', bubble: false });
  const r2 = await llamar({ text: 'hola' });
  assert.equal(r1.result.isError, false);
  assert.equal(r2.result.isError, false);
  assert.deepEqual(enviados, [{ type: 'speak', text: 'hola', bubble: false }, { type: 'speak', text: 'hola' }]);

  const lista = await handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, ctx);
  const speak = lista.result.tools.find((t) => t.name === 'avatar_speak');
  assert.equal(speak.inputSchema.properties.bubble.type, 'boolean');
});

// ---------------------------------------------------------------- visor (public/app.js)
// app.js necesita navegador (three, WebGL, DOM), así que no se importa: se extraen de su código fuente las
// funciones reales del globo y del habla (showBubble, hideBubble, stopSpeech, speak, el estado `speech` y
// el botón «Decir» del panel) y se ejecutan con dobles: un globo falso y un reloj falso (setTimeout
// controlado por la prueba). Se comprueba el comportamiento, no la forma del código.
const APP = readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

/**
 * Declaración de nivel superior de app.js que empieza por `inicio`: la línea sola si cabe en una
 * (`const speech = {…};`) o, si abre un bloque, hasta su `}` / `};` de la columna 0.
 */
function extraer(inicio) {
  const i = APP.indexOf(inicio);
  assert.ok(i >= 0, `app.js ya no contiene «${inicio}»`);
  const primera = APP.slice(i, APP.indexOf('\n', i)).trimEnd();
  if (!primera.endsWith('{')) return primera;
  const cierre = /\n\};?[ \t]*(?=\n|$)/g;
  cierre.lastIndex = i;
  const m = cierre.exec(APP);
  assert.ok(m, `sin cierre en la columna 0 tras «${inicio}»`);
  return APP.slice(i, m.index + m[0].length);
}

const CODIGO_VISOR = [
  extraer('const speech = {'),
  extraer('function showBubble('),
  extraer('function hideBubble('),
  extraer('function stopSpeech('),
  extraer('function speak('),
].join('\n');

/** Reloj falso: setTimeout/clearTimeout que solo avanzan con `avanzar(ms)` (y vacían las promesas). */
function relojFalso() {
  let t = 0;
  let sig = 1;
  const pendientes = new Map();
  const vaciar = () => new Promise((r) => setImmediate(r));
  return {
    ms: () => t,
    setTimeout: (fn, ms = 0) => { const id = sig++; pendientes.set(id, { fn, en: t + Math.max(0, Number(ms) || 0) }); return id; },
    clearTimeout: (id) => { pendientes.delete(id); },
    async avanzar(ms) {
      const meta = t + ms;
      for (;;) {
        await vaciar();
        let prox = null;
        for (const [id, p] of pendientes) {
          if (p.en <= meta && (!prox || p.en < prox.p.en)) prox = { id, p };
        }
        if (!prox) break;
        pendientes.delete(prox.id);
        t = prox.p.en;
        prox.p.fn();
      }
      t = meta;
      await vaciar();
    },
  };
}

/** Visor de prueba con el código real de app.js; `conTts` simula el panel con voz del navegador. */
function crearVisor({ conTts = false } = {}) {
  const reloj = relojFalso();
  const clases = new Set();
  const globo = {
    textContent: '',
    hidden: true,
    classList: { add: (c) => clases.add(c), remove: (c) => clases.delete(c), contains: (c) => clases.has(c) },
  };
  const fabrica = new Function('speakBubble', 'setTimeout', 'clearTimeout', 'reloj', 'globo', 'conTts', `
    'use strict';
    const speechSynthesis = { cancel() {} };
    const window = conTts ? { speechSynthesis } : {};
    class CommandError extends Error {}
    const fail = (msg) => { throw new CommandError(msg); };
    const now = () => reloj.ms() / 1000;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
    const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    const TTS_PERMITIDO = conTts;
    const tts = { enabled: true, pitch: 1.1 };
    const GESTURE_IMPL = {}; const GESTURES = {}; const vrm = null; const availableExpressions = [];
    const applyExpression = () => {}; const startGesture = () => {}; const clearEmotions = () => {};
    const splitChunks = (t) => [t];
    // voz del navegador simulada: dice el fragmento a 14 caracteres por segundo
    const speakChunk = (chunk) => wait((chunk.length / 14) * 1000).then(() => 'ok');
    const bubble = globo;
    let bubbleTimer = 0;
    ${CODIGO_VISOR}
    return { speak, stopSpeech, speech };
  `);
  const v = fabrica(speakBubble, reloj.setTimeout, reloj.clearTimeout, reloj, globo, conTts);
  const visible = () => !globo.hidden;
  const desvaneciendo = () => clases.has('fade');
  /** Avanza el reloj en pasos de 50 ms hasta que se cumpla `cond` (o `max` ms); devuelve el instante. */
  async function hasta(cond, max = 10000) {
    for (let n = 0; n < max / 50 && !cond(); n++) await reloj.avanzar(50);
    assert.ok(cond(), 'la condición no se cumplió a tiempo');
    return reloj.ms();
  }
  /** Avanza el reloj hasta que termine el speak `r` (su promesa `done`). */
  async function esperar(r) {
    let fin = false;
    r.done.then(() => { fin = true; });
    return hasta(() => fin);
  }
  return { ...v, reloj, globo, visible, desvaneciendo, hasta, esperar };
}

test('app.js importa speakBubble de /protocol.js', () => {
  assert.match(APP, /import\s*\{[^}]*\bspeakBubble\b[^}]*\}\s*from\s*'\/protocol\.js'/);
});

test('visor A: sin bubble (por defecto) muestra el globo y lo esconde al terminar de hablar', async () => {
  const v = crearVisor();
  const r = v.speak({ type: 'speak', text: 'Hola' });
  assert.equal(r.result.bubble, true);
  assert.equal(v.visible(), true);
  assert.equal(v.globo.textContent, 'Hola');
  assert.equal(v.desvaneciendo(), false);
  await v.hasta(() => !v.speech.active);
  assert.equal(v.visible(), true, 'al acabar de hablar el globo sigue un momento');
  await v.hasta(() => !v.visible());
});

test('visor B: bubble:false (y 0 o "false") habla sin globo de principio a fin', async () => {
  for (const bubble of [false, 0, 'false']) {
    const v = crearVisor();
    const r = v.speak({ type: 'speak', text: 'Hmph. No lo digas tan alto.', bubble });
    assert.equal(r.result.bubble, false, String(bubble));
    assert.equal(v.speech.active, true);
    assert.equal(v.visible(), false);
    assert.equal(v.globo.textContent, '');
    await v.esperar(r);
    await v.reloj.avanzar(5000);
    assert.equal(v.visible(), false);
    assert.equal(v.globo.textContent, '');
  }
});

test('visor C: un speak con globo cortado por uno sin globo esconde su propio globo y no muestra el nuevo', async () => {
  const v = crearVisor();
  v.speak({ type: 'speak', text: 'Uno bastante largo. '.repeat(5) });
  await v.reloj.avanzar(500);
  const r2 = v.speak({ type: 'speak', text: 'Dos', bubble: false });
  assert.equal(r2.result.bubble, false);
  assert.match(v.globo.textContent, /^Uno/, 'el texto nuevo no entra en el globo');
  const oculto = await v.hasta(() => !v.visible());
  assert.ok(oculto - 500 < 1200, `se esconde enseguida al cortarse (${oculto - 500} ms), no al ritmo normal`);
  assert.equal(v.speech.active, true, 'el habla nueva sigue');
  await v.esperar(r2);
  await v.reloj.avanzar(5000);
  assert.equal(v.visible(), false);
  assert.match(v.globo.textContent, /^Uno/);
});

/** Instante en que se oculta el globo de un speak 'Hola' que acaba solo (referencia para D y G). */
async function ocultoSinInterferencias() {
  const v = crearVisor();
  await v.esperar(v.speak({ type: 'speak', text: 'Hola' }));
  return v.hasta(() => !v.visible());
}

test('visor D: speaks sin globo durante la espera del desvanecimiento no lo reinician ni lo esconden antes', async () => {
  const referencia = await ocultoSinInterferencias();
  const v = crearVisor();
  await v.esperar(v.speak({ type: 'speak', text: 'Hola' }));
  assert.equal(v.visible(), true);
  assert.equal(v.desvaneciendo(), false);
  // uno sin globo empieza y otro sin globo, corto, lo corta (stopSpeech de un habla que no mostró
  // globo) y termina antes de que el globo se oculte (el final de un habla sin globo tampoco lo toca)
  v.speak({ type: 'speak', text: 'Otro texto bastante largo para durar un buen rato', bubble: false });
  await v.reloj.avanzar(100);
  let finCorto = null;
  v.speak({ type: 'speak', text: 'Sí.', bubble: false }).done.then(() => { finCorto = v.reloj.ms(); });
  assert.equal(v.globo.textContent, 'Hola');
  const oculto = await v.hasta(() => !v.visible());
  assert.equal(oculto, referencia, 'el globo de "Hola" se oculta en el mismo instante que sin interferencias');
  assert.ok(finCorto !== null && finCorto < oculto, 'el speak corto terminó mientras el globo seguía');
  assert.equal(v.globo.textContent, 'Hola');
});

test('visor G: un speak sin globo mientras el globo ya se desvanece no lo devuelve ni lo reinicia', async () => {
  const referencia = await ocultoSinInterferencias();
  const v = crearVisor();
  await v.esperar(v.speak({ type: 'speak', text: 'Hola' }));
  await v.hasta(() => v.desvaneciendo());
  assert.equal(v.visible(), true);
  v.speak({ type: 'speak', text: 'Nuevo', bubble: false });
  assert.equal(v.desvaneciendo(), true, 'sigue desvaneciéndose');
  assert.equal(v.globo.textContent, 'Hola');
  const oculto = await v.hasta(() => !v.visible());
  assert.equal(oculto, referencia);
  await v.reloj.avanzar(5000);
  assert.equal(v.visible(), false);
});

test('visor E: tras un speak sin globo, uno con globo lo muestra (también si otro globo se desvanecía)', async () => {
  const v = crearVisor();
  v.speak({ type: 'speak', text: 'Uno', bubble: false });
  const r = v.speak({ type: 'speak', text: 'Dos' });
  assert.equal(r.result.bubble, true);
  assert.equal(v.visible(), true);
  assert.equal(v.globo.textContent, 'Dos');
  await v.esperar(r);
  await v.hasta(() => !v.visible());

  // un globo que se está desvaneciendo vuelve, sin "fade", con el texto del speak nuevo que lo pide
  await v.esperar(v.speak({ type: 'speak', text: 'Tres' }));
  await v.hasta(() => v.desvaneciendo());
  v.speak({ type: 'speak', text: 'Cuatro', bubble: true });
  assert.equal(v.visible(), true);
  assert.equal(v.desvaneciendo(), false);
  assert.equal(v.globo.textContent, 'Cuatro');
});

test('visor F: un bubble inválido es un error y no corta el habla en curso ni su globo', async () => {
  const v = crearVisor();
  v.speak({ type: 'speak', text: 'Uno bastante largo. '.repeat(5) });
  const token = v.speech.token;
  for (const bubble of ['si', 2, {}]) {
    assert.throws(() => v.speak({ type: 'speak', text: 'x', bubble }), { message: '"bubble" debe ser true o false.' });
  }
  assert.equal(v.speech.token, token, 'el habla en curso no se cortó');
  assert.equal(v.speech.active, true);
  assert.equal(v.visible(), true);
  assert.match(v.globo.textContent, /^Uno/);
  await v.reloj.avanzar(1000);
  assert.equal(v.visible(), true, 'su globo no se esconde por el error');
});

test('visor con voz del navegador (panel): bubble:false sin globo; con globo, se esconde al acabar la voz', async () => {
  const v = crearVisor({ conTts: true });
  const r1 = v.speak({ type: 'speak', text: 'Sin globo, pero con voz.', bubble: false });
  assert.equal(r1.result.voice, 'tts');
  assert.equal(v.visible(), false);
  await v.esperar(r1);
  assert.equal(v.visible(), false);

  const r2 = v.speak({ type: 'speak', text: 'Con globo y con voz.' });
  assert.equal(r2.result.voice, 'tts');
  assert.equal(v.visible(), true);
  await v.hasta(() => !v.speech.active);
  await v.hasta(() => !v.visible());
});

test('visor: el botón «Decir» del panel no fija bubble, así que habla con globo', async () => {
  const valores = { '#say-text': 'Hola desde el panel', '#say-emotion': '', '#say-gesture': '' };
  const boton = {};
  const enviados = [];
  const $ = (s) => (s === '#say-btn' ? boton : { value: valores[s] ?? '' });
  new Function('$', 'runLocal', `'use strict';\n${extraer("$('#say-btn').onclick")}`)($, (c) => enviados.push(c));
  assert.equal(typeof boton.onclick, 'function');
  boton.onclick();
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].type, 'speak');
  assert.equal(enviados[0].text, 'Hola desde el panel');
  assert.ok(!('bubble' in enviados[0]), 'sin bubble: el visor usa el valor por defecto');
  const v = crearVisor();
  assert.equal(v.speak(enviados[0]).result.bubble, true);
  assert.equal(v.visible(), true);
});

// ---------------------------------------------------------------- servidor (extremo a extremo)
const CABECERAS_SSE = { Accept: 'text/event-stream', 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors' };

function post(port, ruta, cuerpo, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(cuerpo);
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: ruta,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
    }, (res) => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { s += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(s); } catch {} resolve({ status: res.statusCode, json }); });
    });
    req.on('error', reject);
    req.end(data);
  });
}

/** Visor SSE mínimo: guarda los comandos y los confirma (ack) con ok:true y el bubble que recibiría app.js. */
function abrirVisor(port) {
  return new Promise((resolve, reject) => {
    const comandos = [];
    let buf = '';
    let id = null;
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: CABECERAS_SSE }, (res) => {
      if (res.statusCode !== 200) { reject(new Error(`SSE ${res.statusCode}`)); res.resume(); return; }
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const bloque = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let evento = 'message';
          let data = '';
          for (const linea of bloque.split('\n')) {
            if (linea.startsWith('event: ')) evento = linea.slice(7);
            else if (linea.startsWith('data: ')) data += linea.slice(6);
          }
          if (!data) continue;
          const d = JSON.parse(data);
          if (evento === 'hello') { id = d.id; resolve({ comandos, cerrar: () => req.destroy() }); continue; }
          if (evento !== 'command') continue;
          comandos.push(...d.commands);
          const results = d.commands.map((c) => ({ ok: true, type: c.type, ...(c.type === 'speak' ? { bubble: speakBubble(c.bubble) } : {}) }));
          post(port, '/api/ack', { id: d.id, viewerId: id, results }).catch(() => {});
        }
      });
    });
    req.on('error', reject);
  });
}

test('servidor: bubble llega intacto al visor por /api/command (R.A.M.S.) y por /mcp', async () => {
  const app = createServer({ port: 0, host: '127.0.0.1', env: {} });
  const { port } = await app.listen();
  assert.notEqual(port, 3939);
  let visor;
  try {
    visor = await abrirVisor(port);
    const seq = { type: 'sequence', steps: [{ type: 'speak', text: 'Hmph.', bubble: false }] };
    const r = await post(port, '/api/command', seq, { 'X-Source': 'rams' });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    const m = await post(port, '/mcp', {
      jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'avatar_speak', arguments: { text: 'Hola', bubble: false } },
    });
    assert.equal(m.status, 200);
    assert.equal(m.json.result.isError, false);
    assert.deepEqual(JSON.parse(m.json.result.content[0].text).results, [{ ok: true, type: 'speak', bubble: false }]);
    const sinCampo = await post(port, '/api/command', { type: 'speak', text: 'Hola' });
    assert.deepEqual(sinCampo.json.results, [{ ok: true, type: 'speak', bubble: true }]);
    assert.deepEqual(visor.comandos, [seq, { type: 'speak', text: 'Hola', bubble: false }, { type: 'speak', text: 'Hola' }]);
  } finally {
    visor?.cerrar();
    await app.close();
  }
});
