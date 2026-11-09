# microservicio-liquidaciones

Microservicio (Railway) que entra a Nubox con Playwright para obtener documentos de
remuneraciones.

| Endpoint | Qué hace | ¿Envía correo? |
|---|---|---|
| `POST /extraer-liquidacion` | Obtiene el PDF de la liquidación de sueldo de un trabajador y período | Solo en modo `enviar` (por defecto) |
| `POST /consultar-saldo-vacaciones` | Devuelve el saldo de vacaciones (JSON) | No |
| `GET /health` | Estado del servicio | No |

`/extraer-liquidacion` es el único endpoint que obtiene un documento de Nubox y lo envía por
correo. No hay endpoint de certificado de sueldo.

Todas las rutas exigen la cabecera `x-api-key` (variable `API_SECRET_KEY`). Sin ella se
responde `401 {"error":"No autorizado","codigo":"NO_AUTORIZADO"}`.

---

## `POST /extraer-liquidacion`

El campo `modo_entrega` elige qué se hace con el PDF:

| `modo_entrega` | Comportamiento |
|---|---|
| ausente o `"enviar"` | **Comportamiento original, sin cambios.** El microservicio envía el PDF al trabajador con Resend. |
| `"devolver"` | El microservicio **solo obtiene** el PDF y lo devuelve a quien llama. **No envía correo.** Lo usa gestion-contable, que envía el correo con su propia función. |
| cualquier otro valor | `400 DATOS_INVALIDOS` |

### Modo `devolver`

#### Solicitud

```http
POST /extraer-liquidacion
x-api-key: <API_SECRET_KEY>
Content-Type: application/json

{
  "modo_entrega": "devolver",
  "rut_trabajador": "12345678-5",
  "empresa_codigo": "1001",
  "mes": 10,
  "anio": 2026
}
```

| Campo | Tipo | Obligatorio | Regla |
|---|---|---|---|
| `modo_entrega` | string | sí | `"devolver"` |
| `rut_trabajador` | string | sí | Con guion; puntos opcionales: `12345678-5` o `12.345.678-5` |
| `empresa_codigo` | string o número | sí | Código de la empresa tal como aparece en el selector de Nubox (máx. 100 caracteres) |
| `mes` | número o string | sí | Entero de 1 a 12 |
| `anio` | número o string | sí | Entero de 2000 a 2100 |

`correo_trabajador` y `nombre_trabajador` no se usan en este modo; si vienen, se ignoran.

#### Respuesta exitosa: `200`

```json
{
  "success": true,
  "modo_entrega": "devolver",
  "documento": {
    "tipo": "liquidacion_sueldo",
    "periodo": "2026-10",
    "mes": 10,
    "anio": 2026,
    "nombre_archivo": "Liquidacion_octubre_2026.pdf",
    "content_type": "application/pdf",
    "tamano_bytes": 84213,
    "sha256": "9f2c…",
    "contenido_base64": "JVBERi0xLjQK…"
  },
  "duracion_ms": 31250
}
```

- `contenido_base64`: el PDF completo en base64 estándar (RFC 4648, sin saltos de línea).
- `nombre_archivo`: el mismo nombre que hoy lleva el adjunto del modo `enviar`, para que el
  correo que envíe gestion-contable se vea igual.
- `sha256` (hex) y `tamano_bytes` se calculan sobre el PDF decodificado; sirven para verificar
  integridad o deduplicar.
- Antes de responder se verifica que el archivo descargado sea realmente un PDF (empieza con
  `%PDF-`). Si no lo es, se responde `NUBOX_NO_DISPONIBLE`.

**Por qué JSON con base64 y no binario:** una sola respuesta lleva el documento y sus
metadatos, y el éxito y los errores tienen el mismo `Content-Type`, así que quien llama hace un
único `res.json()` y decide según `success`/`codigo`, sin leer cabeceras propias. Además, las
APIs de correo (Resend incluido) reciben los adjuntos en base64, así que gestion-contable puede
pasar `contenido_base64` tal cual sin volver a codificarlo. El base64 pesa un 33 % más, lo que
para un PDF de liquidación (decenas o cientos de KB) no importa al lado de los 20 a 40 s que
toma Nubox.

#### Errores

Todos los errores del modo `devolver` tienen esta forma:

```json
{
  "success": false,
  "codigo": "DOCUMENTO_NO_ENCONTRADO",
  "error": "Nubox no muestra una liquidación para el trabajador en el período indicado",
  "reintentable": false
}
```

