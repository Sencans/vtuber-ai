# IMPORTANTEIA: guía para IAs de código en vtuber-ai

> Para Claude, Codex, Cursor, Gemini o cualquier otra IA que llegue aquí sin contexto.
> **Antes de nada lee IMPORTANTEIA.md** (este archivo) entero.
> La guía **completa** de todo el proyecto Amadeus está en `C:\proyectos\rams_biocore\IMPORTANTEIA.md`. Léela también antes de tocar algo que hable con R.A.M.S. o con Amadeus Desktop (protocolo, `X-Source`, tema, overlay).
>
> Revisado contra el código real el 2026-10-17.
> - Si el código y este archivo no coinciden en **datos** (nombres, líneas, cifras), manda el código. Avisa al usuario.
> - Si el código parece **violar una regla de seguridad**, no lo tomes como precedente: avisa al usuario y no lo extiendas.

---

## 1. Qué es esto

**VTuber AI Studio** es el **cuerpo 3D** de Amadeus (Kurisu Makise). Es un visor VRM (three.js + three-vrm) servido por `node server.js` en `127.0.0.1:3939`, **sin dependencias npm**. No decide nada: solo obedece comandos.

| Quién le habla | Cómo |
|---|---|
| R.A.M.S. BIO-CORE (`C:\proyectos\rams_biocore`, `lobes/vtuber_ai_bridge.py`) | `POST /api/command` y `GET /api/state`, con `X-Source: rams` |
| Amadeus Desktop (`rams_biocore\desktop`, Electron) | Carga el visor como overlay transparente (`?desktop=1`) |
| OBS | `?obs=1` |
| `mcp-server.js` | MCP por stdio: reenvía a `:3939` con `X-Source: mcp` |

## 2. Mapa de archivos

| Ruta | Qué es |
|---|---|
| `server.js` | Servidor HTTP `127.0.0.1:3939`: `/api/*`, SSE, `/mcp`, subida de modelos y huella `build` |
| `lib/protocol.js` | **Única fuente de verdad** de los comandos del visor |
| `lib/dispatch.js` | Despacho y tipos restringidos (`desktop`, `theme`) |
| `lib/mcp.js` | Herramientas MCP `avatar_*` |
| `mcp-server.js` | MCP por stdio |
| `public/app.js` | Visor: poses, órdenes de escritorio, arreglo VRM 0.x, subida y recarga |
| `public/amadeus_theme.js` / `.css` | Tema "Amadeus", procedural |
| `public/index.html`, `style.css` | Página del visor (el importmap tiene hash en la CSP de Electron) |
| `public/vendor/` | three 0.180.0 y @pixiv/three-vrm 3.4.4 **sin modificar** (`VENDOR.md`) |
| `models/` | Modelos `.vrm` del usuario. **Fuera de git y con licencia** |
| `test/` | Tests de Node (`node --test`) |
| `start.bat`, `.claude/launch.json` | Lanzadores: arrancan `server.js` en :3939 |

## 3. Qué NO tocar (reglas de oro)

1. **Modelos con licencia.** NUNCA leas, subas, renombres, borres ni commitees `models/*.vrm`. `Kurisu-4210657567129258326.vrm` viene de VRoid Hub: no se redistribuye y hay que dar crédito. Ojo: `POST /api/models` **sobrescribe** un archivo con el mismo nombre.
2. **`public/vendor/**` es intocable.** Son copias exactas con SHA-256 en `VENDOR.md`; solo se actualizan con ese procedimiento. Nunca pasarlas a CDN: la CSP del overlay lo bloquea. **No añadas dependencias npm.**
3. **El protocolo es un contrato.** `lib/protocol.js` manda. Si cambian nombres o campos de comandos, actualiza a la vez `lobes/vtuber_ai_bridge.py` en rams_biocore (`EXP_A_MEZCLA`, `MOTION_A_PASOS`), `public/app.js` y `lib/mcp.js`. Nunca por un solo lado.
4. **No debilites la seguridad del servidor:**
   - escucha solo en `127.0.0.1`: nunca `0.0.0.0` ni CORS `*`;
   - exige Host local;
   - todo POST lleva `Content-Type` JSON (salvo la subida binaria de `.vrm` en `POST /api/models`) y Origin ausente o local;
   - el SSE solo acepta un `EventSource` del propio visor;
   - `desktop` y `theme` solo con `X-Source: rams` (o `mcp` con `MCP_DESKTOP=1`).
