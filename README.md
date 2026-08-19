# Registro de Producción — Control de Calidad, Armado de Válvulas

Sitio web para el registro y seguimiento de lotes de producción, con panel de indicadores de FTY (First Time Yield) por producto y por período.

## Dos pantallas con propósitos distintos

- **Registro**: pantalla minimalista de carga rápida para operarios de planta (tablet/táctil). Solo el formulario de un lote — sin filtros, sin tabla, sin distracciones.
- **Panel FTY**: pantalla de análisis para supervisores/BI. Filtros (incluyendo Estación de armado y Causa NOK-Retrabajo, cada uno un `<select>` de selección única), gauge y stats de FTY, gráficos por estación / Pareto de causas / tendencia, e Historial de lotes completo con export a Excel.

## Estructura del proyecto

```
├── index.html            # Página principal (estructura y contenido)
├── css/
│   └── style.css         # Todos los estilos del sitio
├── js/
│   ├── supabase-client.js # Inicialización del cliente de Supabase (URL + anon key)
│   └── script.js          # Toda la lógica: render, filtros, gráficos, exportación a Excel, acceso a datos
├── img/                  # Imágenes del sitio (actualmente vacía, ver nota abajo)
└── README.md
```

## Cómo desplegar

Es un sitio estático: basta con subir la carpeta completa a cualquier hosting (Netlify, Vercel, GitHub Pages, servidor propio, etc.). No requiere build ni instalación de dependencias — `index.html` enlaza `css/style.css` y `js/script.js` con rutas relativas.

## Dependencias externas (CDN)

