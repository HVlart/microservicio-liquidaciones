const { chromium } = require('playwright');
const { Resend } = require('resend');
const os = require('os');
const path = require('path');
const fs = require('fs');

async function extraerLiquidacion({ rut_trabajador, empresa_codigo, mes, anio, correo_trabajador, nombre_trabajador }) {
  const resend = new Resend(process.env.RESEND_API_KEY);

  const mesFormateado = String(mes).padStart(2, '0');
  const periodo = `${mesFormateado}/${anio}`;

  const browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  // Capturar la URL del PDF monitoreando las responses
  let pdfUrl = null;
  page.on('response', async (response) => {
    const contentType = response.headers()['content-type'] || '';
    const url = response.url();
    if (
      (contentType.includes('application/pdf') || url.includes('.pdf')) &&
      url.startsWith('https://app.nubox.com')
    ) {
      console.log('PDF URL capturada:', url);
      pdfUrl = url;
    }
  });

  try {
    console.log(`Iniciando extracción: ${rut_trabajador} | ${empresa_codigo} | ${periodo}`);

    // LOGIN
    await page.goto('https://web.nubox.com/Login');

    // Escribir RUT simulando tipeo real para que Nubox habilite el botón
    await page.getByRole('textbox', { name: 'Ingresa tu rut' }).click();
    await page.getByRole('textbox', { name: 'Ingresa tu rut' }).type(process.env.NUBOX_RUT, { delay: 100 });

    // Click en contraseña y escribir
    await page.getByRole('textbox', { name: 'Ingresa tu contraseña' }).click();
    await page.getByRole('textbox', { name: 'Ingresa tu contraseña' }).type(process.env.NUBOX_PASSWORD, { delay: 100 });

    // Esperar que el botón se habilite
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: 'Ingresar' }).click();

    // Manejar sesión activa — opcional
    try {
      await page.getByRole('button', { name: 'Acceder de todas formas' }).waitFor({ timeout: 5000 });
      await page.getByRole('button', { name: 'Acceder de todas formas' }).click();
    } catch {
      // No apareció, continuar normal
    }

    // NAVEGAR A LIQUIDACIONES
    await page.getByText('Remuneraciones 2').click();
    await page.getByRole('button', { name: 'Movimientos' }).first().click();
    await page.getByRole('button', { name: 'Liquidaciones de Sueldo' }).click();

    // SELECCIONAR EMPRESA
    await page.locator('#page-header').getByRole('textbox').click();
    await page.getByRole('option', { name: new RegExp(empresa_codigo, 'i') }).click();

    // FILTRAR PERÍODO
    await page.getByRole('textbox', { name: 'MM/YYYY' }).first().fill(periodo);
    await page.keyboard.press('Enter');
    await page.getByRole('textbox', { name: 'MM/YYYY' }).nth(1).fill(periodo);
    await page.keyboard.press('Enter');

    // SELECCIONAR COLABORADOR
    await page.getByRole('textbox', { name: 'Todos los colaboradores' }).click();
    await page.getByRole('option', { name: new RegExp(rut_trabajador.split('-')[0], 'i') }).click();

    // ESPERAR BOTÓN ACCIONES
    await page.getByRole('button', { name: 'Acciones' }).waitFor({ timeout: 15000 });

    // ABRIR MENÚ Y DESCARGAR PDF
    await page.getByRole('button', { name: 'Acciones' }).click();
    await page.getByRole('menuitem', { name: 'Descargar PDF' }).hover();
    await page.waitForTimeout(500);
    await page.getByText('Papel blanco hoja completa').click();
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: 'Descargar PDF' }).click();

    // Esperar que se capture la URL del PDF
    await page.waitForTimeout(5000);

    if (!pdfUrl) {
      throw new Error('No se pudo capturar la URL del PDF');
    }

    // Descargar el PDF usando la URL capturada con las cookies de sesión
    const pdfResponse = await page.request.get(pdfUrl);
    const pdfBuffer = await pdfResponse.body();

    console.log(`PDF descargado: ${pdfBuffer.length} bytes`);

    const pdfBase64 = pdfBuffer.toString('base64');
    const nombreMes = new Intl.DateTimeFormat('es-CL', { month: 'long' }).format(new Date(anio, mes - 1));

    // ENVIAR CORREO
    await resend.emails.send({
      from: process.env.FROM_EMAIL,
      to: correo_trabajador,
      subject: `Tu liquidación de sueldo — ${nombreMes} ${anio}`,
      html: `
        <p>Hola ${nombre_trabajador || ''},</p>
        <p>Adjunto encontrarás tu liquidación de sueldo correspondiente a <strong>${nombreMes} ${anio}</strong>.</p>
        <p>Si tienes alguna consulta, no dudes en contactarnos.</p>
        <br>
        <p>Saludos,<br><strong>Lart Consultores</strong></p>
      `,
      attachments: [
        {
          filename: `Liquidacion_${nombreMes}_${anio}.pdf`,
          content: pdfBase64,
        }
      ]
    });

    console.log(`Correo enviado a ${correo_trabajador}`);

  } finally {
    await browser.close();
  }
}

function normalizarRut(rut) {
  return String(rut).replace(/\./g, '').replace(/-/g, '').trim().toUpperCase();
}

