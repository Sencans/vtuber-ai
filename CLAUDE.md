# Instrucciones para agentes de IA (vtuber-ai)

**Guía obligatoria: `IMPORTANTEIA.md`, en esta misma carpeta. Léela entera antes de cambiar nada.** La guía completa del proyecto Amadeus está en `C:\proyectos\rams_biocore\IMPORTANTEIA.md`.

Reglas de oro (resumen; el detalle está en `IMPORTANTEIA.md`):
1. Nunca leas, subas, renombres ni borres `models/*.vrm` (licencia de VRoid Hub). `POST /api/models` sobrescribe.
2. `public/vendor/**` es intocable y no se añaden dependencias npm.
3. `lib/protocol.js` es un contrato con `lobes/vtuber_ai_bridge.py` de rams_biocore: nunca lo cambies por un solo lado.
4. No debilites la seguridad del servidor (`127.0.0.1`, Host y Origin locales, JSON, `X-Source`) ni toques el servidor vivo en :3939.
5. Nada de commits sin pedido ni git destructivo. Tras editar `public/*` reinicia `server.js` solo con permiso. Tests con `npm.cmd test` y un `modelsDir` temporal.
