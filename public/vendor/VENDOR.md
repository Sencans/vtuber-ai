# Código de terceros (vendor)

El visor ya no carga código desde un CDN: todo el JavaScript de terceros se sirve desde esta carpeta
(`/vendor/...`), copiado **sin modificar** de los paquetes publicados en el registro oficial de npm.
El importmap de `public/index.html` apunta aquí. El VRM de ejemplo (`DEFAULT_MODEL_URL` en
`lib/protocol.js`) sigue en jsDelivr porque es un **dato** (no ejecuta código) y no está en npm.

| Paquete | Versión | Licencia | Tarball de npm (sha1 del registro) |
|---|---|---|---|
| `three` | 0.180.0 | MIT | `three-0.180.0.tgz` (`b930cabfb524f6d36bf63e874b4d866888b50487`) |
| `@pixiv/three-vrm` | 3.4.4 | MIT | `pixiv-three-vrm-3.4.4.tgz` (`a2c3e510df77c9eb714bef0b2b5d24a9f8766db9`) |

`npm pack` verificó la integridad `sha512` de cada tarball contra los metadatos del registro.

## Archivos y SHA-256

Ruta dentro de `public/vendor/` → ruta dentro del paquete:

| Archivo | Origen en el paquete | Bytes | SHA-256 |
|---|---|---|---|
| `three/build/three.module.js` | `three/build/three.module.js` | 603113 | `c8211c69345d2e9949dc7a8ac969380497aa0600a5a8ac6a459c8cd02dd9cb8a` |
| `three/build/three.core.js` | `three/build/three.core.js` | 1403455 | `eb077d2417f61d3e6d9264c317cabc4ea35769ed6b0ab533067292a550784c20` |
| `three/examples/jsm/loaders/GLTFLoader.js` | `three/examples/jsm/loaders/GLTFLoader.js` | 114739 | `67ac5551fdafa6e349bd80c8f8e5e39c136d6b2fb1ad647db9abb21dc86f9e4a` |
| `three/examples/jsm/utils/BufferGeometryUtils.js` | `three/examples/jsm/utils/BufferGeometryUtils.js` | 35539 | `fda7e946b8e0b5ab39b779206589e7a1079a22eb24efb89d7223e03fdfb1f751` |
| `three/examples/jsm/controls/OrbitControls.js` | `three/examples/jsm/controls/OrbitControls.js` | 38703 | `b97879c748170baadeb3fb84cea1ffdf4674e283dc06042f34e2acb95a76042c` |
| `three/LICENSE` | `three/LICENSE` | 1081 | `bfe119ea4fd413f5f7ca3fcd63adb0c4a073ed39daa2fe7d3e6b769e21272601` |
| `three-vrm/lib/three-vrm.module.min.js` | `@pixiv/three-vrm/lib/three-vrm.module.min.js` | 151709 | `b61e825655c2889e9e7ef943085b80e0064dd6cc8fd33173cc615cf4cddf6200` |
| `three-vrm/LICENSE` | `@pixiv/three-vrm/LICENSE` | 1072 | `387a46128d34de9d85ea1e07a5a716dba532dbabca6c10adad447f48a29518d3` |

## Cierre de importaciones

`public/app.js` importa `three`, `three/addons/loaders/GLTFLoader.js`, `three/addons/controls/OrbitControls.js`
y `@pixiv/three-vrm`. Sus dependencias:

- `three.module.js` → `./three.core.js`
- `GLTFLoader.js` → `three` y `../utils/BufferGeometryUtils.js`
- `OrbitControls.js`, `BufferGeometryUtils.js` y `three-vrm.module.min.js` → solo `three`

`test/server.test.js` comprueba que cada import de `three/addons/` de `app.js` y cada import relativo de
estos archivos resuelve a un archivo existente de esta carpeta.

## Actualizar

1. `npm pack three@<versión> @pixiv/three-vrm@<versión>` en una carpeta vacía y descomprimir cada tarball aparte.
2. Copiar los mismos archivos (y los nuevos que exija el cierre de importaciones) a estas rutas.
3. Recalcular la tabla con `sha256sum` y actualizar las versiones aquí.
4. Ejecutar `npm test` en `vtuber-ai/`.
