// Pruebas de las reglas puras de despacho (lib/dispatch.js). Sin red: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCommands, targetsFor, desktopCount, desktopTotal, fuentePermitida, loteRestringido, MAX_COMMANDS,
} from '../lib/dispatch.js';
import { COMMAND_TYPES, COMMANDS, DESKTOP_ACTIONS } from '../lib/protocol.js';

const panel = { id: 'p', desktop: false, visible: true };
const obs = { id: 'o', obs: true, desktop: false, visible: true };
const escVisible = { id: 'd1', desktop: true, visible: true };
const escOculto = { id: 'd2', desktop: true, visible: false };

test('normalizeCommands acepta comando suelto, lista y {commands}', () => {
  assert.deepEqual(normalizeCommands({ type: 'speak', text: 'hola' }), [{ type: 'speak', text: 'hola' }]);
  assert.equal(normalizeCommands([{ type: 'reset' }, { type: 'state' }]).length, 2);
  assert.equal(normalizeCommands({ commands: [{ type: 'reset' }] }).length, 1);
});

test('normalizeCommands acepta desktop y theme', () => {
  assert.ok(COMMAND_TYPES.includes('desktop') && COMMAND_TYPES.includes('theme'));
  assert.deepEqual(normalizeCommands({ type: 'desktop', action: 'walk_to', x: 0.75, speed: 1 })[0].action, 'walk_to');
  for (const action of DESKTOP_ACTIONS) {
    const c = action === 'walk_to' ? { type: 'desktop', action, x: 0.5 } : { type: 'desktop', action };
    assert.equal(normalizeCommands(c).length, 1, action);
  }
  assert.equal(normalizeCommands({ type: 'desktop', action: 'walk_to', x: 900, unit: 'px' }).length, 1);
  assert.equal(normalizeCommands({ type: 'desktop', action: 'peek', edge: 'left' }).length, 1);
  assert.equal(normalizeCommands({ type: 'theme', name: 'amadeus', rim: true, scanlines: 0.07 }).length, 1);
  assert.equal(normalizeCommands({ type: 'theme', name: 'none' }).length, 1);
  // los ejemplos de la documentación son válidos
  assert.equal(normalizeCommands(COMMANDS.desktop.example).length, 1);
  assert.equal(normalizeCommands(COMMANDS.theme.example).length, 1);
});

test('normalizeCommands rechaza lo inválido', () => {
  assert.throws(() => normalizeCommands([]), /ningún comando/);
  assert.throws(() => normalizeCommands(null), /objeto con "type"/);
  assert.throws(() => normalizeCommands({ type: 'volar' }), /Tipo desconocido/);
  assert.throws(() => normalizeCommands({ type: 'desktop', action: 'show' }), /acción desconocida/);
  assert.throws(() => normalizeCommands({ type: 'desktop', action: 'hide' }), /acción desconocida/);
  assert.throws(() => normalizeCommands({ type: 'desktop', action: 'enter' }), /acción desconocida/);
  assert.throws(() => normalizeCommands({ type: 'desktop', action: 'leave' }), /acción desconocida/);
  assert.throws(() => normalizeCommands({ type: 'desktop', action: 'walk_to' }), /requiere "x"/);
  assert.throws(() => normalizeCommands({ type: 'desktop', action: 'peek', edge: 'top' }), /edge/);
  assert.throws(() => normalizeCommands({ type: 'desktop', action: 'wander', seconds: '9' }), /número/);
  assert.throws(() => normalizeCommands({ type: 'theme', name: 'okabe' }), /nombre desconocido/);
  assert.throws(() => normalizeCommands({ type: 'theme', name: 'amadeus', rim: 'sí' }), /booleano/);
  const muchos = Array.from({ length: MAX_COMMANDS + 1 }, () => ({ type: 'state' }));
  assert.throws(() => normalizeCommands(muchos), /Demasiados/);
});

test('desktop y theme no pueden ir dentro de un sequence (a ninguna profundidad)', () => {
  assert.throws(() => normalizeCommands({ type: 'sequence', steps: [{ type: 'desktop', action: 'stop' }] }), /sequence/);
  assert.throws(() => normalizeCommands({
    type: 'sequence', steps: [{ type: 'wait', seconds: 1 }, { type: 'sequence', steps: [{ type: 'theme', name: 'none' }] }],
  }), /sequence/);
  // un sequence normal sigue valiendo (los pasos raros los valida el visor)
  assert.equal(normalizeCommands({ type: 'sequence', steps: [{ type: 'speak', text: 'a' }, { type: 'wait' }] }).length, 1);
});

