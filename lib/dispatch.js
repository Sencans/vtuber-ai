// Reglas puras de despacho de comandos (sin red ni estado): las usa server.js y se prueban con node --test.
//   - normalizeCommands: valida el cuerpo de POST /api/command y devuelve la lista de comandos.
//   - targetsFor: a qué visores va un lote ('desktop' solo a los visores de escritorio).
//   - desktopCount / desktopTotal: visores de escritorio visibles / cargados.
//   - fuentePermitida: 'desktop' y 'theme' solo desde R.A.M.S. (o MCP con MCP_DESKTOP=1).
import {
  COMMAND_TYPES, RESTRICTED_TYPES, DESKTOP_ACTIONS, DESKTOP_EDGES, THEMES,
} from './protocol.js';

export const MAX_COMMANDS = 100;
const MAX_DEPTH = 8;

const esObjeto = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** Recorre un comando y los pasos de sus "sequence" (con límite de profundidad). */
function* recorrer(cmd, depth = 0) {
  if (!esObjeto(cmd)) return;
  yield { cmd, depth };
  if (cmd.type === 'sequence' && Array.isArray(cmd.steps) && depth < MAX_DEPTH) {
    for (const s of cmd.steps) yield* recorrer(s, depth + 1);
  }
}

/** true si el comando (o algún paso anidado) es de alguno de los tipos dados. */
export function contieneTipo(cmd, tipos) {
  for (const { cmd: c } of recorrer(cmd)) if (tipos.includes(c.type)) return true;
  return false;
}

/** true si algún comando del lote es 'desktop' o 'theme' (también dentro de un sequence). */
export function loteRestringido(commands) {
  return (commands || []).some((c) => contieneTipo(c, RESTRICTED_TYPES));
}

function validarDesktop(c) {
  if (!DESKTOP_ACTIONS.includes(c.action)) {
    throw new Error(`desktop: acción desconocida "${c.action}". Acciones: ${DESKTOP_ACTIONS.join(', ')}`);
  }
  if (c.edge != null && !DESKTOP_EDGES.includes(c.edge)) {
    throw new Error(`desktop: edge debe ser ${DESKTOP_EDGES.join(' o ')}.`);
  }
  if (c.unit != null && c.unit !== 'px') throw new Error('desktop: unit solo admite "px".');
  for (const k of ['x', 'seconds', 'speed']) {
    if (c[k] != null && !(typeof c[k] === 'number' && Number.isFinite(c[k]))) {
      throw new Error(`desktop: ${k} debe ser un número.`);
    }
  }
  if (c.action === 'walk_to' && c.x == null) throw new Error('desktop walk_to requiere "x".');
}

function validarTheme(c) {
  if (!THEMES.includes(c.name)) throw new Error(`theme: nombre desconocido "${c.name}". Opciones: ${THEMES.join(', ')}`);
  if (c.rim != null && typeof c.rim !== 'boolean') throw new Error('theme: rim debe ser booleano.');
  if (c.scanlines != null && !(typeof c.scanlines === 'number' && Number.isFinite(c.scanlines))) {
    throw new Error('theme: scanlines debe ser un número (0..0.2).');
  }
}

/**
 * Lista validada contra COMMAND_TYPES. Acepta comando | [comandos] | {commands:[...]}.
 * Lanza Error (→ 400) si algo no es válido. 'desktop' y 'theme' no pueden ir dentro de un sequence.
 */
export function normalizeCommands(body) {
  if (esObjeto(body) && Array.isArray(body.commands)) body = body.commands;
  const list = Array.isArray(body) ? body : [body];
  if (!list.length) throw new Error('No se recibió ningún comando.');
  if (list.length > MAX_COMMANDS) throw new Error(`Demasiados comandos en un lote (máx. ${MAX_COMMANDS}).`);
  for (const c of list) {
    if (!esObjeto(c) || typeof c.type !== 'string') {
      throw new Error('Cada comando debe ser un objeto con "type". Ver GET /api/help');
    }
    for (const { cmd, depth } of recorrer(c)) {
      if (typeof cmd.type !== 'string' || !COMMAND_TYPES.includes(cmd.type)) {
        if (depth === 0) throw new Error(`Tipo desconocido "${cmd.type}". Tipos válidos: ${COMMAND_TYPES.join(', ')}`);
        continue;   // los pasos de un sequence los valida el visor con su propio mensaje
      }
      if (depth > 0 && RESTRICTED_TYPES.includes(cmd.type)) {
        throw new Error(`"${cmd.type}" no puede ir dentro de un sequence: envíalo como comando suelto.`);
      }
      if (cmd.type === 'desktop') validarDesktop(cmd);
      if (cmd.type === 'theme') validarTheme(cmd);
    }
  }
  return list;
}

/**
 * Visores destinatarios de un lote. Un lote con algún 'desktop' va solo a los visores con desktop===true;
 * un lote que mezcla 'desktop' con otros tipos lanza Error (→ 400). El resto va a todos.
 */
export function targetsFor(viewers, commands) {
  const all = [...(viewers || [])];
  const list = commands || [];
  const nDesktop = list.filter((c) => c?.type === 'desktop').length;
  if (nDesktop === 0) return all;
  if (nDesktop !== list.length) {
    throw new Error('Un lote con "desktop" no puede mezclarse con otros tipos de comando: envíalos por separado.');
  }
  return all.filter((v) => v?.desktop === true);
}

/** Nº de visores de escritorio con la ventana visible. */
export function desktopCount(viewers) {
  let n = 0;
  for (const v of viewers || []) if (v?.desktop === true && v.visible === true) n++;
  return n;
}

/** Nº de visores de escritorio cargados (visibles u ocultos). */
export function desktopTotal(viewers) {
  let n = 0;
  for (const v of viewers || []) if (v?.desktop === true) n++;
  return n;
}

/**
 * true si la fuente puede enviar este lote: 'desktop'/'theme' solo si source==='rams' o
 * (source==='mcp' && env.MCP_DESKTOP==='1'). Los demás tipos, cualquier fuente.
 */
export function fuentePermitida(commands, source, env = {}) {
  if (!loteRestringido(commands)) return true;
  if (source === 'rams') return true;
  return source === 'mcp' && env?.MCP_DESKTOP === '1';
}
