# VTuber AI Studio

Interfaz gráfica para que **una IA mueva libremente un avatar VTuber 3D** (formato VRM).
La IA puede hacerlo hablar (voz + movimiento de labios), cambiar expresiones, hacer gestos y poses,
rotar cualquier hueso, mover las manos y los dedos, caminar por el escenario, mirar a distintos puntos y cambiar la cámara.

- Sin dependencias: solo necesitas **Node.js 18+** (para `npm test`, Node 22+).
- Funciona con **cualquier IA**: por HTTP (JSON), o por **MCP** para Claude (Desktop / Code).
- Listo para **OBS**: fondo transparente o chroma verde.
- **Modo escritorio** (`?desktop=1`) para Amadeus Desktop: el avatar camina por la pantalla del PC (lo controla R.A.M.S.).
- Todo el código de terceros (three.js y three-vrm) se sirve en **local** desde `public/vendor/`: no hace falta un CDN.

---

## 1. Arrancar

```bash
npm start
```

o haz doble clic en `start.bat` (Windows). Luego abre **http://localhost:3939**.
Para otro puerto: `PORT=4000 npm start` (`PORT=0` elige uno libre).

Para usar tu modelo:
- cópialo a la carpeta `models/`: si no pides otro, **es el que cargan todos los visores** (panel, OBS y el overlay de
  Amadeus Desktop) al abrirse y al recargarse; o
- arrástralo a la ventana o elígelo en la pestaña **Escena** (solo en ese visor).

Qué modelo carga un visor abierto **sin** `?model=` (se lo dice el servidor al conectarse, en el evento SSE `hello`):
1. el último `load_model` enviado por la API/MCP/R.A.M.S. que un visor confirmó (se recuerda mientras el servidor siga
   en marcha; no los `blob:`/`data:`);
2. si no, `VTUBER_AI_MODELO` (nombre de un archivo de `models/` o URL), por ejemplo `VTUBER_AI_MODELO=kurisu.vrm npm start`
   (la CSP de Amadeus Desktop solo deja cargar modelos del propio servidor o del CDN del ejemplo: usa un archivo de `models/`);
3. si no, el primer `.vrm` de `models/` por orden alfabético;
4. si no, el modelo de ejemplo (se descarga de jsDelivr: es un dato, no código). También es el respaldo si el modelo
   elegido no se puede cargar.

> ¿No tienes modelo? Créalo gratis con **VRoid Studio** y expórtalo como VRM.

## 2. Conectar una IA

### Opción A — Claude Code (MCP)

```bash
claude mcp add vtuber -- node "C:/ruta/a/vtuber-ai/mcp-server.js"
```

o, con el servidor ya corriendo, por HTTP:

```bash
claude mcp add --transport http vtuber http://localhost:3939/mcp
```

Después dile a Claude, por ejemplo: *"Saluda al chat con entusiasmo, baila un poco y luego despídete"*.

### Opción B — Claude Desktop (MCP)

Edita `%APPDATA%\Claude\claude_desktop_config.json` y añade:

```json
{
  "mcpServers": {
    "vtuber": {
      "command": "node",
      "args": ["C:/ruta/a/vtuber-ai/mcp-server.js"]
    }
  }
}
```

Reinicia Claude Desktop. Herramientas disponibles: `avatar_speak`, `avatar_expression`, `avatar_gesture`,
`avatar_pose`, `avatar_bones`, `avatar_hand`, `avatar_look`, `avatar_move`, `avatar_camera`,
`avatar_sequence`, `avatar_stop`, `avatar_get_state`, `avatar_command`.

`avatar_desktop` (mover al avatar por la pantalla del PC) **no** aparece por defecto: solo existe con
`MCP_DESKTOP=1` en el entorno del proceso MCP **y** en el del servidor (`MCP_DESKTOP=1 npm start`).
`avatar_command` y `avatar_sequence` rechazan siempre los comandos `desktop` y `theme`.

### Opción C — Cualquier otra IA (ChatGPT, Gemini, LLM local, tu propio bot…)

Envía JSON a `POST http://localhost:3939/api/command` (con `Content-Type: application/json`, obligatorio):

```bash
curl -X POST http://localhost:3939/api/command -H "Content-Type: application/json" -d '{"type":"speak","text":"¡Hola!","emotion":"happy","gesture":"wave"}'
```

En Python:

