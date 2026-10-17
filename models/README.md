# Modelos VRM propios (y cómo tener a Kurisu / Amadeus)

Esta carpeta es para **tus** modelos `.vrm`. Todo archivo `.vrm` que copies aquí aparece en la pestaña
**Escena** del visor (lo lista `GET /api/models`) y se carga con:

- el selector de la pestaña **Escena**, o arrastrando el archivo a la ventana;
- la URL: `http://localhost:3939/?model=kurisu.vrm` (también con `&theme=amadeus`);
- un comando: `{"type": "load_model", "url": "kurisu.vrm"}` (por `POST /api/command` o MCP). El
  servidor lo difunde a todos los visores conectados, también al overlay de Amadeus Desktop.

> **Homenaje de fan.** Makise Kurisu, Amadeus y STEINS;GATE son propiedad de sus titulares
> (MAGES./Nitroplus). Este proyecto **no incluye ni usa assets oficiales** (ni modelos, ni sprites, ni
> logos). El tema «Amadeus» es procedural: colores, corbata, medias, rim, scanlines y un marco con
> texto propio. Usa todo esto en privado y sin ánimo de lucro.

**No subas los `.vrm` a ningún repositorio** ni los redistribuyas: cada modelo tiene su propia licencia
y la mayoría la prohíbe. (El `.gitignore` de este proyecto no los excluye; revísalo antes de hacer commit.)

---

## Opción 1 — Descargar un modelo de fans de VRoid Hub (recomendada)

La descarga exige **iniciar sesión en pixiv** y aceptar las condiciones del autor en la página del
modelo («Use this model» / «Download»). La tienes que hacer tú: ni R.A.M.S. ni este visor descargan
modelos por su cuenta.