- [Apache ECharts](https://echarts.apache.org/) 5.6.0 — todos los gráficos del panel FTY (gauge, barras, Pareto, tendencia). *(Nota: se pidió originalmente 5.5.1, pero esa versión puntual fue purgada del CDN de cdnjs — ver detalle más abajo.)*
- [SheetJS / xlsx](https://sheetjs.com/) 0.18.5 — exportación del historial a Excel.
- [jsPDF](https://github.com/parallax/jsPDF) 2.5.1 — exportación del panel como reporte PDF.
- [supabase-js](https://supabase.com/docs/reference/javascript) v2 — cliente de acceso a la base de datos.
- Google Fonts (Oswald, IBM Plex Mono, Inter) — importadas desde `css/style.css`.

## Persistencia de datos (Supabase)

Los registros se guardan en la tabla `records` del proyecto Supabase `kmgbpmyaqigfgcbhqodr`, con `operario_id` como FK a la tabla `operarios` (catálogo, no editable desde el HTML). El flujo es **append-only**: la app solo hace `select` e `insert`; no hay edición ni borrado desde la interfaz, y las políticas RLS de la tabla tampoco lo permiten.

Mapeo de campos (JS ↔ columna SQL):

| JS (camelCase)      | Columna SQL           |
|----------------------|------------------------|
| ordenTrabajo          | orden_trabajo (única)  |
| codigoProducto        | codigo_producto         |
| operarioId            | operario_id (FK)        |
| estacionArmado        | estacion_armado (enum[]) |
| causaNokRetrabajo     | causa_nok_retrabajo (enum[]) |
| comentarioCausa       | comentario_causa (obligatorio solo si causa incluye "OTROS") |
| cantidad, fecha, ok, nok, rw | (mismo nombre) |

La URL del proyecto y la `anon public key` están en `js/supabase-client.js`. La anon key está pensada para exponerse en el cliente (así funciona Supabase); la seguridad real la da RLS en la base, no el secreto de esa key.

El selector de operario (`js/script.js` → `loadOperarios()`) trae solo operarios `activo = true`, ordenados alfabéticamente, y guarda el `id` (uuid) en el registro. El nombre mostrado en el historial, panel y Excel sale de un lookup en memoria contra esa lista (`getOperarioNombre()`).

Validaciones en el frontend antes de intentar guardar (además de las que aplica la base):
- Cantidad ordenada debe ser igual a OK + NOK + Retrabajo.
- Si se marca la causa "OTROS", el comentario es obligatorio.
- La fecha de producción no puede ser futura (atributo `max` en el input, además de la constraint del backend).

Errores de guardado con mensaje específico:
- Orden de trabajo duplicada (constraint unique) → "Esa orden de trabajo ya fue cargada."
- Falla de red/servidor → "No se pudo guardar — revisá la conexión e intentá de nuevo." (el formulario **no** se limpia, para no perder lo tipeado).

Al guardar con éxito se muestra un toast ("Lote {orden} guardado correctamente") por ~2.5s y se limpia el formulario.

## Formulario de Registro: orden de campos y validación

Orden: Código de producto → N° orden de trabajo → Cantidad ordenada → Cantidad OK → Cantidad NOK → Cantidad retrabajo → *(separador visual)* → Operario (fijo, viene de la sesión) → Fecha de producción → Estación de armado → Causa NOK-Retrabajo → Comentario (si "OTROS").

- Los campos obligatorios llevan asterisco (`.req`).
- Validación en tiempo real: cada campo obligatorio se marca con borde verde/rojo (`input.valid` / `input.invalid`) después de tocarlo (blur o primer input), sin ensuciar el formulario antes de que el operario interactúe.
- Debajo de "Cantidad ordenada" se muestra en vivo la suma OK+NOK+Retrabajo (`#fCantidadCheck`), en verde si coincide o rojo si no.
- El botón "+ Guardar registro" está `disabled` hasta que todos los campos obligatorios sean válidos y la suma coincida (`updateSaveButtonState()` en `js/script.js`).
- Los campos numéricos usan `type="number" inputmode="numeric" min="0"` para forzar teclado numérico en tablet.
- **Fecha de producción**: ahora es editable (antes se autocompletaba y quedaba bloqueada), con valor por defecto = hoy y `max` = hoy.
- **Estación de armado** y **Causa NOK-Retrabajo**: pasaron de checkbox-group (selección múltiple) a `<select>` de selección única (mismo estilo que los filtros de Panel FTY). Se siguen mandando a Supabase como array (`estacionArmado`/`causaNokRetrabajo`), ahora con un solo elemento — no se tocó el esquema. Registros viejos con más de un valor en esos arrays se siguen mostrando bien en el historial y el export (esos lugares nunca asumieron un límite de elementos).

## Login (usuario = legajo, contraseña = PIN)

La app está detrás de una pantalla de login (`#loginScreen`) que tapa todo — ni Registro ni Panel FTY son accesibles sin loguearse. El login llama a `supabaseClient.rpc('login_operario', { p_legajo, p_pin })`:
- El legajo se normaliza (mayúsculas, sin espacios) antes de enviarlo.
- Si la RPC devuelve una fila, se guarda `{ operarioId, nombreCompleto }` en `sessionStorage` (se pierde al cerrar el navegador/pestaña, sobrevive un F5) y se entra a la app.
- Si no devuelve fila, un único mensaje genérico: "Usuario o contraseña incorrectos" (no distingue usuario inexistente / inactivo / PIN incorrecto, a propósito).
- Si ya hay sesión guardada en `sessionStorage` al cargar la página, se saltea el login directo a la app.
- Botón "Cerrar sesión" en el header: borra la sesión y vuelve a mostrar el login.

**Supuesto que hice sobre la forma de la fila devuelta por `login_operario`**: como no tengo la definición exacta de la RPC, `js/script.js` acepta tanto `row.id` como `row.operario_id` como el identificador del operario (`session.operarioId = row.operario_id || row.id`). Si la RPC devuelve el id con otro nombre de columna, hay que ajustar esa línea en `attemptLogin()`.

Una vez logueado, el operario **ya no se elige de un `<select>` ni se pide PIN al guardar** — el formulario de Registro muestra el nombre de la sesión como texto fijo ("Cargando como: {nombre}"), y el registro se guarda con el `operarioId` de la sesión. El modal de confirmación (`#confirmModal`) sigue mostrando el nombre del operario en el resumen, para que la persona verifique visualmente que está cargando a su propio nombre antes de guardar — pero ya no hace la verificación de PIN ahí (se hizo una sola vez, en el login). La RPC `verify_operario_pin` que se usaba antes en el modal quedó sin uso en el frontend.

El filtro "Operario" de Panel FTY (para supervisores) no se tocó — sigue siendo el `<select>` con todos los operarios activos, igual que antes.

## Rango de fechas por defecto (últimos 30 días)

`loadRecords(fromDate)` ahora pide a Supabase solo `.gte('fecha', fromDate)` — no trae toda la tabla. Al cargar la página, `fromDate` es "hoy − 30 días", y los filtros "Desde"/"Hasta" de Panel FTY arrancan pre-completados con ese rango (visible, no oculto).

- Si el usuario amplía "Desde" a una fecha más antigua que lo ya cargado, se dispara un nuevo pedido a Supabase con ese rango ampliado (`loadedFromDate` guarda el límite inferior actualmente cargado).
- "Hasta" y el resto de los filtros (Producto, Operario, Estación, Causa) se siguen aplicando en el cliente sobre lo ya traído — no generan un nuevo pedido.
- "Limpiar filtros" vuelve al rango de 30 días por defecto, no a "sin límite".
- El export a Excel exporta lo que esté filtrado/visible en ese momento; para exportar un rango mayor a 30 días hay que ampliar "Desde" primero.

## Gráficos: migración de Chart.js a ECharts

Todos los gráficos de Panel FTY se reescribieron con [Apache ECharts](https://echarts.apache.org/) en vez de Chart.js. A diferencia de Chart.js, ECharts se inicializa sobre un `<div>` con tamaño definido (`echarts.init(elemento)`), no sobre un `<canvas>` — todos los contenedores de gráficos (`#gaugeChart`, `#byEstacionChart`, `#paretoChart`, `#trendChart`) son divs.

Cada función de render (`renderGauge`, `renderByEstacionChart`, `renderParetoChart`, `renderTrendChart`) hace `instancia.dispose()` de la instancia anterior antes de recrear el div y volver a inicializar, siguiendo el mismo patrón "destruir y recrear en cada render" que ya usaba el código con Chart.js — no se acumulan instancias al cambiar filtros. Como ECharts (a diferencia de Chart.js `responsive:true`) no se auto-ajusta al redimensionar la ventana, se agregó un listener global de `resize` que llama a `.resize()` en las instancias activas.

Los colores de los gráficos (verde OK, rojo/bordó NOK, ámbar RW, gris tinta) se toman de la constante `COLORS` en `js/script.js`, que replica los mismos tonos que las variables CSS de `:root`.

### Gauge de FTY reescrito con ECharts (esto de paso resuelve el recorte)

El gauge ya no es un SVG armado a mano (el fix anterior al `viewBox` ajustaba el recorte pero seguía siendo frágil) — ahora es un `series` de tipo `'gauge'` de ECharts: semicírculo (`startAngle:180, endAngle:0`), 3 bandas de color en `axisLine` con los mismos umbrales que ya existían (`<80%` rojo/FUERA DE RANGO, `80-95%` ámbar/ACEPTABLE, `≥95%` verde/APTO), valor de %FTY en el centro (`detail`) y "% FTY" como label (`title`). El label de estado (pastilla de color con APTO/ACEPTABLE/etc.) y el sublabel de unidades evaluadas siguen siendo los mismos divs HTML de antes, debajo del gráfico — no son parte del SVG/ECharts. El contenedor del gauge pasó de ~230px a **265px de alto**, para que no quede apretado.

### FTY por estación de armado (antes: por producto)

La card "FTY POR CÓDIGO DE PRODUCTO" pasó a **"FTY POR ESTACIÓN DE ARMADO"** (`getByEstacion()` / `renderByEstacionChart()` en `js/script.js`, antes `getByProducto`/`renderByProductoChart`). El agrupamiento cambió de `codigoProducto` a cada valor de `estacionArmado`: como un registro puede tener más de una estación (es un array — sobre todo en registros viejos, cargados cuando ese campo todavía era multi-selección), cada estación presente en el registro suma su OK/NOK/RW por separado, con el mismo patrón de "expandir por elemento del array" que ya usaba el Pareto de causas. FTY% por estación = OK / (OK+NOK+RW), barras horizontales ordenadas de mayor a menor, sobre los registros ya filtrados.

### Pareto de causas NOK-Retrabajo

Sigue siendo la card "CAUSAS NOK-RETRABAJO (PARETO)", ahora con ECharts: barras (cantidad, eje Y izquierdo) + línea de % acumulado (eje Y derecho, 0-100%).

**Nota que ya venía de la iteración anterior y sigue aplicando**: el gráfico usa barras **verticales**, no horizontales. ECharts (igual que Chart.js) no combina bien un `xAxis`/`yAxis` de tipo categoría invertido (barras horizontales) con una serie de línea superpuesta en el mismo gráfico — y barras verticales + línea de acumulado es además la convención estándar de un diagrama de Pareto en control de calidad. El resto de los gráficos del panel (estación, tendencia) sí son horizontales/lineales según corresponda, sin cambios en ese aspecto.

**Fix**: el eje "Cantidad" (`yAxis[0]`) tenía `min:0` sin `max`, y con pocos datos (o un único punto) ECharts lo auto-escalaba a un rango minúsculo tipo 0–1 en vez de reflejar los conteos reales. Ahora `max` se calcula explícitamente a partir de los datos (`Math.ceil(maxCount*1.2)`, con un piso de 5) en vez de dejarlo en auto. También se movió la leyenda de `bottom` a `top` — abajo se superponía con las etiquetas rotadas del eje X en causas largas como "COMPONENTE INCORRECTO".

### Línea de meta (95%) en la tendencia de FTY

`renderTrendChart()` agrega un `markLine` punteado horizontal en `y = FTY_META` con label "Meta: 95%", color `--ink-faint` (gris, para no competir visualmente con la línea de FTY real). `FTY_META` es una constante al principio de `js/script.js` (junto a `DEFAULT_RANGE_DAYS`), fácil de encontrar y cambiar.

### Comparación contra el período anterior (gauge)

Debajo del gauge de FTY (`#gaugeComparison`) se muestra la comparación contra el "período anterior equivalente": mismo largo de días, inmediatamente antes del rango filtrado actual (`getPreviousPeriodRange()` en `js/script.js` — ej. filtro 20/07-19/08 → período anterior 19/06-19/07).

- Hace una consulta aparte a Supabase (`.gte('fecha', ...).lte('fecha', ...)`) para ese rango, y le aplica los mismos filtros no-fecha (Producto, Operario, Estación, Causa) que están activos. Para esto se extrajo `matchesNonDateFilters(r)` de la lógica de `getFiltered()` — la usan ambas funciones, no está duplicada.
- Muestra ↑ verde si el FTY actual es mayor, ↓ rojo/bordó si es menor, → gris si es igual, con el delta en puntos porcentuales. Si no hay datos del período anterior (o de la comparación actual), muestra "Sin datos del período anterior para comparar".
- Se recalcula cada vez que cambia cualquier filtro, porque `renderGauge()` (llamado desde `renderAll()`) dispara `renderPreviousPeriodComparison()` al final.
- Es asíncrono (va a la base cada vez) y tiene protección contra condiciones de carrera: si el usuario cambia de filtro mientras una consulta anterior todavía está en vuelo, esa respuesta vieja se descarta (`previousPeriodRequestId`) para no pisar el resultado del filtro más reciente.
- Si el filtro "Desde" está vacío (el usuario lo borró a mano), no hay una fecha de referencia para calcular el período anterior — no se muestra nada en vez de un dato incorrecto.

## Exportar el panel como reporte (PDF)

Botón "⬇ Exportar panel (PDF)" al lado de "⬇ Exportar a Excel", en Historial de lotes. Genera un PDF (`exportPanelPDF()` en `js/script.js`) con, en orden: título + fecha/hora de generación, resumen de filtros activos, el gauge de FTY (imagen) + OK/NOK/Retrabajo + la comparación contra el período anterior, y los gráficos de estación / tendencia (con la línea de meta) / Pareto, cada uno como imagen.

- Las imágenes de los gráficos salen de `chartInstance.getDataURL({ type:'png', backgroundColor:'#fff' })` — el método nativo de ECharts, no una captura de pantalla. Por eso las 4 instancias de ECharts (`gaugeChart`, `byEstacionChart`, `trendChart`, `paretoChart`) se guardan en variables de módulo en vez de quedar solo dentro de cada función de render.
- Si alguno de esos gráficos no tiene datos (instancia `null` — por ejemplo, "Estación de armado" quedó vacío porque ningún registro filtrado tiene esa causa/estación cargada), esa sección del PDF muestra "Sin datos para este gráfico con los filtros actuales." en vez de romperse.
- Si no hay ningún registro con los filtros actuales, no genera ningún PDF — muestra "No hay datos para exportar con los filtros actuales" en el banner de error de la página.
- Nombre del archivo: `reporte-fty-{YYYY-MM-DD}.pdf` (fecha de hoy).
- Colores del texto del PDF tomados de la misma paleta (`--steel-dark`, `--ink`, `--ink-soft`, `--ink-faint` en RGB), para que se sienta consistente con la app aunque sea un documento aparte.
- El export a Excel existente no se tocó — sigue siendo una opción aparte, no se reemplazó.

## Formulario táctil (tablet)

Inputs, selects y botones tienen un área mínima de 44×44px (WCAG). El botón "+ Guardar registro" es más grande que el resto (`min-height:52px`). Al cargar la página o volver a la pestaña Registro, el foco pasa automáticamente al primer campo (Código de producto).

## Identidad visual industrial

Se sumó iconografía SVG inline simple y sin dependencias externas: un ícono de válvula junto al título del header, íconos pequeños en las pestañas (Registro/Panel FTY), y un triángulo de advertencia (ámbar) junto al filtro "Causa NOK-Retrabajo" en Panel FTY. Paleta sin cambios (navy + blanco); el ámbar/rojo se reserva para alertas (causa NOK, campos inválidos), no para decoración.

**No se incluyó el logo real de Spirax Sarco** — no tengo el asset oficial de marca, y fabricar una versión aproximada podría representar mal la identidad de la empresa. Si me pasás el archivo del logo (SVG o PNG), lo agrego en `img/` y lo enlazo desde el header.

## ⚠️ Puntos que requieren revisión manual

- **Layout del PDF sin probar visualmente**: no pude generar y abrir un PDF real para verificar que las secciones no se superpongan, que el salto de página (`doc.addPage()`) ocurra en buenos lugares, y que las proporciones de las imágenes de los gráficos se vean bien. Conviene exportar un reporte de prueba con datos reales y revisar cada página.
- **Geometría del gauge de ECharts sin probar visualmente**: los valores de `center`/`radius`/`offsetCenter` del gauge (`renderGauge()`) son los típicos de un "half gauge" de ECharts, pero no pude abrir la app en un navegador para confirmar que el valor y el label queden perfectamente centrados dentro del semicírculo — convendría abrir Panel FTY y mirar el gauge con datos reales, y ajustar esos offsets si hace falta.
- **Nombres de operarios inactivos/eliminados**: `loadOperarios()` trae solo operarios activos, y el lookup de nombres en el historial usa esa misma lista. Si un operario que cargó lotes en el pasado se marca `activo = false` (o se borra) más adelante, sus registros históricos van a mostrar "—" en vez del nombre. Si esto importa para trazabilidad histórica, hay que traer también los inactivos para el lookup (separado de las opciones del `<select>` del formulario, que sí deben quedar restringidas a activos).
- Sigue pendiente la imagen para `og:image` (referenciada en `index.html` como `img/og-image.png`) — hay que agregar ese archivo a `img/` o quitar la meta tag.