```python
import requests
requests.post("http://localhost:3939/api/command", json={
    "type": "sequence",
    "steps": [
        {"type": "speak", "text": "Déjame pensar…", "emotion": "relaxed"},
        {"type": "gesture", "name": "think"},
        {"type": "speak", "text": "¡Ya lo tengo!", "emotion": "happy", "gesture": "cheer"},
    ],
})
```

Truco: pásale a tu IA el contenido de `GET /api/help` como instrucciones del sistema; ahí está el protocolo completo.
La respuesta de cada comando dice si funcionó y, si no, por qué (por ejemplo, qué huesos existen).

Respuestas de error de `POST /api/command`:

| HTTP | `code` | Cuándo |
|---|---|---|
| 400 | `invalido` | JSON inválido, tipo desconocido, lote que mezcla `desktop` con otros tipos, `desktop`/`theme` dentro de `sequence` |
| 403 | `origen` | falta `Content-Type: application/json` o el `Origin` no es local |
| 403 | `fuente` | `desktop`/`theme` sin `X-Source: rams` (o `mcp` con `MCP_DESKTOP=1`) |
| 409 | `sin_visores` | no hay ningún visor abierto |
| 409 | `sin_overlay` | lote `desktop` y no hay ningún visor `?desktop=1` |

## 3. Comandos

| type | Para qué | Ejemplo |
|---|---|---|
| `speak` | Hablar con voz, labios y globo de texto (`"bubble":false` = sin globo) | `{"type":"speak","text":"Hola","emotion":"happy","gesture":"wave"}` |
| `expression` | Cara: happy, angry, sad, relaxed, surprised, neutral | `{"type":"expression","name":"surprised","hold":2}` |
| `gesture` | wave, nod, shake_head, bow, tilt_head, jump, clap, shrug, cheer, point, dance, laugh, look_around, think, surprise | `{"type":"gesture","name":"dance","loop":true}` |
| `pose` | relaxed, tpose, apose, arms_up, hands_on_hips, arms_crossed, thinking, shy | `{"type":"pose","name":"hands_on_hips"}` |
| `bones` | Control libre de cualquier hueso (grados) | `{"type":"bones","rotations":{"head":{"y":20},"rightUpperArm":{"z":-30}}}` |
| `hand` | open, relaxed, fist, point, peace, thumbs_up | `{"type":"hand","side":"right","shape":"peace"}` |
| `look` | camera, mouse, left, right, up, down, point… | `{"type":"look","at":"mouse"}` |
| `move` | Caminar / girar por el escenario | `{"type":"move","x":0.8,"rotation":30}` |
| `camera` | face, bust, full, wide | `{"type":"camera","preset":"bust"}` |
| `background` | gradient, green, blue, magenta, transparent, #hex | `{"type":"background","mode":"green"}` |
| `sequence` | Varios pasos en orden | `{"type":"sequence","steps":[...]}` |
| `idle`, `stop`, `reset`, `wait`, `load_model`, `state` | Utilidades | `{"type":"stop","what":"all"}` |
| `theme` | Tema visual: `amadeus` (look de Kurisu) o `none`. Solo R.A.M.S. | `{"type":"theme","name":"amadeus","rim":true,"scanlines":0.07}` |
| `desktop` | Moverse por la pantalla del PC (solo visores `?desktop=1` visibles). Solo R.A.M.S. | `{"type":"desktop","action":"walk_to","x":0.75,"speed":1}` |

Si envías una **lista** de comandos, se ejecutan **a la vez**; usa `sequence` para que vayan **en orden**.

**Convención de ejes** (vista desde el avatar): `x+` inclinar adelante / mirar abajo, `y+` girar hacia **su** izquierda,
`z+` ladear hacia **su** derecha. Brazos: `leftUpperArm z:-70` baja el brazo izquierdo, `rightUpperArm z:70` baja el derecho.

### `speak`

`text` (obligatorio, ≤ 2000 caracteres), `emotion`, `gesture`, `rate` 0.5..2, `pitch` 0..2, `lang`, `voice`, `tts` y
`bubble`. **`bubble`** (bool, por defecto `true`) decide si aparece el **globo de texto** sobre el avatar mientras habla:
con `false` habla (voz y labios) **sin globo**, y tampoco esconde ni reinicia el globo que otro `speak` esté
desvaneciendo. También acepta `1`/`0` y `"true"`/`"false"`; otro valor es un error (`"bubble" debe ser true o false.`).
El panel manual y `avatar_speak` (MCP) siguen mostrando el globo salvo que se pida `bubble:false`; R.A.M.S. lo manda en
cada `speak` según `VTUBER_AI_BURBUJA` (por defecto `0`: sin globo). La respuesta del visor incluye `bubble`.

