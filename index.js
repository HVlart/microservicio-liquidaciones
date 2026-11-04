require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const { extraerLiquidacion, consultarSaldoVacaciones } = require('./playwright');
const pLimit = require('p-limit');
const limit = pLimit(3); // máximo 3 Chromium simultáneos

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
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
});

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/extraer-liquidacion', async (req, res) => {
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
  res.status(status).json({ error: status < 500 ? 'Solicitud inválida' : 'Error interno' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Microservicio corriendo en puerto ${PORT}`);
});
