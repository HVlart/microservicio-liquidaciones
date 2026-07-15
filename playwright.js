const { chromium } = require('playwright');
const { Resend } = require('resend');
const os = require('os');
const path = require('path');
const fs = require('fs');

function renderEmailLiquidacion({ nombreTrabajador, mes, anio }) {
  const nombre = nombreTrabajador || '';
  return `
<!DOCTYPE html>
<html lang="es">
  <body style="margin:0; padding:0; background-color:#F4F4F5;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F4F4F5; padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px; width:100%; background-color:#FFFFFF; border-radius:12px; overflow:hidden;">
            <tr>
              <td align="center" style="padding:24px 24px 0 24px;">
                <img src="https://lartconsultores.cl/lc_verde.png" width="120" height="99" alt="Lart Consultores" style="display:block;">
              </td>
            </tr>
            <tr>
              <td style="padding:16px 0 0 0;">
                <div style="height:4px; line-height:4px; font-size:0; background-color:#16A34A;">&nbsp;</div>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:24px 24px 0 24px;">
                <p style="margin:0; font-size:24px; font-weight:bold; color:#0F766E; text-align:center;">
                  Tu liquidación de sueldo — ${mes} ${anio}
                </p>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:16px 24px 0 24px;">
                <span style="display:inline-block; background-color:#DCFCE7; color:#166534; font-size:13px; font-weight:bold; padding:6px 12px; border-radius:999px;">
                  📎 Este correo incluye un archivo adjunto
                </span>
                <div style="color:#16A34A; font-size:20px; font-weight:bold; margin-top:8px;">▼</div>
              </td>
            </tr>
            <tr>
              <td style="padding:24px; font-size:15px; line-height:1.5; color:#1F2937;">
                <p style="margin:0 0 16px 0;">Hola ${nombre},</p>
                <p style="margin:0 0 16px 0;">Adjunto encontrarás tu liquidación de sueldo correspondiente a <strong>${mes} ${anio}</strong>.</p>
                <p style="margin:0 0 16px 0;">Si tienes alguna consulta, no dudes en contactarnos.</p>
                <p style="margin:0;">Atentamente,<br><strong>Lart Consultores</strong></p>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:24px; border-top:1px solid #E5E7EB;">
                <img src="https://lartconsultores.cl/lc_verde.png" width="60" height="50" alt="Lart Consultores" style="display:block; opacity:0.6; margin:0 auto 12px auto;">
                <p style="margin:0 0 8px 0; font-size:12px; color:#9CA3AF; text-align:center;">
                  Este es un correo generado automáticamente por el sistema de Lart Consultores.
                </p>
                <p style="margin:0; font-size:12px; color:#9CA3AF; text-align:center;">
                  ¿No reconoces esta notificación o sientes que es un error? <a href="https://lartconsultores.cl/reporta-un-problema" style="color:#16A34A;">Contáctanos</a>
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function renderTextoLiquidacion({ nombreTrabajador, mes, anio }) {
  const nombre = nombreTrabajador || '';
  return `Hola ${nombre},

Adjunto encontrarás tu liquidación de sueldo correspondiente a ${mes} ${anio}.

Si tienes alguna consulta, no dudes en contactarnos.

Atentamente,
Lart Consultores

---
Este es un correo generado automáticamente por el sistema de Lart Consultores.
¿No reconoces esta notificación o sientes que es un error? Contáctanos: https://lartconsultores.cl/reporta-un-problema`;
}

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
      html: renderEmailLiquidacion({ nombreTrabajador: nombre_trabajador, mes: nombreMes, anio }),
      text: renderTextoLiquidacion({ nombreTrabajador: nombre_trabajador, mes: nombreMes, anio }),
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

// DIAGNÓSTICO TEMPORAL — remover una vez confirmado que el postback de #SujetoContable no se pierde
async function logOpcionSeleccionada(selectLocator, etiqueta) {
  const seleccion = await selectLocator.evaluate(el => ({
    value: el.value,
    texto: el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : null
  }));
  console.log(`DEBUG [${etiqueta}] #SujetoContable seleccionado — value: "${seleccion.value}", texto: "${seleccion.texto}"`);
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

    // DIAGNÓSTICO TEMPORAL — confirmar que la empresa seleccionada es la esperada
    await logOpcionSeleccionada(sujetoSelect, 'inmediatamente después de selectOption');

    // Esperar a que Nubox procese el postback del cambio de empresa (ASP clásico)
    await frame.locator('body').waitFor();
    await page.waitForTimeout(1500);

    // DIAGNÓSTICO TEMPORAL — confirmar que la selección se mantiene tras la espera del postback
    await logOpcionSeleccionada(sujetoSelect, 'antes de clic en Reporte Vacaciones');

    // ABRIR REPORTE VACACIONES (abre un iframe nuevo y separado)
    await frame.getByRole('link', { name: 'Reporte Vacaciones' }).click();

    await page.waitForSelector('iframe[name="remReporteVacacionesFuncionarios.asp"]', { timeout: 15000 });
    const reporteFrame = page.frameLocator('iframe[name="remReporteVacacionesFuncionarios.asp"]');

    // ESPERAR CARGA DE TABLA (queda cargando unos segundos)
    await reporteFrame.getByText('Saldo', { exact: false }).first().waitFor({ timeout: 15000 });

    // BUSCAR FILA DEL TRABAJADOR (con soporte de paginación)
    const rutNormalizado = normalizarRut(rut_trabajador);
    let filaEncontrada = null;
    const MAX_PAGINAS = 20;

    for (let pagina = 0; pagina < MAX_PAGINAS && !filaEncontrada; pagina++) {
      // Tabla de resultados: debe contener las columnas "Rut" y "Saldo" a la vez,
      // para no confundirla con el selector de empresa (#SujetoContable) u otras tablas de layout
      const tablaResultados = reporteFrame.locator('table').filter({ hasText: 'Saldo' }).filter({ hasText: 'Rut' }).first();
      const filas = tablaResultados.locator('tr');
      const totalFilas = await filas.count();
      let indicesColumnas = null;

      // DIAGNÓSTICO TEMPORAL — remover una vez resuelto el matcheo de RUT
      console.log(`DEBUG página ${pagina + 1} — filas detectadas: ${totalFilas}`);
      console.log('DEBUG rutNormalizado buscado:', rutNormalizado);
      try {
        const tablaTexto = await tablaResultados.innerText();
        console.log('DEBUG texto completo de la tabla:', tablaTexto);
      } catch (debugError) {
        console.log('DEBUG no se pudo obtener innerText de la tabla:', debugError.message);
      }

      for (let i = 0; i < totalFilas; i++) {
        const celdas = filas.nth(i).locator('th, td');
        const textosCelda = (await celdas.allTextContents()).map(t => t.trim());

        if (!indicesColumnas) {
          indicesColumnas = detectarColumnas(textosCelda);
          continue;
        }

        const rutFilaNormalizado = textosCelda[indicesColumnas.rut] ? normalizarRut(textosCelda[indicesColumnas.rut]) : null;
        console.log(`DEBUG fila ${i}: rut original="${textosCelda[indicesColumnas.rut]}" normalizado="${rutFilaNormalizado}" vs buscado="${rutNormalizado}" match=${rutFilaNormalizado === rutNormalizado}`);

        if (rutFilaNormalizado === rutNormalizado) {
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
      const siguiente = reporteFrame.getByRole('link', { name: /siguiente|next|»|›/i })
        .or(reporteFrame.getByRole('button', { name: /siguiente|next|»|›/i }));

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