```json
{"type":"speak","text":"Hmph. No lo digas en voz tan alta.","emotion":"angry","bubble":false}
```

### `theme`

`name: amadeus|none`, `rim` (bool, por defecto `true`), `scanlines` (0..0.2, por defecto 0.07). El tema se aplica al
**cargar** el modelo (antes de dibujarlo): si el pedido es distinto del activo, el visor **recarga** el modelo actual
(también para `none`); si es el mismo, no hace nada. Lo implementa `public/amadeus_theme.js`; si ese archivo falla, el
visor sigue sin tema y lo anota. En la URL: `?theme=amadeus`. En el panel: pestaña **Escena → Tema**.

### `desktop`

Acciones: `walk_to` (`x` 0..1 = posición del **centro** del avatar dentro del ancho útil; con `unit:"px"`, `x` es el centro
en px CSS), `peek` (`edge` left|right: asomarse por un borde), `chase_cursor` (`seconds` ≤ 15: perseguir el cursor),
`seek_user` (ir junto al cursor, mirarlo y saludar), `wander` (`seconds` ≤ 15: pasear) y `stop`. `speed` 0.3..3.
No hay `show`/`hide`/`enter`/`leave`: aparecer y esconderse lo decide el proceso principal de Amadeus Desktop.
Con la ventana oculta el visor responde `{ok:false, type:"desktop", error:"oculta"}`.
Mientras **entra** por el borde (orden de Electron), una acción `desktop` no la corta: responde
`{ok:true, ..., tras:"entrada"}` y se ejecuta al terminar la entrada (si llegan varias, solo la última; un `stop`, del
tipo que sea, descarta la que esperaba). `stop`/`reset` genéricos tampoco cortan la entrada ni la salida por el borde, y
`move` ignora ahí `rotation`.

## 4. Usarlo en OBS

Añade una fuente **Navegador** con `http://localhost:3939/?obs=1` (oculta el panel, fondo transparente).
Otras opciones de URL: `?bg=green`, `?camera=face|bust|full|wide`, `?model=mi_modelo.vrm`, `?theme=amadeus`, `?tts=1`.

**Regla de voz:** como mucho **un** visor reproduce la voz del navegador: el panel normal, si está abierto. Los visores
`?obs=1` y `?desktop=1` nunca hablan en voz alta (ignoran el campo `tts` de `speak` y solo mueven los labios), salvo con
`?tts=1`. Así no se oyen dos voces cuando tienes el panel y OBS abiertos a la vez.

Atajo: tecla **H** para ocultar o mostrar el panel.

## 5. Modo escritorio (`?desktop=1`)

Lo usa **Amadeus Desktop** (la app de Electron de R.A.M.S.), que carga
`http://127.0.0.1:3939/?obs=1&desktop=1&camera=full&theme=amadeus` en una ventana transparente que cubre la pantalla.

- Implica `?obs=1` (transparente, sin panel), sin controles de cámara y con el cuerpo entero encuadrado (`?camera=` lo cambia).
- El avatar vive en una **caja de 340×600 px** que se mueve por la pantalla. Fuera del cuerpo los clics pasan a las
  ventanas de debajo (el proceso principal de Electron tiene la última palabra). El hit-test lee el **alfa del propio
  canvas** bajo el cursor (lo que se ve es lo que se agarra): una lectura asíncrona por fotograma (WebGL2,
  `PIXEL_PACK_BUFFER` + `fenceSync`, ≤ 20 Hz) que no espera a la GPU; solo un clic sin muestra reciente dibuja y lee en
  el acto. Sin lectura de píxeles, respaldo por raycast a ≤ 4 Hz.
- Sin `?model=` carga el modelo que dice el servidor (ver §1): tu `.vrm` de `models/` también en el overlay.
- **Arrastrarla** con el ratón y soltarla en el aire (cae al suelo), **clic** para tocarla, **clic derecho** para abrir el chat.
- Mira el cursor del ratón. `move` ignora `x`/`z` (respeta `rotation` y `walk`); `camera` y `background` no cambian el
  encuadre ni el fondo transparente.
- La ventana arranca oculta y no dibuja nada mientras lo está; dibuja a ≤ 30 fps en reposo y ≤ 60 fps caminando o arrastrándola.
- Mientras la cámara de R.A.M.S. está abierta (vistazo o visión continua) se ve un **ojo** 👁 en la esquina de la caja
  (orden `camara` de Amadeus Desktop; no captura clics).
