require('dotenv').config();
const express = require('express');
const { extraerLiquidacion } = require('./playwright');
const pLimit = require('p-limit');
const limit = pLimit(3); // máximo 3 Chromium simultáneos

const app = express();
app.use(express.json());

// Middleware de autenticación simple
app.use((req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  console.log('API Key recibida:', JSON.stringify(apiKey));
  console.log('API Key esperada:', JSON.stringify(process.env.API_SECRET_KEY));
  if (apiKey !== process.env.API_SECRET_KEY) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
});

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
    console.error('Error en extracción:', error.message);
    res.status(500).json({ error: error.message || 'Error al procesar la liquidación' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Microservicio corriendo en puerto ${PORT}`);
});
