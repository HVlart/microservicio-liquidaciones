// Catálogo de errores del modo de entrega "devolver".
// Los códigos son parte del contrato con gestion-contable: no renombrarlos ni reutilizarlos.
// Los mensajes son textos fijos; nunca se arman con datos de la solicitud ni con mensajes
// de Playwright, para que la respuesta no pueda contener RUT, nombres ni correos.
const CATALOGO = {
  DATOS_INCOMPLETOS: {
    status: 400,
    reintentable: false,
    mensaje: 'Faltan datos obligatorios: rut_trabajador, empresa_codigo, mes y anio'
  },
  DATOS_INVALIDOS: {
    status: 400,
    reintentable: false,
    mensaje: 'Algún dato tiene un formato inválido'
  },
  NO_AUTORIZADO: {
    status: 401,
    reintentable: false,
    mensaje: 'No autorizado'
  },
  EMPRESA_NO_ENCONTRADA: {
    status: 404,
    reintentable: false,
    mensaje: 'La empresa no aparece en Nubox para la cuenta configurada'
  },
  TRABAJADOR_NO_ENCONTRADO: {
    status: 404,
    reintentable: false,
    mensaje: 'El trabajador no aparece en la empresa indicada en Nubox'
  },
  DOCUMENTO_NO_ENCONTRADO: {
    status: 404,
    reintentable: false,
    mensaje: 'Nubox no muestra una liquidación para el trabajador en el período indicado'
  },
  NUBOX_NO_DISPONIBLE: {
    status: 502,
    reintentable: true,
    mensaje: 'Nubox no respondió como se esperaba (caído, rechazó el acceso o entregó un documento inválido)'
  },
  SERVICIO_OCUPADO: {
    status: 503,
    reintentable: true,
    mensaje: 'El microservicio está procesando otras solicitudes; reintentar más tarde'
  },
  TIEMPO_AGOTADO: {
    status: 504,
    reintentable: true,
    mensaje: 'La obtención del documento superó el tiempo máximo permitido'
  },
  ERROR_INTERNO: {
    status: 500,
    reintentable: true,
    mensaje: 'Error interno del microservicio'
  }
};

// Segundos sugeridos en la cabecera Retry-After para SERVICIO_OCUPADO.
const REINTENTAR_DESPUES_S = 30;

function crearError(codigo) {
  const error = new Error(codigo);
  error.codigo = codigo;
  return error;
}

function responderError(res, codigo) {
  const codigoFinal = CATALOGO[codigo] ? codigo : 'ERROR_INTERNO';
  const { status, reintentable, mensaje } = CATALOGO[codigoFinal];
  if (codigoFinal === 'SERVICIO_OCUPADO') {
    res.set('Retry-After', String(REINTENTAR_DESPUES_S));
  }
  return res.status(status).json({
    success: false,
    codigo: codigoFinal,
    error: mensaje,
    reintentable
  });
}

module.exports = { CATALOGO, crearError, responderError };