| Modelo | Autor | Formato | Condiciones (según su ficha en VRoid Hub, oct-2026) |
|---|---|---|---|
| [Makise Kurisu (VRM 1.0)](https://hub.vroid.com/characters/3327812940140047901/models/7764817289520928546) | ShiningFinger | VRM 1.0 | Uso personal sin ánimo de lucro · modificación permitida · **crédito obligatorio** · redistribución **no** · licencia de terceros CC BY-NC 4.0. **El mejor candidato.** |
| [Makise Kurisu (otra subida, VRM 1.0)](https://hub.vroid.com/characters/8215762031641490047/models/2869816873932430901) | ShiningFinger | VRM 1.0 | Igual que el anterior, pero con redistribución permitida. |
| ["Lab Coat" – Makise Kurisu / 牧瀬紅莉栖](https://hub.vroid.com/characters/8276698905559025084/models/7316914820220871940) | er123wjenny | VRM 0.0 | Personal sin ánimo de lucro · modificación sí · redistribución no · crédito obligatorio · sin contenido sexual ni violento. Lleva **bata**: encaja con el «modo Amadeus». |
| [Makise kurisu v1](https://hub.vroid.com/characters/4528537644133076159/models/4398899961456061959) | NouvelleStory | VRM 0.0 | Personal sin ánimo de lucro · modificación y redistribución permitidas · crédito no necesario. |

Antes de usar cualquiera, **vuelve a leer su ficha**: el autor puede cambiar las condiciones. Si un
modelo dice «modificación no permitida», no le apliques el recoloreado; mira
[Quitar el tema](#quitar-el-tema-tres-sitios): hay que desactivarlo en **tres** sitios, también en el
overlay de Amadeus Desktop. La licencia del modelo cubre los datos 3D de su autor, no el personaje.

Pasos:

1. Descarga el `.vrm` desde la página del modelo (con tu cuenta de pixiv).
2. Cópialo aquí con un nombre simple, por ejemplo `models/kurisu.vrm`.
3. Ábrelo: `http://localhost:3939/?model=kurisu.vrm&theme=amadeus`, o elígelo en **Escena**.
4. **Crédito obligatorio:** cita al autor donde se vea el avatar (descripción del stream, vídeo o
   captura), por ejemplo: «Modelo: Makise Kurisu por ShiningFinger (VRoid Hub) · homenaje de fan».

### ¿Qué hace el tema con un modelo que ya es de Kurisu?

Si el nombre del modelo (metadatos VRM `name` en 1.0, `title` en 0.x) o sus **referencias** (`references`
en 1.0, `reference` en 0.x; en VRoid Studio, el campo *References* al exportar) contienen *Kurisu*,
*Makise*, *紅莉栖*, *牧瀬* o *Amadeus*, el tema **no lo recolorea ni le añade corbata o medias**: lo
respeta tal como lo hizo su autor y solo añade el rim ámbar de «conexión», las scanlines dentro del
canvas y, fuera del modo escritorio, el marco de videollamada.

Si no aparece en ninguno de esos campos, el tema lo trata como un modelo cualquiera: le aplica el
gradient map al pelo, al iris y a las botas, le pinta medias y, si ninguna malla o material se llama
*tie*/*necktie*/*corbata*/*ネクタイ*, le **añade una corbata 3D**. Una corbata pintada en la textura de
la camisa o hecha con un accesorio de VRoid (`Accessory…`) no se detecta por nombre: acabarías con
dos. En ese caso declara a Kurisu en el nombre o en las referencias (ver la opción 2) o quita el tema.

---

## Opción 2 — Crearla tú en VRoid Studio

VRoid Studio es gratuito (Windows/macOS; versión 2.14 en 2026). Guía rápida:

1. **Cuerpo:** chica delgada de unos **160 cm**.
2. **Pelo:** trasero largo y liso hasta la cintura; flequillo abierto con mechones laterales largos que
   enmarcan la cara y **un mechón fino que cae entre los ojos** (el rasgo más reconocible).
   Colores: base `#803d23`, sombra `#4b2718`, brillo `#a14c2d` / `#c06a42` (que no sea amarillo).
3. **Cara:** ojos algo rasgados y serios; iris `#9883b7` con borde y pupila `#453450` y un reflejo
   blanco pequeño; cejas finas castaño rojizo; piel `#f5e5cd`.
4. **Ropa:**
   - camisa blanca de manga larga con ribete azul fino (`#2f4a7a`) en cuello y puños;
   - **corbata roja floja** `#ae1927` (pintada en la camisa o como accesorio personalizado, v2.10+;
     el tema no la reconoce por su nombre, así que declara a Kurisu al exportar, paso 6);
   - shorts negros con cinturón blanco y hebilla dorada;
   - **medias** negras `#241711` (capa *legwear*);
   - **botas** negras altas con el borde doblado.
5. **Variantes:** «S;G» con chaqueta caqui larga (`#c2ab88`) con correas en los puños, o
   «Amadeus / S;G0» con **bata blanca** (`#f1f3f0`, sombra `#d7e6e2`). Si usas ítems de BOOTH, revisa
   la licencia de cada uno.
6. **Exportar** (icono de exportar → *Export VRM*):
   - formato **VRM 1.0**;
   - **sin reducir materiales** (desmarca la reducción de materiales; reducir polígonos o huesos es
     opcional). Si los materiales se fusionan en un atlas, el visor ya no puede distinguir pelo, ojos y
     ropa y el tema no puede recolorear por nombre;
   - si se pierden mechones finos, desactiva *Delete Transparent Mesh*;
   - rellena los campos obligatorios **Avatar name** y **Creator**. El *Avatar name* debe contener
     **Kurisu** o **Amadeus** (por ejemplo `Makise Kurisu (fan)`): así el tema la respeta y no le
     cambia los colores que ajustaste ni le añade una segunda corbata;
   - licencia sugerida: *personal non-profit*, sin redistribución;
   - en **References** declara la obra original con el personaje, por ejemplo:
     `Makise Kurisu – STEINS;GATE (homenaje de fan), sin assets oficiales` (el tema también lo lee).
7. Copia el archivo a `models/kurisu.vrm` y cárgalo como en la opción 1.

---

## El tema «Amadeus» y los nombres de material

El tema (`public/amadeus_theme.js`) se activa con `?theme=amadeus` en la URL o con el comando
`{"type":"theme","name":"amadeus"}`, que el servidor solo acepta de R.A.M.S. (`X-Source: rams`).
Recolorea por **nombre de material**, así que funciona con las exportaciones de VRoid sin tocar nada:

| Parte | Nombres que reconoce (ejemplos) | Qué hace |
|---|---|---|
| `hair` | `Hair_00_HAIR`, `HairBack_00_HAIR`, `N00_000_Hair_00_HAIR_01 (Instance)` | gradient map a castaño rojizo (auburn) |
| `iris` | `EyeIris_00_EYE` | gradient map a violeta apagado |
| `shoes` | `Shoes_01_CLOTH`, `Boots` | botas oscuras |
| `socks` | `Socks`, `Tights`, `Legwear` | medias oscuras |
| `skin` | `Body_00_SKIN`, `Face_00_SKIN` | sombra cálida; en el cuerpo pinta **medias** bajo los shorts |
| `tops` | `Tops_01_CLOTH`, `Onepiece`, `Coat` | sombra fría de bata |
| `eye`, `bottoms` | `EyeWhite_00_EYE`, `Bottoms_01_CLOTH` | se quedan como vienen |

Tolera los sufijos ` (Outline)` / ` (Instance)` y el prefijo `N00_000_00_` de VRoid, y recolorea tanto
la superficie como el contorno (*outline*). Además añade una **corbata roja** procedural atada al
hueso `upperChest` (si el modelo no trae ya una), un rim ámbar y scanlines sutiles. Sin modelo propio,
recolorea el de ejemplo (`VRM1_Constraint_Twist_Sample`, de pixiv, con licencia que permite
modificarlo).

### Quitar el tema (tres sitios)

Cada visor decide su tema por separado y R.A.M.S. puede volver a enviarlo a **todos** (también al
overlay) cada vez que se conecta o recarga un visor. Para que un modelo no se toque en ningún sitio:

1. **R.A.M.S.:** `VTUBER_AI_TEMA=none` en su `.env`. Con `none` su puente nunca envía `theme`; con
   `amadeus` lo reenvía a todos los visores y deshace lo de los puntos 2 y 3.
2. **Overlay de Amadeus Desktop:** su URL (`…&theme=amadeus`) la fija Electron, que **no lee** el
   `.env` de R.A.M.S. sino su propio entorno de proceso. Define `VTUBER_AI_TEMA=none` en el entorno con
   el que lanzas la app: en Windows, `$env:VTUBER_AI_TEMA='none'; npm start` en PowerShell (o
   `setx VTUBER_AI_TEMA none` si arranca con la sesión); en Linux/Hyprland, `VTUBER_AI_TEMA=none` delante
   de la orden con que la arrancas. Detalles en `rams_biocore/desktop/README.md` (*Variables de
   entorno*). Hay que reiniciar la app para que cambie la URL.
3. **Panel del navegador:** abre la URL **sin** `&theme=amadeus` o elige el chip **Ninguno** en
   **Escena → Tema**. El chip solo afecta a esa pestaña y no se guarda: una recarga con
   `?theme=amadeus` o un `theme` de R.A.M.S. lo vuelven a aplicar.

El comando `{"type":"theme","name":"none"}` (solo con `X-Source: rams`) recarga el modelo sin tema en
todos los visores conectados, pero no impide que se vuelva a aplicar después: lo permanente son los
puntos 1 y 2.
