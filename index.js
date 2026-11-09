require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const { extraerLiquidacion, obtenerLiquidacion, consultarSaldoVacaciones } = require('./playwright');
const { crearError, responderError } = require('./errores');
const pLimit = require('p-limit');
const limit = pLimit(Number(process.env.MAX_NAVEGADORES) || 3); // máximo 3 Chromium simultáneos

// Tiempos máximos del modo "devolver" (ver README, sección "Tiempos máximos").
const TIEMPO_MAX_COLA_DEFECTO_MS = 30000;
const TIEMPO_MAX_EXTRACCION_DEFECTO_MS = 90000;

function tiemposDevolver() {
  return {
    colaMs: Number(process.env.TIEMPO_MAX_COLA_MS) || TIEMPO_MAX_COLA_DEFECTO_MS,
    extraccionMs: Number(process.env.TIEMPO_MAX_EXTRACCION_MS) || TIEMPO_MAX_EXTRACCION_DEFECTO_MS
  };
}

const MODOS_ENTREGA = ['enviar', 'devolver'];

const app = express();
app.set('trust proxy', 1); // Railway antepone un proxy; sin esto req.ip sería la IP del proxy

// Compara en tiempo constante. Se comparan los SHA-256 porque timingSafeEqual exige
// buffers del mismo largo y así tampoco se revela el largo de la clave.
// Si API_SECRET_KEY no está configurada se rechaza todo.
function claveValida(recibida, esperada) {
  if (typeof recibida !== 'string' || !esperada) return false;
  const hashRecibida = crypto.createHash('sha256').update(recibida).digest();
  const hashEsperada = crypto.createHash('sha256').update(esperada).digest();
  return crypto.timingSafeEqual(hashRecibida, hashEsperada);
}

// Los mensajes de Playwright incluyen localizadores (con el RUT) y HTML de la página
// (con nombres de trabajadores). Solo se conserva la primera línea, sin RUT, correos ni URLs.
function resumirError(error) {
  return String(error?.message || '')
    .split('\n')[0]
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/\S+@\S+/g, '[correo]')
    .replace(/\d{1,2}\.?\d{3}\.?\d{3}(-?[\dkK])?/g, '[rut]');
}

// Middleware de autenticación simple. Va antes de express.json() para no procesar
// cuerpos de solicitudes no autenticadas. Nunca registrar el valor de la clave.
app.use((req, res, next) => {
  if (!claveValida(req.headers['x-api-key'], process.env.API_SECRET_KEY)) {
    console.warn(`autenticación fallida ip=${req.ip} hora=${new Date().toISOString()}`);
    return res.status(401).json({ success: false, error: 'No autorizado', codigo: 'NO_AUTORIZADO', reintentable: false });
  }
  next();
});

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// RUT con guion obligatorio (el selector de Nubox busca por la parte antes del guion).
const RUT_VALIDO = /^\d{1,2}\.?\d{3}\.?\d{3}-[\dkK]$/;

function enteroEnRango(valor, min, max) {
  if (typeof valor !== 'number' && typeof valor !== 'string') return null;
  if (typeof valor === 'string' && !/^\d+$/.test(valor.trim())) return null;
  const numero = Number(valor);
  return Number.isInteger(numero) && numero >= min && numero <= max ? numero : null;
}

