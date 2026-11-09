// Pruebas locales del endpoint /extraer-liquidacion contra un Nubox y un Resend simulados.
// Ejecutar con: npm test   (requiere Chromium de Playwright instalado)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { crearNuboxSimulado, CREDENCIALES } = require('./nubox-simulado');

const API_KEY = 'clave-api-pruebas';
const RUT = '12345678-5';
const CORREO = 'juana.prueba@example.com';
const NOMBRE = 'Juana Prueba';

const nubox = crearNuboxSimulado();
let baseUrl; // microservicio
let servidor;
const logs = [];

// Las variables se fijan ANTES de cargar el microservicio: dotenv no sobrescribe valores ya
// definidos, así que el .env local nunca hace que las pruebas toquen el Nubox o Resend reales.
before(async () => {
  const nuboxUrl = await nubox.iniciar();
  Object.assign(process.env, {
    API_SECRET_KEY: API_KEY,
    NUBOX_LOGIN_URL: `${nuboxUrl}/Login`,
    NUBOX_PDF_ORIGEN: nuboxUrl,
    NUBOX_RUT: CREDENCIALES.rut,
    NUBOX_PASSWORD: CREDENCIALES.clave,
    NUBOX_TIMEOUT_ACCION_MS: '2000',
    RESEND_API_KEY: 're_prueba',
    RESEND_BASE_URL: nuboxUrl,
    FROM_EMAIL: 'pruebas@example.com',
    MAX_NAVEGADORES: '1'
  });

  // Capturar logs para verificar que no contienen datos personales ni secretos
  for (const nivel of ['log', 'warn', 'error']) {
    console[nivel] = (...args) => { logs.push(args.map(String).join(' ')); };
  }

  const { app } = require('../index');
  await new Promise((resolve) => { servidor = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${servidor.address().port}`;
});

after(async () => {
  await new Promise((resolve) => servidor.close(resolve));
  await nubox.detener();
});

function reiniciarEscenario() {
  Object.assign(nubox.escenario, { loginStatus: 200, pdfInvalido: false });
  nubox.resend.fallar = false;
  process.env.NUBOX_LOGIN_URL = process.env.NUBOX_PDF_ORIGEN + '/Login';
  delete process.env.TIEMPO_MAX_EXTRACCION_MS;
  delete process.env.TIEMPO_MAX_COLA_MS;
}

async function llamar(cuerpo, { apiKey = API_KEY } = {}) {
  const inicio = Date.now();
  const res = await fetch(`${baseUrl}/extraer-liquidacion`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(apiKey ? { 'x-api-key': apiKey } : {}) },
    body: JSON.stringify(cuerpo)
  });
  const texto = await res.text();
  return { status: res.status, headers: res.headers, texto, body: JSON.parse(texto), ms: Date.now() - inicio };
}

const devolver = (extra = {}) => ({
  modo_entrega: 'devolver', rut_trabajador: RUT, empresa_codigo: '1001', mes: 10, anio: 2026, ...extra
});

function assertError(r, status, codigo, reintentable) {
  assert.equal(r.status, status, r.texto);
  assert.equal(r.body.success, false);
  assert.equal(r.body.codigo, codigo);
  assert.equal(r.body.reintentable, reintentable);
  assert.equal(typeof r.body.error, 'string');
  // Sin datos personales en la respuesta
  assert.ok(!r.texto.includes('12345678'), 'la respuesta contiene el RUT');
  assert.ok(!/\d{7,8}-[\dkK]/.test(r.texto), 'la respuesta contiene un RUT');
}

// ---------- Validación y autenticación ----------

test('sin x-api-key → 401 NO_AUTORIZADO', async () => {
  const r = await llamar(devolver(), { apiKey: null });
  assert.equal(r.status, 401);
  assert.equal(r.body.codigo, 'NO_AUTORIZADO');
});

test('devolver con datos faltantes → 400 DATOS_INCOMPLETOS', async () => {
  assertError(await llamar(devolver({ rut_trabajador: undefined })), 400, 'DATOS_INCOMPLETOS', false);
  assertError(await llamar(devolver({ mes: '' })), 400, 'DATOS_INCOMPLETOS', false);
});

test('datos con formato inválido → 400 DATOS_INVALIDOS', async () => {
  assertError(await llamar(devolver({ mes: 13 })), 400, 'DATOS_INVALIDOS', false);
  assertError(await llamar(devolver({ anio: '26' })), 400, 'DATOS_INVALIDOS', false);
  assertError(await llamar(devolver({ rut_trabajador: '123456785' })), 400, 'DATOS_INVALIDOS', false);
  assertError(await llamar(devolver({ modo_entrega: 'fax' })), 400, 'DATOS_INVALIDOS', false);
});

// ---------- Modo devolver: éxito ----------

test('devolver: éxito → 200 con el PDF en base64 y sin enviar correo', async () => {
  reiniciarEscenario();
  const correosAntes = nubox.correos.length;
  const r = await llamar(devolver({ mes: '10', anio: '2026', correo_trabajador: CORREO }));
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.body.success, true);
  assert.equal(r.body.modo_entrega, 'devolver');
  const d = r.body.documento;
  assert.equal(d.tipo, 'liquidacion_sueldo');
  assert.equal(d.periodo, '2026-10');
  assert.equal(d.mes, 10);
  assert.equal(d.anio, 2026);
  assert.equal(d.nombre_archivo, 'Liquidacion_octubre_2026.pdf');
  assert.equal(d.content_type, 'application/pdf');
  const pdf = Buffer.from(d.contenido_base64, 'base64');
  assert.ok(pdf.equals(nubox.PDF), 'el PDF devuelto no coincide con el de Nubox');
  assert.equal(d.tamano_bytes, pdf.length);
  assert.equal(d.sha256, crypto.createHash('sha256').update(pdf).digest('hex'));
  assert.equal(typeof r.body.duracion_ms, 'number');
  assert.equal(nubox.correos.length, correosAntes, 'el modo devolver no debe enviar correos');
});

// ---------- Modo devolver: errores de Nubox ----------

test('devolver: empresa inexistente → 404 EMPRESA_NO_ENCONTRADA', async () => {
  reiniciarEscenario();
  assertError(await llamar(devolver({ empresa_codigo: '9999' })), 404, 'EMPRESA_NO_ENCONTRADA', false);
});

test('devolver: trabajador inexistente → 404 TRABAJADOR_NO_ENCONTRADO', async () => {
  reiniciarEscenario();
  assertError(await llamar(devolver({ rut_trabajador: '11222333-9' })), 404, 'TRABAJADOR_NO_ENCONTRADO', false);
});

test('devolver: período sin liquidación → 404 DOCUMENTO_NO_ENCONTRADO', async () => {
  reiniciarEscenario();
  assertError(await llamar(devolver({ mes: 9 })), 404, 'DOCUMENTO_NO_ENCONTRADO', false);
});

test('devolver: Nubox responde 503 → 502 NUBOX_NO_DISPONIBLE', async () => {
  reiniciarEscenario();
  nubox.escenario.loginStatus = 503;
  assertError(await llamar(devolver()), 502, 'NUBOX_NO_DISPONIBLE', true);
});

test('devolver: Nubox inaccesible (conexión rechazada) → 502 NUBOX_NO_DISPONIBLE', async () => {
  reiniciarEscenario();
  // Puerto que estuvo libre: nadie escucha ahí, la conexión se rechaza.
  const libre = require('node:net').createServer();
  await new Promise((r) => libre.listen(0, '127.0.0.1', r));
  const puerto = libre.address().port;
  await new Promise((r) => libre.close(r));
  process.env.NUBOX_LOGIN_URL = `http://127.0.0.1:${puerto}/Login`;
  // En Windows el rechazo tarda ~2 s (reintentos de TCP): se amplía el timeout para que el
  // error sea el rechazo de conexión y no un timeout de navegación.
  process.env.NUBOX_TIMEOUT_ACCION_MS = '6000';
  try {
    assertError(await llamar(devolver()), 502, 'NUBOX_NO_DISPONIBLE', true);
    assert.ok(logs.some((l) => l.includes('ERR_CONNECTION_REFUSED')), 'no se registró el rechazo de conexión');
  } finally {
    process.env.NUBOX_TIMEOUT_ACCION_MS = '2000';
  }
});

test('devolver: Nubox rechaza las credenciales → 502 NUBOX_NO_DISPONIBLE', async () => {
  reiniciarEscenario();
  const original = process.env.NUBOX_PASSWORD;
  process.env.NUBOX_PASSWORD = 'clave-incorrecta';
  try {
    assertError(await llamar(devolver()), 502, 'NUBOX_NO_DISPONIBLE', true);
  } finally {
    process.env.NUBOX_PASSWORD = original;
  }
});

test('devolver: Nubox entrega algo que no es PDF → 502 NUBOX_NO_DISPONIBLE', async () => {
  reiniciarEscenario();
  nubox.escenario.pdfInvalido = true;
  assertError(await llamar(devolver()), 502, 'NUBOX_NO_DISPONIBLE', true);
});

// ---------- Modo devolver: tiempos ----------

test('devolver: extracción excede el tiempo máximo → 504 TIEMPO_AGOTADO a tiempo', async () => {
  reiniciarEscenario();
  process.env.TIEMPO_MAX_EXTRACCION_MS = '3000';
  const r = await llamar(devolver());
  assertError(r, 504, 'TIEMPO_AGOTADO', true);
  assert.ok(r.ms < 4500, `respondió en ${r.ms} ms; debía cortar cerca de 3000 ms`);
});

test('devolver: cola llena más allá del máximo → 503 SERVICIO_OCUPADO; luego el cupo se libera', async () => {
  reiniciarEscenario();
  // MAX_NAVEGADORES=1: la primera solicitud ocupa el único cupo.
  // (Esto también comprueba que la prueba de TIEMPO_AGOTADO liberó su cupo al cerrar Chromium.)
  const primera = llamar(devolver());
  await new Promise((r) => setTimeout(r, 200));
  process.env.TIEMPO_MAX_COLA_MS = '500';
  const segunda = await llamar(devolver());
  assertError(segunda, 503, 'SERVICIO_OCUPADO', true);
  assert.equal(segunda.headers.get('retry-after'), '30');
  assert.ok(segunda.ms < 2000, `respondió en ${segunda.ms} ms; debía cortar cerca de 500 ms`);
  const r1 = await primera;
  assert.equal(r1.status, 200, r1.texto);
});

test('devolver: si quien llama corta la conexión, se cierra Chromium y se libera el cupo', async () => {
  reiniciarEscenario();
  const corte = new AbortController();
  const inicio = Date.now();
  const llamada = fetch(`${baseUrl}/extraer-liquidacion`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify(devolver()),
    signal: corte.signal
  }).catch(() => 'cortada');
  setTimeout(() => corte.abort(), 1000);
  assert.equal(await llamada, 'cortada');
  // Con MAX_NAVEGADORES=1, una nueva solicitud solo obtiene cupo si la anterior lo liberó.
  process.env.TIEMPO_MAX_COLA_MS = '3000';
  const r = await llamar(devolver({ empresa_codigo: '9999' }));
  assertError(r, 404, 'EMPRESA_NO_ENCONTRADA', false);
  assert.ok(Date.now() - inicio < 15000, 'la solicitud cortada siguió ocupando el cupo');
  assert.ok(logs.some((l) => l.includes('devolver error codigo=CLIENTE_DESCONECTADO')));
});

// ---------- Modo enviar (por defecto): sin cambios ----------

test('enviar (por defecto): obtiene el PDF y lo envía por Resend como antes', async () => {
  reiniciarEscenario();
  const correosAntes = nubox.correos.length;
  const r = await llamar({
    rut_trabajador: RUT, empresa_codigo: '1001', mes: 10, anio: 2026,
    correo_trabajador: CORREO, nombre_trabajador: NOMBRE
  });
  assert.equal(r.status, 200, r.texto);
  assert.deepEqual(r.body, { success: true, mensaje: 'Liquidación enviada correctamente' });
  assert.equal(nubox.correos.length, correosAntes + 1);
  const correo = nubox.correos.at(-1);
  assert.deepEqual([].concat(correo.to), [CORREO]);
  assert.equal(correo.subject, 'Tu liquidación de sueldo — octubre 2026');
  assert.equal(correo.attachments[0].filename, 'Liquidacion_octubre_2026.pdf');
  assert.ok(Buffer.from(correo.attachments[0].content, 'base64').equals(nubox.PDF));
});

test('enviar: si Resend falla → 502 CORREO_NO_ENVIADO (como antes)', async () => {
  reiniciarEscenario();
  nubox.resend.fallar = true;
  const r = await llamar({
    modo_entrega: 'enviar', rut_trabajador: RUT, empresa_codigo: '1001', mes: 10, anio: 2026,
    correo_trabajador: CORREO
  });
  assert.equal(r.status, 502);
  assert.deepEqual(r.body, { error: 'CORREO_NO_ENVIADO' });
});

test('enviar: sin correo → 400 "Datos incompletos" (como antes)', async () => {
  const r = await llamar({ rut_trabajador: RUT, empresa_codigo: '1001', mes: 10, anio: 2026 });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, { error: 'Datos incompletos' });
});

// ---------- Logs ----------

test('los logs no contienen datos personales ni secretos', () => {
  assert.ok(logs.length > 0);
  const todo = logs.join('\n');
  if (process.env.MOSTRAR_LOGS) process.stdout.write(`\n--- logs capturados ---\n${todo}\n`);
  for (const prohibido of ['12345678', '12.345.678', '11222333', CORREO, NOMBRE, 'Juana',
    CREDENCIALES.rut, CREDENCIALES.clave, 'clave-incorrecta', API_KEY, 're_prueba']) {
    assert.ok(!todo.includes(prohibido), `los logs contienen "${prohibido}"`);
  }
  // Los errores del modo devolver se registran con su código
  assert.match(todo, /devolver error codigo=EMPRESA_NO_ENCONTRADA/);
  assert.match(todo, /devolver error codigo=TIEMPO_AGOTADO/);
});