function quitarAcentos(texto) {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function parsearNumero(texto) {
  return parseFloat(String(texto).replace(',', '.'));
}

function detectarColumnas(textosFila) {
  const normalizados = textosFila.map(t => quitarAcentos(t).toLowerCase());
  const idxRut = normalizados.findIndex(t => t.includes('rut'));
  const idxDisponibles = normalizados.findIndex(t => t.includes('disponible'));
  const idxUsados = normalizados.findIndex(t => t.includes('usado'));
  const idxSaldo = normalizados.findIndex(t => t.includes('saldo'));

  if (idxRut === -1 || idxDisponibles === -1 || idxUsados === -1 || idxSaldo === -1) {
    return null;
  }

  return { rut: idxRut, disponibles: idxDisponibles, usados: idxUsados, saldo: idxSaldo };
}

async function consultarSaldoVacaciones({ rut_trabajador, numero_cliente }) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log(`Consultando saldo de vacaciones: ${rut_trabajador} | ${numero_cliente}`);

    // LOGIN
    await page.goto('https://web.nubox.com/Login');

    await page.getByRole('textbox', { name: 'Ingresa tu rut' }).click();
    await page.getByRole('textbox', { name: 'Ingresa tu rut' }).type(process.env.NUBOX_RUT, { delay: 100 });

    await page.getByRole('textbox', { name: 'Ingresa tu contraseña' }).click();
    await page.getByRole('textbox', { name: 'Ingresa tu contraseña' }).type(process.env.NUBOX_PASSWORD, { delay: 100 });

    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: 'Ingresar' }).click();

    // Manejar sesión activa — opcional
    try {
      await page.getByRole('button', { name: 'Acceder de todas formas' }).waitFor({ timeout: 5000 });
      await page.getByRole('button', { name: 'Acceder de todas formas' }).click();
    } catch {
      // No apareció, continuar normal
    }

    // NAVEGAR A COMPROBANTES DE FERIADOS
    await page.getByText('Remuneraciones 2').click();
    await page.getByRole('button', { name: 'Movimientos' }).first().click();
    await page.getByRole('button', { name: 'Comprobantes de Feriados' }).click();

    const frame = page.frameLocator('iframe[name="remMovimientosComprobanteFeriado.asp"]');

    // SELECCIONAR EMPRESA (SujetoContable)
    const sujetoSelect = frame.locator('#SujetoContable');
    await sujetoSelect.waitFor({ timeout: 15000 });

    const opciones = sujetoSelect.locator('option');
    const textosOpciones = await opciones.allTextContents();
    const indiceMatch = textosOpciones.findIndex(t => t.trim().startsWith(numero_cliente));

    if (indiceMatch === -1) {
      throw new Error(`Empresa no encontrada en Nubox: ${numero_cliente}`);
    }

    const valorMatch = await opciones.nth(indiceMatch).getAttribute('value');
    await sujetoSelect.selectOption(valorMatch);

    // ABRIR REPORTE VACACIONES
    await frame.getByRole('link', { name: 'Reporte Vacaciones' }).click();

    // DIAGNÓSTICO TEMPORAL — remover una vez identificado el frame del reporte
    await page.waitForTimeout(3000);
    console.log('DEBUG frames:', JSON.stringify(page.frames().map(f => ({ name: f.name(), url: f.url() }))));
    console.log('DEBUG page.title():', await page.title());
    try {
      await page.screenshot({ path: '/tmp/debug-vacaciones.png' });
      console.log('DEBUG screenshot guardado en /tmp/debug-vacaciones.png');
    } catch (screenshotError) {
      console.log('DEBUG screenshot falló:', screenshotError.message);
    }

    // ESPERAR CARGA DE TABLA (queda cargando unos segundos)
    await frame.getByText('Saldo', { exact: false }).first().waitFor({ timeout: 15000 });

    // BUSCAR FILA DEL TRABAJADOR (con soporte de paginación)
    const rutNormalizado = normalizarRut(rut_trabajador);
    let filaEncontrada = null;
    const MAX_PAGINAS = 20;

    for (let pagina = 0; pagina < MAX_PAGINAS && !filaEncontrada; pagina++) {
      const filas = frame.locator('table tr');
      const totalFilas = await filas.count();
      let indicesColumnas = null;

      for (let i = 0; i < totalFilas; i++) {
        const celdas = filas.nth(i).locator('th, td');
        const textosCelda = (await celdas.allTextContents()).map(t => t.trim());

        if (!indicesColumnas) {
          indicesColumnas = detectarColumnas(textosCelda);
          continue;
        }

        if (textosCelda[indicesColumnas.rut] && normalizarRut(textosCelda[indicesColumnas.rut]) === rutNormalizado) {
          filaEncontrada = {
            dias_acumulados: parsearNumero(textosCelda[indicesColumnas.disponibles]),
            dias_utilizados: parsearNumero(textosCelda[indicesColumnas.usados]),
            saldo_antes: parsearNumero(textosCelda[indicesColumnas.saldo]),
          };
          break;
        }
      }

      if (filaEncontrada) break;

      // Verificar si existe paginación
      const siguiente = frame.getByRole('link', { name: /siguiente|next|»|›/i })
        .or(frame.getByRole('button', { name: /siguiente|next|»|›/i }));

      const haySiguiente = await siguiente.count();
      if (haySiguiente === 0) break;

      const disabled = await siguiente.first().getAttribute('disabled');
      if (disabled !== null) break;

      await siguiente.first().click();
      await page.waitForTimeout(1000);
    }

    if (!filaEncontrada) {
      const error = new Error('Trabajador no encontrado en el reporte de vacaciones de Nubox');
      error.statusCode = 404;
      throw error;
    }

    console.log(`Saldo de vacaciones encontrado para ${rut_trabajador}`);

    return {
      ...filaEncontrada,
      consultado_en: new Date().toISOString()
    };

  } finally {
    await browser.close();
  }
}

module.exports = { extraerLiquidacion, consultarSaldoVacaciones };