// Modo "devolver": obtiene el PDF y lo responde en JSON (base64) sin enviar correo.
async function devolverLiquidacion(req, res) {
  const inicio = Date.now();
  const { rut_trabajador, empresa_codigo, mes, anio } = req.body;

  const vacio = (v) => v === undefined || v === null || v === '';
  if ([rut_trabajador, empresa_codigo, mes, anio].some(vacio)) {
    return responderError(res, 'DATOS_INCOMPLETOS');
  }

  const mesNum = enteroEnRango(mes, 1, 12);
  const anioNum = enteroEnRango(anio, 2000, 2100);
  const empresaValida = (typeof empresa_codigo === 'string' || typeof empresa_codigo === 'number')
    && String(empresa_codigo).length <= 100;
  if (typeof rut_trabajador !== 'string' || !RUT_VALIDO.test(rut_trabajador.trim())
      || !empresaValida || mesNum === null || anioNum === null) {
    return responderError(res, 'DATOS_INVALIDOS');
  }

  const empresa = String(empresa_codigo);
  const periodo = `${anioNum}-${String(mesNum).padStart(2, '0')}`;
  const tiempos = tiemposDevolver();

  // Un único AbortController para los tres motivos de corte: espera en cola excedida,
  // extracción excedida o cliente desconectado. Al abortar se cierra Chromium y se libera el cupo.
  const controller = new AbortController();
  const abortar = (codigo) => { if (!controller.signal.aborted) controller.abort(crearError(codigo)); };
  res.on('close', () => { if (!res.writableEnded) abortar('CLIENTE_DESCONECTADO'); });

  const timerCola = setTimeout(() => abortar('SERVICIO_OCUPADO'), tiempos.colaMs);
  let timerExtraccion = null;

  const tarea = limit(async () => {
    clearTimeout(timerCola);
    // Si se abortó mientras esperaba en cola, se libera el cupo sin abrir Chromium.
    if (controller.signal.aborted) throw controller.signal.reason;
    timerExtraccion = setTimeout(() => abortar('TIEMPO_AGOTADO'), tiempos.extraccionMs);
    return obtenerLiquidacion({
      rut_trabajador: rut_trabajador.trim(),
      empresa_codigo: empresa,
      mes: mesNum,
      anio: anioNum,
      signal: controller.signal
    });
  });

  // Responder apenas se aborte, sin esperar a que la tarea termine de cerrar el navegador.
  const corte = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
  });
  tarea.catch(() => {});
  corte.catch(() => {});

  try {
    const { pdf, nombre_archivo } = await Promise.race([tarea, corte]);
    const duracion_ms = Date.now() - inicio;
    console.log(`devolver ok empresa=${empresa} periodo=${periodo} bytes=${pdf.length} ms=${duracion_ms}`);
    res.json({
      success: true,
      modo_entrega: 'devolver',
      documento: {
        tipo: 'liquidacion_sueldo',
        periodo,
        mes: mesNum,
        anio: anioNum,
        nombre_archivo,
        content_type: 'application/pdf',
        tamano_bytes: pdf.length,
        sha256: crypto.createHash('sha256').update(pdf).digest('hex'),
        contenido_base64: pdf.toString('base64')
      },
      duracion_ms
    });
  } catch (error) {
    const codigo = error?.codigo || 'ERROR_INTERNO';
    console.error(`devolver error codigo=${codigo} empresa=${empresa} periodo=${periodo} ms=${Date.now() - inicio} detalle=${resumirError(error)}`);
    if (codigo === 'CLIENTE_DESCONECTADO' || res.headersSent) return;
    responderError(res, codigo);
  } finally {
    clearTimeout(timerCola);
    clearTimeout(timerExtraccion);
  }
}

app.post('/extraer-liquidacion', async (req, res) => {
  const modoEntrega = req.body?.modo_entrega ?? 'enviar';
  if (!MODOS_ENTREGA.includes(modoEntrega)) {
    return responderError(res, 'DATOS_INVALIDOS');
  }
  if (modoEntrega === 'devolver') {
    return devolverLiquidacion(req, res);
  }

  // Modo "enviar" (por defecto): comportamiento original, sin cambios.
  const { rut_trabajador, empresa_codigo, mes, anio, correo_trabajador, nombre_trabajador } = req.body;

  if (!rut_trabajador || !empresa_codigo || !mes || !anio || !correo_trabajador) {
    return res.status(400).json({ error: 'Datos incompletos' });
  }

  try {
    await limit(() =>
      extraerLiquidacion({
        rut_trabajador,
        empresa_codigo,
        mes,
        anio,
        correo_trabajador,
        nombre_trabajador
      })
    );
    res.json({ success: true, mensaje: 'Liquidación enviada correctamente' });
  } catch (error) {
    const mensaje = resumirError(error);
    console.error('Error en extracción:', mensaje);
    const status = error.statusCode || 500;
    res.status(status).json({ error: mensaje || 'Error al procesar la liquidación' });
  }
});

app.post('/consultar-saldo-vacaciones', async (req, res) => {
  const { rut_trabajador, numero_cliente } = req.body;

  if (!rut_trabajador || !numero_cliente) {
    return res.status(400).json({ error: 'Datos incompletos' });
  }

  try {
    const resultado = await limit(() =>
      consultarSaldoVacaciones({ rut_trabajador, numero_cliente })
    );
    res.json(resultado);
  } catch (error) {
    const mensaje = resumirError(error);
    console.error('Error al consultar saldo de vacaciones:', mensaje);
    const status = error.statusCode || 500;
    res.status(status).json({ error: mensaje || 'Error al consultar el saldo de vacaciones' });
  }
});

// Reemplaza el manejador por defecto de Express, que escribe err.stack en los logs: en un
// JSON malformado ese texto incluye un fragmento del cuerpo (RUT, correo). Solo se registra el tipo.
app.use((err, req, res, next) => {
  const status = err.status || 500;
  console.error('Error en solicitud:', err.type || err.name);
  res.status(status).json({
    error: status < 500 ? 'Solicitud inválida' : 'Error interno',
    codigo: status < 500 ? 'DATOS_INVALIDOS' : 'ERROR_INTERNO',
    success: false,
    reintentable: status >= 500
  });
});

// Solo escucha al ejecutarse directamente (npm start); las pruebas importan `app`.
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Microservicio corriendo en puerto ${PORT}`);
  });
}

module.exports = { app };