- Abierto en un navegador normal (sin Electron) también funciona, siempre visible, para probarlo.

Las órdenes de visibilidad (aparecer desde un borde, esconderse) y los eventos (toque, soltada, cursor encima) van por
la API `window.amadeusDesktop` que expone el preload de Electron; ver `rams_biocore/docs/COMPANION.md` §C2.5 y §C2.7.

`GET /api/state` añade `viewers`, `desktopViewers` (visores de escritorio **visibles**), `desktopViewersTotal`
(cargados, visibles u ocultos) y `viewerSeq` (sube con cada conexión de un visor; R.A.M.S. lo usa para reenviar el tema).

**Estado y acks con panel y overlay a la vez.** Cada visor guarda su propio estado. `GET /api/state` (y
`avatar_get_state`) publica el del visor **no** de escritorio (panel u OBS) que informó más recientemente, y el del
overlay solo si no hay otro: el overlay ignora `x`/`z`, el encuadre y el fondo, así que su `current` no describe al
avatar del panel. Igual con las respuestas: en un lote que llega a los dos, manda el ack del panel; el del overlay solo
se usa si el panel no contesta en 0,6 s (5 s para `load_model`).

## 6. Seguridad

- El servidor solo escucha en `127.0.0.1` y rechaza peticiones con otro `Host` (protección contra DNS rebinding).
- Todo `POST` (`/api/command`, `/api/ack`, `/api/state`, `/mcp`) exige `Content-Type: application/json` y un `Origin`
  ausente o local (`http://127.0.0.1:<puerto>` o `http://localhost:<puerto>`); si no, `403`. CORS solo responde a ese
  Origin local (nunca `*`), así que una web cualquiera abierta en tu navegador no puede mover al avatar.
  Abre el visor en `http://localhost:<puerto>` o `http://127.0.0.1:<puerto>`.
- `desktop` y `theme` exigen la cabecera `X-Source: rams` (o `mcp` con `MCP_DESKTOP=1`).
- `GET /api/events` (el SSE de los visores) solo registra un `EventSource` de la propia página: exige
  `Accept: text/event-stream` y, si el navegador las manda, `Sec-Fetch-Dest: empty` y `Sec-Fetch-Site: same-origin`.
  Un `<iframe>`, `<audio>` o `<video>` de otra web (que no envían `Origin`) recibe `403` y no cuenta como visor.
  Para depurar con curl: `curl -N -H "Accept: text/event-stream" http://localhost:3939/api/events`.
- Ninguna acción sensible del PC (abrir apps, teclear, mover el cursor real) pasa por este servidor: eso vive en R.A.M.S.,
  con su compuerta de permisos.

## 7. Estructura

```
server.js          servidor local (HTTP + SSE + endpoint MCP), sin dependencias; export createServer()
mcp-server.js      servidor MCP por stdio para Claude
lib/protocol.js    nombres de poses, gestos y documentación de comandos (compartido)
lib/dispatch.js    reglas puras de despacho (lotes, visores destino, fuentes permitidas)
lib/mcp.js         definición de herramientas MCP
public/            visor 3D (three.js + three-vrm) y panel de control
public/vendor/     three@0.180.0 y @pixiv/three-vrm@3.4.4 copiados de npm (versiones y SHA-256 en VENDOR.md)
public/amadeus_theme.js  tema Amadeus (look de Kurisu)
models/            pon aquí tus .vrm
test/              pruebas (node --test)
```

## 8. Pruebas

```bash
npm test
```

Ejecuta `node --test test/` (Node 22+): reglas de despacho, servidor en un puerto libre (nunca el 3939),
seguridad de los POST y del SSE, códigos 409, estado y ack por visor (el del panel manda sobre el del overlay), modelo
inicial (`hello.defaultModel`), MCP, imports locales de `public/vendor/` y `node --check` de todos los `.js`.

## Notas

- La voz usa la síntesis del navegador (gratis, sin claves). El navegador puede pedir un clic en la página antes de permitir audio;
  mientras tanto el avatar mueve los labios en silencio.
- **2D (Live2D)**: este proyecto usa VRM 3D porque es un formato abierto. Live2D se puede añadir con `pixi-live2d-display`,
  pero requiere el *Cubism Core* de Live2D, que tiene su propia licencia.
