// Nubox simulado para pruebas locales. Reproduce solo lo que recorre playwright.js:
// login, menú de Remuneraciones, selector de empresa, período, colaborador, menú "Acciones"
// y la descarga del PDF. También simula la API de Resend (POST /emails).
const http = require('http');

const CREDENCIALES = { rut: '11111111-1', clave: 'clave-prueba' };
const EMPRESAS = [{ codigo: '1001', nombre: '1001 - Empresa Demo SpA' }];
const COLABORADORES = { '1001': [{ rut: '12345678-5', nombre: '12345678-5 Juana Prueba' }] };
// Liquidaciones existentes: empresa|período(MM/YYYY)|rut
const LIQUIDACIONES = new Set(['1001|10/2026|12345678-5']);

// PDF mínimo válido
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n' +
  'trailer<</Root 1 0 R>>\n%%EOF\n',
  'latin1'
);

const PAGINA_LOGIN = `<!doctype html><html><body>
<h1>Nubox simulado</h1>
<input id="rut" aria-label="Ingresa tu rut">
<input id="clave" type="password" aria-label="Ingresa tu contraseña">
<button id="ingresar">Ingresar</button>
<p id="mensaje"></p>
<script>
document.getElementById('ingresar').onclick = async () => {
  const r = await fetch('/api/login', { method: 'POST', body: JSON.stringify({
    rut: document.getElementById('rut').value, clave: document.getElementById('clave').value }) });
  if (r.ok) location.href = '/app'; else document.getElementById('mensaje').textContent = 'Credenciales inválidas';
};
</script></body></html>`;

const PAGINA_APP = `<!doctype html><html><body>
<span id="rem">Remuneraciones 2</span>
<div id="menu" hidden><button id="mov">Movimientos</button></div>
<div id="submenu" hidden><button id="liq">Liquidaciones de Sueldo</button></div>
<div id="vista" hidden>
  <div id="page-header"><input id="empresa" aria-label="Empresa"></div>
  <ul id="lista-empresas" role="listbox" hidden></ul>
  <input id="desde" aria-label="MM/YYYY"> <input id="hasta" aria-label="MM/YYYY">
  <input id="colab" aria-label="Todos los colaboradores">
  <ul id="lista-colab" role="listbox" hidden></ul>
  <div id="resultado"></div>
</div>
<script>
const $ = (id) => document.getElementById(id);
let empresa = null;
$('rem').onclick = () => { $('menu').hidden = false; };
$('mov').onclick = () => { $('submenu').hidden = false; };
$('liq').onclick = () => { $('vista').hidden = false; };
function llenar(lista, items, alElegir) {
  lista.innerHTML = '';
  for (const item of items) {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.textContent = item.nombre;
    li.onclick = () => { lista.hidden = true; alElegir(item); };
    lista.appendChild(li);
  }
  lista.hidden = false;
}
$('empresa').onclick = async () => {
  const items = await (await fetch('/api/empresas')).json();
  llenar($('lista-empresas'), items, (e) => { empresa = e.codigo; $('empresa').value = e.nombre; });
};
$('colab').onclick = async () => {
  const items = await (await fetch('/api/colaboradores?empresa=' + encodeURIComponent(empresa))).json();
  llenar($('lista-colab'), items, async (c) => {
    $('colab').value = c.nombre;
    const q = new URLSearchParams({ empresa, periodo: $('desde').value, rut: c.rut });
    const r = await (await fetch('/api/liquidacion?' + q)).json();
    $('resultado').innerHTML = r.id ? '<button id="acciones">Acciones</button>' : '<p>Sin resultados</p>';
    if (r.id) $('acciones').onclick = () => abrirMenu(r.id);
  });
};
function abrirMenu(id) {
  $('resultado').insertAdjacentHTML('beforeend',
    '<div role="menu"><div role="menuitem" id="mi-pdf" tabindex="-1">Descargar PDF</div></div>' +
    '<div id="formatos" hidden><div id="papel">Papel blanco hoja completa</div></div>' +
    '<div id="dialogo" hidden><button id="descargar">Descargar PDF</button></div>');
  $('mi-pdf').onmouseenter = () => { $('formatos').hidden = false; };
  $('papel').onclick = () => { $('dialogo').hidden = false; };
  $('descargar').onclick = () => { fetch('/reportes/liquidacion-' + id + '.pdf'); };
}
</script></body></html>`;

function crearNuboxSimulado() {
  // Escenario configurable por prueba
  const escenario = { loginStatus: 200, pdfInvalido: false };
  const correos = []; // correos recibidos por el Resend simulado
  const resend = { fallar: false };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let cuerpo = '';
    req.on('data', (c) => { cuerpo += c; });
    req.on('end', () => {
      const html = (status, contenido) => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
        res.end(contenido);
      };
      const json = (status, datos) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(datos));
      };

      if (url.pathname === '/Login') {
        if (escenario.loginStatus !== 200) return html(escenario.loginStatus, '<h1>Servicio no disponible</h1>');
        return html(200, PAGINA_LOGIN);
      }
      if (url.pathname === '/api/login') {
        const { rut, clave } = JSON.parse(cuerpo || '{}');
        const ok = rut === CREDENCIALES.rut && clave === CREDENCIALES.clave;
        return json(ok ? 200 : 401, { ok });
      }
      if (url.pathname === '/app') return html(200, PAGINA_APP);
      if (url.pathname === '/api/empresas') return json(200, EMPRESAS);
      if (url.pathname === '/api/colaboradores') {
        return json(200, COLABORADORES[url.searchParams.get('empresa')] || []);
      }
      if (url.pathname === '/api/liquidacion') {
        const clave = [url.searchParams.get('empresa'), url.searchParams.get('periodo'), url.searchParams.get('rut')].join('|');
        return json(200, LIQUIDACIONES.has(clave) ? { id: 'abc123' } : {});
      }
      if (url.pathname.startsWith('/reportes/')) {
        res.writeHead(200, { 'content-type': 'application/pdf' });
        return res.end(escenario.pdfInvalido ? '<html>Sesión expirada</html>' : PDF);
      }
      if (url.pathname === '/emails' && req.method === 'POST') {
        correos.push(JSON.parse(cuerpo));
        if (resend.fallar) return json(422, { name: 'validation_error', message: 'Fallo simulado', statusCode: 422 });
        return json(200, { id: 'correo-simulado' });
      }
      html(404, 'no encontrado');
    });
  });

  return {
    escenario,
    correos,
    resend,
    PDF,
    iniciar: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))),
    detener: () => new Promise((resolve) => server.close(resolve))
  };
}

module.exports = { crearNuboxSimulado, CREDENCIALES };