`codigo` es estable: es lo que debe usar gestion-contable para decidir. `error` es un texto
legible que puede cambiar. Ni la respuesta ni los logs incluyen RUT, nombres, correos ni
mensajes de Nubox.

| `codigo` | HTTP | `reintentable` | Cuándo ocurre | Qué hacer |
|---|---|---|---|---|
| `DATOS_INCOMPLETOS` | 400 | no | Falta `rut_trabajador`, `empresa_codigo`, `mes` o `anio` | Corregir la solicitud |
| `DATOS_INVALIDOS` | 400 | no | Formato inválido (RUT sin guion, mes fuera de 1-12, año fuera de rango, `modo_entrega` desconocido, JSON malformado) | Corregir la solicitud |
| `NO_AUTORIZADO` | 401 | no | `x-api-key` ausente o incorrecta | Revisar la clave |
| `EMPRESA_NO_ENCONTRADA` | 404 | no | La empresa no aparece en el selector de Nubox | Revisar `empresa_codigo` |
| `TRABAJADOR_NO_ENCONTRADO` | 404 | no | El RUT no aparece entre los colaboradores de esa empresa | Revisar RUT y empresa |
| `DOCUMENTO_NO_ENCONTRADO` | 404 | no | Nubox no muestra liquidación para ese trabajador y período | Verificar que la liquidación esté generada en Nubox |
| `NUBOX_NO_DISPONIBLE` | 502 | sí | Nubox no carga, rechaza el inicio de sesión, cambió su pantalla o entregó algo que no es un PDF | Reintentar más tarde; si persiste, revisar credenciales y Nubox |
| `SERVICIO_OCUPADO` | 503 | sí | Esperó en la cola más del máximo (ver tiempos). Incluye `Retry-After: 30` | Reintentar después de `Retry-After` |
| `TIEMPO_AGOTADO` | 504 | sí | La obtención en Nubox superó el tiempo máximo | Reintentar más tarde |
| `ERROR_INTERNO` | 500 | sí | Error no previsto del microservicio | Reintentar una vez; si persiste, revisar los logs |

Sobre los 404: el microservicio no ve un mensaje explícito de "no existe" en Nubox. Concluye
que algo no existe cuando el elemento no aparece dentro del tiempo de espera del paso (30 s
para empresa y trabajador, 15 s para la liquidación). Si Nubox está muy lento podría dar un 404
que no corresponde. Si gestion-contable sabe que el documento debería existir, conviene
reintentar una vez más tarde.

### Modo `enviar` (por defecto, sin cambios)

```json
{
  "rut_trabajador": "12345678-5",
  "empresa_codigo": "1001",
  "mes": 10,
  "anio": 2026,
  "correo_trabajador": "trabajador@example.com",
  "nombre_trabajador": "Nombre Apellido"
}
```

- Éxito: `200 {"success": true, "mensaje": "Liquidación enviada correctamente"}`
- Faltan datos: `400 {"error": "Datos incompletos"}`
- Resend no envió: `502 {"error": "CORREO_NO_ENVIADO"}`
- Otros errores: `500` (u otro código) con `{"error": "<resumen sin datos personales>"}`

Se mantiene mientras gestion-contable migra al modo `devolver`.

---

## Tiempos máximos

### Modo `devolver`: tiempo total acotado

| Etapa | Máximo | Variable | Si se supera |
|---|---|---|---|
| Espera en cola (máx. 3 Chromium simultáneos) | **30 s** | `TIEMPO_MAX_COLA_MS` | `503 SERVICIO_OCUPADO` |
| Obtención en Nubox (abrir Chromium, iniciar sesión, buscar y descargar el PDF) | **90 s** | `TIEMPO_MAX_EXTRACCION_MS` | `504 TIEMPO_AGOTADO` (se cierra Chromium y se libera el cupo) |
| **Total de la respuesta** | **≈ 121 s** (30 + 90 + ~1 s de transferencia) | | |

**gestion-contable debe configurar su timeout HTTP en al menos 125 s** (recomendado: 130 s).
Si corta antes, el microservicio lo detecta, cierra Chromium y libera el cupo, pero el
documento se pierde y hay que pedirlo de nuevo.

Duración esperada de cada respuesta. Estos valores son estimados y **no** se midieron contra
el Nubox real; salen de las esperas fijas del código más un tiempo de carga razonable de Nubox:

