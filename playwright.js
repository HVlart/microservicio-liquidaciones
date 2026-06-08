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

module.exports = { extraerLiquidacion };