test('targetsFor: lote desktop solo a visores de escritorio; lote normal a todos', () => {
  const viewers = new Set([panel, obs, escVisible, escOculto]);
  const solo = targetsFor(viewers, [{ type: 'desktop', action: 'wander' }]);
  assert.deepEqual(solo.map((v) => v.id).sort(), ['d1', 'd2']);
  assert.equal(targetsFor(viewers, [{ type: 'speak', text: 'x' }]).length, 4);
  assert.equal(targetsFor(viewers, [{ type: 'theme', name: 'amadeus' }]).length, 4);
  assert.deepEqual(targetsFor(new Set([panel]), [{ type: 'desktop', action: 'stop' }]), []);
  assert.deepEqual(targetsFor([], [{ type: 'reset' }]), []);
});

test('targetsFor: un lote que mezcla desktop con otros tipos lanza Error', () => {
  const viewers = [panel, escVisible];
  assert.throws(() => targetsFor(viewers, [{ type: 'desktop', action: 'stop' }, { type: 'speak', text: 'x' }]), /mezclarse/);
  assert.throws(() => targetsFor([], [{ type: 'look', at: 'mouse' }, { type: 'desktop', action: 'stop' }]), /mezclarse/);
  // varios desktop juntos sí
  assert.equal(targetsFor(viewers, [{ type: 'desktop', action: 'stop' }, { type: 'desktop', action: 'wander' }]).length, 1);
});

test('desktopCount solo cuenta escritorio visible; desktopTotal cuenta también los ocultos', () => {
  const viewers = new Set([panel, obs, escVisible, escOculto]);
  assert.equal(desktopCount(viewers), 1);
  assert.equal(desktopTotal(viewers), 2);
  assert.equal(desktopCount([escOculto]), 0);
  assert.equal(desktopTotal([escOculto]), 1);
  assert.equal(desktopCount([panel, obs]), 0);
  assert.equal(desktopTotal([]), 0);
  assert.equal(desktopCount(undefined), 0);
});

test('fuentePermitida: desktop/theme solo desde rams, o mcp con MCP_DESKTOP=1', () => {
  const d = [{ type: 'desktop', action: 'stop' }];
  const t = [{ type: 'theme', name: 'amadeus' }];
  const normal = [{ type: 'speak', text: 'hola' }];
  assert.equal(fuentePermitida(d, 'rams', {}), true);
  assert.equal(fuentePermitida(t, 'rams', {}), true);
  assert.equal(fuentePermitida(d, 'api', {}), false);
  assert.equal(fuentePermitida(t, 'api', {}), false);
  assert.equal(fuentePermitida(d, 'mcp', {}), false);
  assert.equal(fuentePermitida(d, 'mcp', { MCP_DESKTOP: '0' }), false);
  assert.equal(fuentePermitida(d, 'mcp', { MCP_DESKTOP: '1' }), true);
  assert.equal(fuentePermitida(t, 'mcp', { MCP_DESKTOP: '1' }), true);
  assert.equal(fuentePermitida(d, 'otra', { MCP_DESKTOP: '1' }), false);
  assert.equal(fuentePermitida(d, 'RAMS', {}), false);          // exacto (el servidor ya normaliza)
  assert.equal(fuentePermitida(normal, 'api', {}), true);
  assert.equal(fuentePermitida(normal, 'cualquiera'), true);
  // anidado en un sequence también cuenta como restringido
  assert.equal(loteRestringido([{ type: 'sequence', steps: [{ type: 'theme', name: 'none' }] }]), true);
  assert.equal(fuentePermitida([{ type: 'sequence', steps: [{ type: 'desktop', action: 'stop' }] }], 'api', {}), false);
});

test('protocol: desktop sin show/hide/enter/leave y textos normativos', () => {
  assert.deepEqual(DESKTOP_ACTIONS, ['walk_to', 'peek', 'chase_cursor', 'seek_user', 'wander', 'stop']);
  for (const prohibida of ['show', 'hide', 'enter', 'leave']) {
    assert.ok(!COMMANDS.desktop.fields.split(';')[0].includes(prohibida), prohibida);
  }
  assert.equal(COMMANDS.desktop.desc,
    'Solo visores de escritorio (?desktop=1) y solo con la ventana visible: moverse por la pantalla.');
  assert.equal(COMMANDS.theme.fields, 'name amadeus|none; rim bool; scanlines 0..0.2');
  assert.deepEqual(COMMANDS.theme.example, { type: 'theme', name: 'amadeus', rim: true, scanlines: 0.07 });
});