| Resultado | Duración típica | Por qué |
|---|---|---|
| Éxito | 20 a 40 s | ~13 s son esperas fijas del flujo (tipeo del login, 5 s por si aparece el aviso de "sesión activa", 5 s de espera del PDF); el resto depende de Nubox |
| `DATOS_*`, `NO_AUTORIZADO` | < 0,1 s | Validación sin abrir Chromium |
| `NUBOX_NO_DISPONIBLE` (Nubox no responde) | 1 a 40 s | Rápido si la conexión falla; hasta 30 s si Nubox carga pero no avanza |
| `EMPRESA_NO_ENCONTRADA` | 40 a 60 s | Login + 30 s de espera de la opción |
| `TRABAJADOR_NO_ENCONTRADO` | 45 a 70 s | Login + empresa + 30 s de espera de la opción |
| `DOCUMENTO_NO_ENCONTRADO` | 30 a 55 s | Login + selección + 15 s de espera del botón "Acciones" |
| `SERVICIO_OCUPADO` | 30 s | Tiempo máximo en cola |
| `TIEMPO_AGOTADO` | 90 s + espera en cola | Tiempo máximo de obtención |

Concurrencia: cada solicitud usa un Chromium y hay un máximo de 3 a la vez (`MAX_NAVEGADORES`).
Como una obtención dura 20 a 40 s, una cuarta solicitud simultánea puede esperar en cola más
de 30 s y recibir `SERVICIO_OCUPADO`. **gestion-contable no debería enviar más de 3 solicitudes
a la vez**; para envíos masivos conviene encolarlos de su lado y respetar `Retry-After`.

### Modo `enviar`: sin límite total

El modo `enviar` no tiene tope total (se dejó igual para no cambiar su comportamiento):

- La espera en cola no tiene límite.
- Cada acción de Playwright espera hasta 30 s (hasta 15 s el botón "Acciones"); un paso trabado
  falla a los 30 s, pero no hay tope para la suma de pasos.
- Éxito típico: igual que `devolver`, más ~1 s del envío con Resend.

---

## Variables de entorno

| Variable | Obligatoria | Por defecto | Uso |
|---|---|---|---|
| `API_SECRET_KEY` | sí | | Clave que se espera en `x-api-key` |
| `NUBOX_RUT`, `NUBOX_PASSWORD` | sí | | Credenciales de Nubox |
| `RESEND_API_KEY`, `FROM_EMAIL` | solo modo `enviar` | | Envío con Resend |
| `PORT` | no | `3000` | Puerto HTTP |
| `MAX_NAVEGADORES` | no | `3` | Chromium simultáneos |
| `TIEMPO_MAX_COLA_MS` | no | `30000` | Espera máxima en cola (modo `devolver`) |
| `TIEMPO_MAX_EXTRACCION_MS` | no | `90000` | Tiempo máximo de obtención en Nubox (modo `devolver`) |
| `NUBOX_TIMEOUT_ACCION_MS` | no | `30000` | Espera máxima por acción de Playwright (igual al valor por defecto de Playwright) |
| `NUBOX_LOGIN_URL` | no | `https://web.nubox.com/Login` | Solo para pruebas con Nubox simulado |
| `NUBOX_PDF_ORIGEN` | no | `https://app.nubox.com` | Solo para pruebas con Nubox simulado |

---

## Pruebas

```bash
npm test
```

Levantan un **Nubox simulado** y un **Resend simulado** en local (`test/nubox-simulado.js`) y
recorren el flujo real de Playwright con Chromium contra ellos. Necesitan Chromium de
Playwright (`npx playwright install chromium`). Tardan unos 2 minutos porque el flujo tiene
esperas fijas.

Las pruebas fijan todas las variables antes de cargar el microservicio. Como `dotenv` no
sobrescribe variables ya definidas, el `.env` local nunca hace que las pruebas usen el Nubox o
el Resend reales.

Qué se cubre: éxito del modo `devolver`, cada código de error (incluidos Nubox caído, conexión
rechazada, credenciales rechazadas, archivo que no es PDF, tiempo agotado, cola llena y cliente
que corta la conexión), que el modo `enviar` siga igual, y que los logs no contengan RUT,
nombres, correos ni secretos. Con `MOSTRAR_LOGS=1 npm test` se imprimen los logs capturados.