5. **No toques el servicio en vivo.** Nunca arranques otro `server.js` en :3939 ni mandes peticiones a :3939 si el usuario lo tiene abierto.
   - Compruébalo sin conectarte: `Get-NetTCPConnection -State Listen -LocalPort 3939 -ErrorAction SilentlyContinue` (Linux: `ss -ltn | grep :3939`). Ante la duda, pregunta.
   - No uses el preview `vtuber-studio` de `.claude/launch.json` ni `start.bat` si ya hay uno vivo.
   - Para probar a mano: `$env:PORT="3940"; node server.js` y ciérralo al terminar.
6. **Reinicio tras editar.** Tras editar `public/*.js`, `*.css`, `*.html` o `lib/protocol.js` hay que reiniciar `server.js` (pide permiso al usuario): la huella `build` se calcula al arrancar y los visores abiertos se recargan solos al reconectar.
7. **No quites el arreglo VRM 0.x.** Toda rotación de huesos pasa por el mapa `out` de `app.js`, que niega x y z cuando `metaVersion === '0'`.
8. **Git.** Rama `main`, sin remoto. No hagas commits si el usuario no lo pide. NUNCA: `git checkout`, `restore`, `reset`, `stash`, `clean`, `rm`, `rebase`, `push --force`, `add -f` ni `commit -a`. Para ver versiones anteriores usa solo `git status`, `git diff`, `git log -p` o `git show HEAD:<ruta>`.
9. **Estilo.** Todo en español (UI, logs, comentarios). Archivos en UTF-8 sin BOM y con LF. En Windows no escribas archivos con `Set-Content`, `Out-File` ni `>` de PowerShell 5.1.

## 4. Tema Amadeus

- La paleta de Kurisu, la corbata y las medias solo se aplican al modelo de ejemplo (`app.js`: `paleta: modelUrl === DEFAULT_MODEL_URL`).
- Un modelo cuyos **metadatos VRM** (`name`/`title` o `references`/`reference`) contengan Kurisu, Makise, 紅莉栖, 牧瀬 o Amadeus nunca se recolorea (`esModeloDeKurisu`; no depende del nombre del archivo).
- Quitar el tema requiere 3 sitios: `VTUBER_AI_TEMA=none` en el `.env` de R.A.M.S., la misma variable en el entorno de Electron y el chip "Ninguno" del panel.

## 5. Cómo probar

| Qué | Comando | Resultado esperado (17-10-2026) |
|---|---|---|
| Tests del visor | `cd C:\proyectos\vtuber-ai; npm.cmd test` (PowerShell bloquea `npm.ps1`). Linux: `npm test` | 63/63. Usan un puerto libre, nunca el 3939 |
| Lado Python del protocolo | En rams_biocore: `.\.venv\Scripts\python.exe -m pytest tests/test_vtuber_ai_bridge.py -p no:cacheprovider` | Todo pasa (el `.venv` no trae pytest: pide permiso para instalarlo) |

- Los tests nuevos usan `createServer({ port: 0, host: '127.0.0.1', env: {}, modelsDir: mkdtempSync(...) })`. Sin `modelsDir` se usa `models/` real, y una subida sobrescribiría el `.vrm` de Kurisu.

## 6. Estado actual

- Rama `main`, git local sin remoto, 2 commits (`b0530af`, `b466e95`).
- **Trabajo SIN COMMIT (no lo pierdas):** arreglo de VRM 0.x, subida de modelos, recarga por huella `build`, `speak.bubble` y tema solo para el modelo de ejemplo. Archivos: `.gitignore`, `README.md`, `lib/mcp.js`, `lib/protocol.js`, `public/amadeus_theme.js`, `public/app.js`, `server.js`, `test/server.test.js` (modificados) y `test/speak_bubble.test.js` (nuevo).
- **Documentación desactualizada (se puede corregir):** `models/README.md` L16–17 (ahora `.gitignore` sí excluye los `.vrm`) y L55–59 (el tema ya solo se aplica al modelo de ejemplo); `README.md` §6 (no documenta la subida binaria, la huella `build` ni el arreglo VRM 0.x).
- **Antes de terminar:** corre los tests y di al usuario qué cambiaste, qué no pudiste verificar y qué queda sin commit.
