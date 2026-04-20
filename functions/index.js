const admin = require("firebase-admin");
const logger = require("firebase-functions/logger");
const { defineSecret } = require("firebase-functions/params");
const { onDocumentCreated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const { google } = require("googleapis");
const webpush = require("web-push");

admin.initializeApp();

const db = admin.firestore();
const REGION = "southamerica-east1";
const DEFAULT_PANEL_URL = "https://jazz-cinnamon-erp.web.app/painel_erp.html";
const DEFAULT_VAPID_SUBJECT = "mailto:luciano.cinnamon@gmail.com";
const NOTIFICATION_ICON_URL = "https://firebasestorage.googleapis.com/v0/b/jazz-cinnamon-erp.firebasestorage.app/o/BOTAO%20ERP.png?alt=media";
const URL_BACKEND = "https://script.google.com/macros/s/AKfycbx9NsoG0R-NNtbECB-Qw96YDcZaexKDmbfH90vIiXzwElYALIJBO5NdUC9tCuO4AXUh/exec";
const VAPID_PRIVATE_KEY_SECRET = defineSecret("VAPID_PRIVATE_KEY");
const DEFAULT_CALENDAR_ID = "77ee282b8071d0ae9ed2cfb27ef8260acb93c76bc27dc96a2efc60cf32445e43@group.calendar.google.com";
const CALENDAR_TIME_ZONE = "America/Sao_Paulo";
const ADMIN_EMAILS = ["luciano.cinnamon@gmail.com"];

const STATUS_AGENDA = {
  PRE_RESERVA: { sufixo: "PRE-RESERVA", colorId: "7" },
  RESERVA: { sufixo: "RESERVA", colorId: "10" },
  CONFIRMADO: { sufixo: "CONFIRMADO", colorId: "3" },
};

const NOMES_CRIADORES_AGENDA = {
  "luciano.cinnamon@gmail.com": "Luciano",
  "sergiodobass@gmail.com": "Serginho",
};

const CAMPOS_RELEVANTES_AGENDA = [
  "cliente",
  "nome_contratante_formal",
  "tipo",
  "status",
  "dataStr",
  "data",
  "horaInicio",
  "horaTermino",
  "duracao",
  "local",
  "local_evento_endereco",
  "contratante_endereco",
  "endereco",
  "cidade",
  "uf",
  "whatsapp",
  "valor",
  "valor_final_contrato",
];

function env(name, fallback = "") {
  return process.env[name] || fallback;
}

function safeText(value, fallback = "-") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function parseDataEvento(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const match = raw.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/)
    || raw.match(/^(\d{4})[-/](\d{2})[-/](\d{2})$/);

  if (!match) return null;

  const anoPrimeiro = match[1].length === 4;
  const ano = Number(anoPrimeiro ? match[1] : match[3]);
  const mes = Number(match[2]);
  const dia = Number(anoPrimeiro ? match[3] : match[1]);

  if (!Number.isFinite(ano) || !Number.isFinite(mes) || !Number.isFinite(dia)) return null;

  const data = new Date(Date.UTC(ano, mes - 1, dia));
  if (data.getUTCFullYear() !== ano || data.getUTCMonth() !== mes - 1 || data.getUTCDate() !== dia) {
    return null;
  }

  return { data, dia, mes, ano };
}

function formatarDataEvento(value) {
  const parsed = parseDataEvento(value);
  if (!parsed) return safeText(value);

  const diasSemana = [
    "Domingo",
    "Segunda-feira",
    "Ter\u00e7a-feira",
    "Quarta-feira",
    "Quinta-feira",
    "Sexta-feira",
    "S\u00e1bado",
  ];

  return `${String(parsed.dia).padStart(2, "0")}/${String(parsed.mes).padStart(2, "0")}/${parsed.ano} (${diasSemana[parsed.data.getUTCDay()]})`;
}

function formatarHorario(pedido) {
  const inicio = safeText(pedido.horaInicio, "");
  const termino = safeText(pedido.horaTermino || calcularHoraTermino(pedido.horaInicio, pedido.duracao), "");

  if (inicio && termino) return `das ${inicio} \u00e0s ${termino}`;
  if (inicio) return `a partir das ${inicio}`;
  return "-";
}

function formatarLocal(pedido) {
  const cidade = safeText(pedido.cidade, "");
  const uf = safeText(pedido.uf, "");
  const partes = [cidade, uf].filter(Boolean);
  return partes.length ? partes.join(" - ") : safeText(pedido.local);
}

function sendJson(res, status, payload) {
  res
    .status(status)
    .set("Access-Control-Allow-Origin", "*")
    .set("Access-Control-Allow-Headers", "Content-Type")
    .set("Access-Control-Allow-Methods", "POST, OPTIONS")
    .json(payload);
}

function tokenValido(token) {
  return typeof token === "string" && /^[A-Za-z0-9_-]{32,120}$/.test(token);
}

function documentoBuscaValido(documentoLimpo) {
  return typeof documentoLimpo === "string" && /^(\d{11}|\d{14})$/.test(documentoLimpo);
}

function calcularHoraTermino(horaInicio, duracao) {
  if (!horaInicio) return "";

  const [hora, minuto] = String(horaInicio).split(":").map(Number);
  if (!Number.isFinite(hora) || !Number.isFinite(minuto)) return "";

  const [durHora, durMinuto = 0] = String(duracao || "2:00").split(":").map(Number);
  const duracaoMinutos = ((Number.isFinite(durHora) ? durHora : 2) * 60)
    + (Number.isFinite(durMinuto) ? durMinuto : 0);
  const total = (hora * 60) + minuto + duracaoMinutos;

  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function formatarDataIsoLocal(parsed) {
  return `${String(parsed.ano).padStart(4, "0")}-${String(parsed.mes).padStart(2, "0")}-${String(parsed.dia).padStart(2, "0")}`;
}

function formatarDataBrasileira(parsed) {
  return `${String(parsed.dia).padStart(2, "0")}-${String(parsed.mes).padStart(2, "0")}-${String(parsed.ano).padStart(4, "0")}`;
}

function parseHorario(value, fallback = "19:00") {
  const raw = String(value || fallback).trim();
  const match = raw.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) return parseHorario(fallback, "19:00");
  return { hora: Number(match[1]), minuto: Number(match[2]) };
}

function parseDuracaoMinutos(value, fallback = 120) {
  const raw = String(value || "").trim();
  if (!raw) return fallback;

  if (raw.includes(":")) {
    const [h, m = "0"] = raw.split(":");
    const horas = Number(h);
    const minutos = Number(m);
    if (Number.isFinite(horas) && Number.isFinite(minutos)) {
      return Math.max(15, (horas * 60) + minutos);
    }
  }

  const decimal = Number(raw.replace(",", "."));
  if (Number.isFinite(decimal)) return Math.max(15, Math.round(decimal * 60));
  return fallback;
}

function formatarDuracao(minutos) {
  const total = Math.max(0, Number(minutos) || 0);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function somarDiasData(parsed, dias) {
  const dt = new Date(Date.UTC(parsed.ano, parsed.mes - 1, parsed.dia + dias));
  return {
    ano: dt.getUTCFullYear(),
    mes: dt.getUTCMonth() + 1,
    dia: dt.getUTCDate(),
    data: dt,
  };
}

function montarInicioFimAgenda(pedido) {
  const parsed = parseDataEvento(pedido.dataStr || pedido.data);
  if (!parsed) throw new Error("DATA_EVENTO_INVALIDA");

  const inicio = parseHorario(pedido.horaInicio || "19:00");
  const duracaoMinutos = parseDuracaoMinutos(pedido.duracao, 120);
  const inicioMinutos = (inicio.hora * 60) + inicio.minuto;
  const fimTotal = inicioMinutos + duracaoMinutos;
  const fimOffsetDias = Math.floor(fimTotal / 1440);
  const fimMinutos = fimTotal % 1440;
  const parsedFim = somarDiasData(parsed, fimOffsetDias);

  return {
    data: parsed,
    dataIso: formatarDataIsoLocal(parsed),
    inicio: `${String(inicio.hora).padStart(2, "0")}:${String(inicio.minuto).padStart(2, "0")}`,
    fim: `${String(Math.floor(fimMinutos / 60)).padStart(2, "0")}:${String(fimMinutos % 60).padStart(2, "0")}`,
    start: {
      dateTime: `${formatarDataIsoLocal(parsed)}T${String(inicio.hora).padStart(2, "0")}:${String(inicio.minuto).padStart(2, "0")}:00`,
      timeZone: CALENDAR_TIME_ZONE,
    },
    end: {
      dateTime: `${formatarDataIsoLocal(parsedFim)}T${String(Math.floor(fimMinutos / 60)).padStart(2, "0")}:${String(fimMinutos % 60).padStart(2, "0")}:00`,
      timeZone: CALENDAR_TIME_ZONE,
    },
    duracaoMinutos,
  };
}

function statusConfigAgenda(status) {
  const normalized = String(status || "PRE_RESERVA").toUpperCase();
  return STATUS_AGENDA[normalized] || STATUS_AGENDA.PRE_RESERVA;
}

function statusAtivoAgenda(status) {
  return !["REPROVADO", "LIXEIRA"].includes(String(status || "").toUpperCase());
}

function normalizarTextoAgenda(value, fallback = "") {
  return safeText(value, fallback).replace(/\s+/g, " ").trim();
}

function tituloAgendaPedido(pedido) {
  const status = statusConfigAgenda(pedido.status);
  const cliente = normalizarTextoAgenda(pedido.cliente || pedido.nome_contratante_formal, "CLIENTE");
  const tipo = normalizarTextoAgenda(pedido.tipo, "EVENTO");
  return `JAZZ CINNAMON - ${cliente} (${tipo}) - ${status.sufixo}`;
}

function localAgendaPedido(pedido, fallback = "") {
  const localNome = safeText(pedido.local, "");
  const endereco = safeText(pedido.local_evento_endereco || pedido.contratante_endereco || pedido.endereco, "");
  const cidadeUf = pedido.cidade && pedido.uf
    ? `${pedido.cidade}-${pedido.uf}`
    : safeText(pedido.cidade || pedido.uf, "");
  const partes = [localNome, endereco, cidadeUf].filter(Boolean);
  return partes.length ? partes.join(", ") : fallback;
}

function parseDescricaoAgenda(descricao = "") {
  const state = {
    whatsapp: "",
    valor: "",
    traje: "",
    bateria: "",
    obs: "",
  };
  let inObs = false;

  String(descricao || "").split("\n").forEach((line) => {
    const l = line.trim();
    if (!l) return;

    if (l.startsWith("R$")) {
      state.valor = l;
      inObs = false;
    } else if (l.toUpperCase().startsWith("TRAJE:")) {
      state.traje = l.slice(6).trim();
      inObs = false;
    } else if (l.toUpperCase().startsWith("BATERIA:")) {
      state.bateria = l.slice(8).trim();
      inObs = false;
    } else if (l.toUpperCase().startsWith("OBSERVA")) {
      state.obs = l.replace(/^OBSERVA[^\:]*:/i, "").trim();
      inObs = true;
    } else if (inObs) {
      state.obs = `${state.obs}\n${l}`.trim();
    } else if (l.includes(" - ") && !l.includes(",") && !l.startsWith("JAZZ")) {
      const parts = l.split(" - ");
      if (parts.length > 1) state.whatsapp = parts.slice(1).join(" - ").trim();
    }
  });

  return state;
}

function montarDescricaoAgenda(pedido, eventoExistente = null) {
  const anterior = parseDescricaoAgenda(eventoExistente?.description || "");
  const local = localAgendaPedido(pedido, eventoExistente?.location || "LOCAL A DEFINIR");
  const cliente = normalizarTextoAgenda(pedido.cliente || pedido.nome_contratante_formal, "CLIENTE");
  const whatsapp = safeText(pedido.whatsapp || anterior.whatsapp, "S/ WHATSAPP");

  let valor = anterior.valor || "R$ 0,00";
  const valorPedido = pedido.valor_final_contrato ?? pedido.valor;
  if (valorPedido !== undefined && valorPedido !== "") {
    valor = `R$ ${Number(valorPedido || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`;
  }

  return [
    local,
    "",
    `${cliente} - ${whatsapp}`,
    valor,
    "",
    `TRAJE: ${anterior.traje}`,
    `BATERIA: ${anterior.bateria}`,
    `OBSERVACAO: ${anterior.obs}`,
  ].join("\n");
}

function disponibilidadePush(pedido) {
  const statusAgenda = String(pedido.statusAgenda || "").toUpperCase();
  const concorrentes = Array.isArray(pedido.concorrentes) ? pedido.concorrentes.length : 0;

  if (statusAgenda === "LIVRE" && concorrentes === 0) return "LIVRE";
  if (statusAgenda === "LIVRE" && concorrentes > 0) return "AVALIAR LOGISTICA";
  if (statusAgenda === "OCUPADO") return "OCUPADO";
  if (statusAgenda === "PENDENTE") return "PENDENTE";

  return safeText(pedido.statusAgenda || pedido.status, "PENDENTE").toUpperCase();
}

function configurarWebPush() {
  const publicKey = env("VAPID_PUBLIC_KEY");
  const privateKey = env("VAPID_PRIVATE_KEY") || VAPID_PRIVATE_KEY_SECRET.value();

  if (!publicKey || !privateKey) return false;

  webpush.setVapidDetails(env("VAPID_SUBJECT", DEFAULT_VAPID_SUBJECT), publicKey, privateKey);
  return true;
}

function montarPushPedido(pedido, pedidoId, tipoNotificacao = "NOVO_PEDIDO") {
  const cliente = safeText(pedido.cliente, "Cliente sem nome");
  const dataEvento = formatarDataEvento(pedido.dataStr || pedido.data);
  const horario = formatarHorario(pedido);
  const local = formatarLocal(pedido);
  const espaco = safeText(pedido.local, "");
  const convidados = safeText(pedido.convidados);
  const tipo = safeText(pedido.tipo);
  const disponibilidade = disponibilidadePush(pedido);
  const panelUrl = env("PANEL_URL", DEFAULT_PANEL_URL);
  const url = `${panelUrl}?pedido=${encodeURIComponent(pedidoId)}`;

  const detalhes = [
    `DATA: ${dataEvento}`,
    `HORARIO: ${horario}`,
    `LOCAL: ${local}`,
    espaco ? `ESPACO: ${espaco}` : "",
    `CONVIDADOS: ${convidados}`,
    `TIPO: ${tipo}`,
  ].filter(Boolean).join("\n");

  const templates = {
    NOVO_PEDIDO: {
      title: `${disponibilidade} - NOVO PEDIDO: ${cliente}`,
      body: `${detalhes}\nDISPONIBILIDADE: ${disponibilidade}`,
      tagPrefix: "novo-pedido",
    },
    NOVO_CONTRATO: {
      title: `NOVO CONTRATO: ${cliente}`,
      body: `CONTRATO RECEBIDO\n${detalhes}`,
      tagPrefix: "novo-contrato",
    },
    DADOS_NF: {
      title: `DADOS NF: ${cliente}`,
      body: `DADOS PARA NOTA FISCAL RECEBIDOS\n${detalhes}`,
      tagPrefix: "dados-nf",
    },
  };
  const template = templates[tipoNotificacao] || templates.NOVO_PEDIDO;

  return {
    title: template.title,
    body: template.body,
    tag: `${template.tagPrefix}-${pedidoId}`,
    url,
    data: {
      pedidoId,
      tipoNotificacao,
      disponibilidade,
      url,
    },
  };
}

function prefixoStatusPush(tipoNotificacao) {
  if (tipoNotificacao === "NOVO_CONTRATO") return "notificacaoPushContrato";
  if (tipoNotificacao === "DADOS_NF") return "notificacaoPushNf";
  return "notificacaoPush";
}

function valorPresente(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

function campoEntrou(before, after, campo) {
  return !valorPresente(before?.[campo]) && valorPresente(after?.[campo]);
}

async function atualizarStatusPush(pedidoRef, tipoNotificacao, status, extras = {}) {
  const prefixo = prefixoStatusPush(tipoNotificacao);
  await pedidoRef.update({
    [`${prefixo}Status`]: status,
    [`${prefixo}AtualizadoEm`]: admin.firestore.FieldValue.serverTimestamp(),
    ...extras,
  });
}

async function enviarPushPedido(pedido, pedidoId, pedidoRef, tipoNotificacao) {
  if (!configurarWebPush()) {
    logger.warn("Web Push not configured. Notification was not sent.", {
      pedidoId,
      tipoNotificacao,
    });
    await atualizarStatusPush(pedidoRef, tipoNotificacao, "CONFIGURACAO_PENDENTE", {
      [`${prefixoStatusPush(tipoNotificacao)}Erro`]: "VAPID_PUBLIC_KEY ou VAPID_PRIVATE_KEY ausente.",
    });
    return;
  }

  const subscriptionsSnap = await db.collection("push_subscriptions").where("ativo", "==", true).get();
  if (subscriptionsSnap.empty) {
    await atualizarStatusPush(pedidoRef, tipoNotificacao, "SEM_INSCRICOES");
    return;
  }

  const push = montarPushPedido(pedido, pedidoId, tipoNotificacao);
  const payload = JSON.stringify({
    title: push.title,
    options: {
      body: push.body,
      icon: NOTIFICATION_ICON_URL,
      badge: NOTIFICATION_ICON_URL,
      tag: push.tag,
      renotify: true,
      timestamp: Date.now(),
      data: push.data,
    },
  });

  let enviadas = 0;
  let falhas = 0;

  await Promise.all(subscriptionsSnap.docs.map(async (subscriptionDoc) => {
    const subscription = subscriptionDoc.data().subscription;
    if (!subscription || !subscription.endpoint) {
      falhas += 1;
      await subscriptionDoc.ref.delete();
      return;
    }

    try {
      await webpush.sendNotification(subscription, payload);
      enviadas += 1;
      await subscriptionDoc.ref.set({
        ultimoEnvioEm: admin.firestore.FieldValue.serverTimestamp(),
        ultimoErro: admin.firestore.FieldValue.delete(),
      }, { merge: true });
    } catch (error) {
      falhas += 1;
      const statusCode = Number(error.statusCode || error.status);
      if (statusCode === 404 || statusCode === 410) {
        await subscriptionDoc.ref.delete();
        return;
      }

      logger.error("Failed to send Web Push notification.", {
        pedidoId,
        tipoNotificacao,
        subscriptionId: subscriptionDoc.id,
        error: String(error.message || error),
      });
      await subscriptionDoc.ref.set({
        ultimoErro: String(error.message || error).slice(0, 500),
        ultimoErroEm: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }
  }));

  const prefixo = prefixoStatusPush(tipoNotificacao);
  await atualizarStatusPush(pedidoRef, tipoNotificacao, enviadas > 0 ? "ENVIADO" : "ERRO", {
    [`${prefixo}Enviadas`]: enviadas,
    [`${prefixo}Falhas`]: falhas,
    [`${prefixo}EnviadoEm`]: enviadas > 0 ? admin.firestore.FieldValue.serverTimestamp() : admin.firestore.FieldValue.delete(),
    [`${prefixo}Erro`]: enviadas > 0 ? admin.firestore.FieldValue.delete() : "Nenhuma inscricao recebeu a notificacao.",
  });
}

async function carregarLinkPublico(token, tipoEsperado) {
  if (!tokenValido(token)) {
    throw new Error("LINK_INVALIDO");
  }

  const linkRef = db.collection("links_publicos").doc(token);
  const linkSnap = await linkRef.get();
  if (!linkSnap.exists) {
    throw new Error("LINK_INVALIDO");
  }

  const link = linkSnap.data();
  const expiraEm = link.expiraEm?.toMillis ? link.expiraEm.toMillis() : new Date(link.expiraEm || 0).getTime();

  if (link.ativo === false || link.tipo !== tipoEsperado || !link.pedidoId || !expiraEm || expiraEm < Date.now()) {
    throw new Error("LINK_EXPIRADO");
  }

  const pedidoRef = db.collection("pedidos").doc(link.pedidoId);
  const pedidoSnap = await pedidoRef.get();
  if (!pedidoSnap.exists) {
    throw new Error("PEDIDO_NAO_ENCONTRADO");
  }

  const pedido = pedidoSnap.data();
  if (["REPROVADO", "LIXEIRA"].includes(pedido.status)) {
    throw new Error("PEDIDO_INDISPONIVEL");
  }

  return { linkRef, link, pedidoRef, pedidoSnap, pedido };
}

function pedidoParaFormulario(pedido) {
  return {
    cliente: pedido.cliente || "",
    documento: pedido.documento || "",
    email: pedido.email || "",
    dataStr: pedido.dataStr || pedido.data || "",
    horaInicio: pedido.horaInicio || "",
    horaTermino: pedido.horaTermino || calcularHoraTermino(pedido.horaInicio, pedido.duracao),
    duracao: pedido.duracao || "",
    cidade: pedido.cidade || "",
    uf: pedido.uf || "",
    local: pedido.local || "",
    tipo: pedido.tipo || "",
    convidados: pedido.convidados || "",
    valor: pedido.valor || 0,
    valorBase: pedido.valorBase || null,
    temNf: pedido.temNf || "",
    status: pedido.status || "",
    dadosContrato: pedido.dadosContrato || null,
    dadosNf: pedido.dadosNf || null,
  };
}

function timestampMillis(value) {
  if (value?.toMillis) return value.toMillis();
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

async function buscarClientePorDocumento(documentoLimpo) {
  if (!documentoBuscaValido(documentoLimpo)) {
    throw new Error("DOCUMENTO_INVALIDO");
  }

  const snapshot = await db.collection("pedidos")
    .where("documentoLimpo", "==", documentoLimpo)
    .limit(20)
    .get();

  if (snapshot.empty) return null;

  const pedidos = snapshot.docs
    .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
    .filter((pedido) => !["LIXEIRA"].includes(pedido.status));

  if (!pedidos.length) return null;

  pedidos.sort((a, b) => timestampMillis(b.criadoEm) - timestampMillis(a.criadoEm));
  const pedido = pedidos[0];

  return {
    cliente: pedido.cliente || "",
    documento: pedido.documento || "",
    whatsapp: pedido.whatsapp || "",
    email: pedido.email || "",
  };
}

async function chamarAppsScript(payload) {
  const response = await fetch(URL_BACKEND, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload),
  });

  return response.json();
}

let calendarClientPromise = null;

async function getCalendarClient() {
  if (!calendarClientPromise) {
    calendarClientPromise = (async () => {
      const auth = new google.auth.GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/calendar"],
      });
      const authClient = await auth.getClient();
      return google.calendar({ version: "v3", auth: authClient });
    })();
  }

  return calendarClientPromise;
}

function getCalendarId() {
  return env("GOOGLE_CALENDAR_ID", DEFAULT_CALENDAR_ID);
}

function erroGoogleStatus(error) {
  return Number(error?.code || error?.response?.status || error?.errors?.[0]?.code || 0);
}

async function buscarEventoAgenda(calendar, agendaId) {
  const id = String(agendaId || "").trim();
  if (!id) return null;

  const calendarId = getCalendarId();
  const tentativasGet = [id];
  if (id.includes("@")) tentativasGet.push(id.split("@")[0]);

  for (const eventId of [...new Set(tentativasGet)]) {
    try {
      const { data } = await calendar.events.get({ calendarId, eventId });
      if (data && data.status !== "cancelled") return data;
    } catch (error) {
      if (erroGoogleStatus(error) && erroGoogleStatus(error) !== 404 && erroGoogleStatus(error) !== 410) {
        throw error;
      }
    }
  }

  try {
    const { data } = await calendar.events.list({
      calendarId,
      iCalUID: id,
      showDeleted: false,
      singleEvents: false,
      maxResults: 10,
    });
    return (data.items || []).find((event) => event.status !== "cancelled") || null;
  } catch (error) {
    if (erroGoogleStatus(error) && erroGoogleStatus(error) !== 404 && erroGoogleStatus(error) !== 410) {
      throw error;
    }
    return null;
  }
}

async function deletarEventoAgenda(calendar, agendaId) {
  const evento = await buscarEventoAgenda(calendar, agendaId);
  if (!evento) return false;

  await calendar.events.delete({
    calendarId: getCalendarId(),
    eventId: evento.id,
  });
  return true;
}

function recursoEventoAgenda(pedido, eventoExistente = null) {
  const periodo = montarInicioFimAgenda(pedido);
  const status = statusConfigAgenda(pedido.status);
  const location = localAgendaPedido(pedido, eventoExistente?.location || "");

  return {
    summary: tituloAgendaPedido(pedido),
    location,
    description: montarDescricaoAgenda(pedido, eventoExistente),
    start: periodo.start,
    end: periodo.end,
    colorId: status.colorId,
  };
}

async function sincronizarPedidoComAgenda(pedidoId, origem = "manual") {
  if (!pedidoId) throw new Error("PEDIDO_ID_OBRIGATORIO");

  const pedidoRef = db.collection("pedidos").doc(pedidoId);
  const pedidoSnap = await pedidoRef.get();
  if (!pedidoSnap.exists) throw new Error("PEDIDO_NAO_ENCONTRADO");

  const pedido = pedidoSnap.data();
  const calendar = await getCalendarClient();
  const agendaIdAtual = pedido.agendaId || pedido.agendaEventId || "";

  if (!statusAtivoAgenda(pedido.status)) {
    let removido = false;
    if (agendaIdAtual) removido = await deletarEventoAgenda(calendar, agendaIdAtual);
    await pedidoRef.set({
      agendaId: admin.firestore.FieldValue.delete(),
      agendaIcalUid: admin.firestore.FieldValue.delete(),
      agendaSyncStatus: removido ? "REMOVIDO" : "SEM_EVENTO",
      agendaSyncOrigem: origem,
      agendaSyncAtualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
      agendaSyncErro: admin.firestore.FieldValue.delete(),
    }, { merge: true });
    return { success: true, removido, status: "REMOVIDO" };
  }

  const eventoExistente = agendaIdAtual ? await buscarEventoAgenda(calendar, agendaIdAtual) : null;
  const resource = recursoEventoAgenda(pedido, eventoExistente);
  let evento;
  let criado = false;

  if (eventoExistente) {
    const { data } = await calendar.events.patch({
      calendarId: getCalendarId(),
      eventId: eventoExistente.id,
      requestBody: resource,
    });
    evento = data;
  } else {
    const { data } = await calendar.events.insert({
      calendarId: getCalendarId(),
      requestBody: resource,
    });
    evento = data;
    criado = true;
  }

  await pedidoRef.set({
    agendaId: evento.id,
    agendaIcalUid: evento.iCalUID || "",
    agendaHtmlLink: evento.htmlLink || "",
    agendaSyncStatus: criado ? "CRIADO" : "ATUALIZADO",
    agendaSyncOrigem: origem,
    agendaSyncAtualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
    agendaSyncErro: admin.firestore.FieldValue.delete(),
  }, { merge: true });

  return {
    success: true,
    status: criado ? "CRIADO" : "ATUALIZADO",
    eventId: evento.id,
    agendaId: evento.id,
    agendaIcalUid: evento.iCalUID || "",
    htmlLink: evento.htmlLink || "",
  };
}

function camposAgendaMudaram(before = {}, after = {}) {
  return CAMPOS_RELEVANTES_AGENDA.some((campo) => JSON.stringify(before[campo] ?? null) !== JSON.stringify(after[campo] ?? null));
}

function inicioEventoGoogle(evento) {
  const startRaw = evento?.start?.dateTime || `${evento?.start?.date || ""}T00:00:00`;
  return new Date(startRaw);
}

function partesLocaisEventoGoogle(valor, fallbackHora = "00:00") {
  const raw = String(valor || "").trim();
  const dateTime = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (dateTime) {
    return {
      ano: Number(dateTime[1]),
      mes: Number(dateTime[2]),
      dia: Number(dateTime[3]),
      hora: Number(dateTime[4]),
      minuto: Number(dateTime[5]),
    };
  }

  const dateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const [hora, minuto] = fallbackHora.split(":").map(Number);
    return {
      ano: Number(dateOnly[1]),
      mes: Number(dateOnly[2]),
      dia: Number(dateOnly[3]),
      hora: Number.isFinite(hora) ? hora : 0,
      minuto: Number.isFinite(minuto) ? minuto : 0,
    };
  }

  const dt = new Date(raw);
  if (Number.isNaN(dt.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CALENDAR_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(dt).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});

  return {
    ano: Number(parts.year),
    mes: Number(parts.month),
    dia: Number(parts.day),
    hora: Number(parts.hour),
    minuto: Number(parts.minute),
  };
}

function resumoEventoGoogle(evento, ocultarTitulo = false) {
  const inicioLocal = partesLocaisEventoGoogle(evento?.start?.dateTime || evento?.start?.date);
  const fimLocal = partesLocaisEventoGoogle(evento?.end?.dateTime || evento?.end?.date, "23:59");
  const inicioDate = new Date(evento?.start?.dateTime || `${evento?.start?.date || ""}T00:00:00`);
  const fimDate = new Date(evento?.end?.dateTime || `${evento?.end?.date || ""}T23:59:00`);
  const data = inicioLocal || { ano: inicioDate.getFullYear(), mes: inicioDate.getMonth() + 1, dia: inicioDate.getDate(), hora: 0, minuto: 0 };
  const inicioMin = ((inicioLocal?.hora || 0) * 60) + (inicioLocal?.minuto || 0);
  const fimMin = ((fimLocal?.hora || 0) * 60) + (fimLocal?.minuto || 0);
  const duracao = Math.max(15, Math.round((fimDate.getTime() - inicioDate.getTime()) / 60000));
  const criadorEmail = String(evento.creator?.email || evento.organizer?.email || "").toLowerCase();
  const titulo = evento.summary || "Evento Google Agenda";

  return {
    eventId: evento.id,
    agendaId: evento.id,
    agendaIcalUid: evento.iCalUID || "",
    titulo: ocultarTitulo ? "Evento na Google Agenda" : titulo,
    dataStr: formatarDataBrasileira(data),
    horaInicio: `${String(Math.floor(inicioMin / 60)).padStart(2, "0")}:${String(inicioMin % 60).padStart(2, "0")}`,
    horaTermino: `${String(Math.floor(fimMin / 60) % 24).padStart(2, "0")}:${String(fimMin % 60).padStart(2, "0")}`,
    duracao: formatarDuracao(duracao),
    local: evento.location || "",
    status: inferirStatusAgendaPorTitulo(titulo),
    cor: evento.colorId || "",
    criadorEmail,
    criadorNome: NOMES_CRIADORES_AGENDA[criadorEmail] || criadorEmail || "Google Agenda",
    origem: "google_calendar",
  };
}

function inferirStatusAgendaPorTitulo(titulo = "") {
  const upper = String(titulo || "").toUpperCase();
  if (upper.includes("CONFIRMADO")) return "CONFIRMADO";
  if (upper.includes("RESERVA") && !upper.includes("PRE-RESERVA")) return "RESERVA";
  if (upper.includes("PRE-RESERVA") || upper.includes("PRE_RESERVA")) return "PRE_RESERVA";
  return "CONFIRMADO";
}

function extrairDadosTituloAgenda(titulo = "") {
  const match = String(titulo || "").match(/JAZZ CINNAMON\s*-\s*(.*?)\s*\((.*?)\)\s*-\s*(.*)$/i);
  if (!match) {
    return { cliente: safeText(titulo, "EVENTO GOOGLE AGENDA"), tipo: "EVENTO", status: inferirStatusAgendaPorTitulo(titulo) };
  }

  return {
    cliente: safeText(match[1], "CLIENTE"),
    tipo: safeText(match[2], "EVENTO"),
    status: inferirStatusAgendaPorTitulo(match[3]),
  };
}

async function listarEventosGoogleEntre(timeMin, timeMax) {
  const calendar = await getCalendarClient();
  const { data } = await calendar.events.list({
    calendarId: getCalendarId(),
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: "startTime",
    showDeleted: false,
    maxResults: 2500,
  });
  return data.items || [];
}

function formatosDataConsulta(dataBusca) {
  const parsed = parseDataEvento(dataBusca);
  if (!parsed) throw new Error("DATA_BUSCA_INVALIDA");
  const dd = String(parsed.dia).padStart(2, "0");
  const mm = String(parsed.mes).padStart(2, "0");
  const yyyy = String(parsed.ano);
  return {
    parsed,
    valores: [`${dd}-${mm}-${yyyy}`, `${yyyy}-${mm}-${dd}`, `${dd}/${mm}/${yyyy}`],
  };
}

async function idsAgendaPedidosNaData(dataBusca) {
  const { valores } = formatosDataConsulta(dataBusca);
  const snapshot = await db.collection("pedidos").where("dataStr", "in", valores).get();
  const ids = new Set();
  const icals = new Set();

  snapshot.forEach((docSnap) => {
    const pedido = docSnap.data();
    if (!statusAtivoAgenda(pedido.status)) return;
    if (pedido.agendaId) ids.add(String(pedido.agendaId));
    if (pedido.agendaIcalUid) icals.add(String(pedido.agendaIcalUid));
  });

  return { ids, icals };
}

async function verificarAgendaDia(dataBusca) {
  const { parsed } = formatosDataConsulta(dataBusca);
  const dataIso = formatarDataIsoLocal(parsed);
  const diaSeguinte = formatarDataIsoLocal(somarDiasData(parsed, 1));
  const eventos = await listarEventosGoogleEntre(`${dataIso}T00:00:00-03:00`, `${diaSeguinte}T00:00:00-03:00`);
  const { ids, icals } = await idsAgendaPedidosNaData(dataBusca);

  const eventosExternos = eventos
    .filter((event) => !ids.has(event.id) && !icals.has(event.iCalUID))
    .map((event) => resumoEventoGoogle(event));

  return { success: true, eventosExternos, eventos: eventosExternos };
}

function pedidoDentroDoIntervalo(pedido, inicio, fim) {
  if (!statusAtivoAgenda(pedido.status)) return false;
  const parsed = parseDataEvento(pedido.dataStr || pedido.data);
  if (!parsed) return false;
  const dt = new Date(parsed.ano, parsed.mes - 1, parsed.dia, 23, 59, 59);
  return dt >= inicio && dt <= fim;
}

function chavesEventosGoogle(eventos) {
  const byId = new Map();
  const byIcal = new Map();
  eventos.forEach((event) => {
    if (event.id) byId.set(String(event.id), event);
    if (event.iCalUID) byIcal.set(String(event.iCalUID), event);
  });
  return { byId, byIcal };
}

function eventoEsperadoDiverge(pedido, evento) {
  try {
    const esperado = recursoEventoAgenda(pedido, evento);
    const inicioAtual = partesLocaisEventoGoogle(evento.start?.dateTime || evento.start?.date);
    const fimAtual = partesLocaisEventoGoogle(evento.end?.dateTime || evento.end?.date);
    const inicioEsperado = partesLocaisEventoGoogle(esperado.start.dateTime);
    const fimEsperado = partesLocaisEventoGoogle(esperado.end.dateTime);
    const mesmaDataHora = (a, b) => a && b
      && a.ano === b.ano
      && a.mes === b.mes
      && a.dia === b.dia
      && a.hora === b.hora
      && a.minuto === b.minuto;
    const divergencias = [];
    if ((evento.summary || "") !== esperado.summary) divergencias.push("titulo/status");
    if ((evento.colorId || "") !== (esperado.colorId || "")) divergencias.push("cor");
    if ((evento.location || "") !== (esperado.location || "")) divergencias.push("local");
    if (!mesmaDataHora(inicioAtual, inicioEsperado)) divergencias.push("inicio");
    if (!mesmaDataHora(fimAtual, fimEsperado)) divergencias.push("termino");
    return divergencias;
  } catch (error) {
    return ["dados invalidos"];
  }
}

async function conferirAgenda() {
  const agora = new Date();
  const fimAno = new Date(agora.getFullYear(), 11, 31, 23, 59, 59);
  const eventosGoogle = await listarEventosGoogleEntre(agora.toISOString(), fimAno.toISOString());
  const maps = chavesEventosGoogle(eventosGoogle);
  const pedidosSnap = await db.collection("pedidos").get();
  const pedidos = [];

  pedidosSnap.forEach((docSnap) => {
    const pedido = { id: docSnap.id, ...docSnap.data() };
    if (pedidoDentroDoIntervalo(pedido, agora, fimAno)) pedidos.push(pedido);
  });

  const idsPedidosAgenda = new Set();
  const icalsPedidosAgenda = new Set();
  pedidos.forEach((pedido) => {
    if (pedido.agendaId) idsPedidosAgenda.add(String(pedido.agendaId));
    if (pedido.agendaIcalUid) icalsPedidosAgenda.add(String(pedido.agendaIcalUid));
  });

  const manuais = eventosGoogle
    .filter((event) => !idsPedidosAgenda.has(event.id) && !icalsPedidosAgenda.has(event.iCalUID))
    .map((event) => resumoEventoGoogle(event));

  const ausentes = [];
  const divergentes = [];

  pedidos.forEach((pedido) => {
    const evento = (pedido.agendaId && maps.byId.get(String(pedido.agendaId)))
      || (pedido.agendaId && maps.byIcal.get(String(pedido.agendaId)))
      || (pedido.agendaIcalUid && maps.byIcal.get(String(pedido.agendaIcalUid)))
      || null;

    if (!evento) {
      ausentes.push({
        pedidoId: pedido.id,
        id: pedido.id,
        cliente: pedido.cliente || "Cliente",
        dataStr: pedido.dataStr || pedido.data || "",
        horaInicio: pedido.horaInicio || "",
        status: pedido.status || "",
        msg: "Evento no ERP ausente na agenda. Deseja incluir?",
      });
      return;
    }

    const divergencias = eventoEsperadoDiverge(pedido, evento);
    if (divergencias.length) {
      divergentes.push({
        pedidoId: pedido.id,
        id: pedido.id,
        cliente: pedido.cliente || "Cliente",
        dataStr: pedido.dataStr || pedido.data || "",
        horaInicio: pedido.horaInicio || "",
        status: pedido.status || "",
        eventId: evento.id,
        divergencias,
        msg: `Agenda divergente: ${divergencias.join(", ")}.`,
      });
    }
  });

  return {
    success: true,
    periodo: {
      inicio: agora.toISOString(),
      fim: fimAno.toISOString(),
    },
    manuais,
    ausentes,
    divergentes,
  };
}

async function importarEventoGoogleParaErp(eventId) {
  const calendar = await getCalendarClient();
  const { data: event } = await calendar.events.get({
    calendarId: getCalendarId(),
    eventId,
  });

  if (!event || event.status === "cancelled") throw new Error("EVENTO_GOOGLE_NAO_ENCONTRADO");

  const resumo = resumoEventoGoogle(event);
  const dadosTitulo = extrairDadosTituloAgenda(event.summary);

  const docRef = await db.collection("pedidos").add({
    cliente: dadosTitulo.cliente.toUpperCase(),
    documento: "",
    documentoLimpo: "",
    whatsapp: "",
    email: "",
    dataStr: resumo.dataStr,
    horaInicio: resumo.horaInicio,
    horaTermino: resumo.horaTermino,
    duracao: resumo.duracao,
    cidade: "",
    uf: "",
    local: resumo.local,
    tipo: dadosTitulo.tipo,
    convidados: "",
    status: dadosTitulo.status,
    statusAgenda: "OCUPADO",
    concorrentes: [],
    valor: 0,
    valorPago: 0,
    statusPgto: "PENDENTE",
    agendaId: event.id,
    agendaIcalUid: event.iCalUID || "",
    agendaHtmlLink: event.htmlLink || "",
    origem: "google_calendar_manual",
    origemCriadorEmail: resumo.criadorEmail,
    origemCriadorNome: resumo.criadorNome,
    criadoEm: admin.firestore.FieldValue.serverTimestamp(),
  });

  await sincronizarPedidoComAgenda(docRef.id, "importacao_google");
  return { success: true, pedidoId: docRef.id };
}

async function exigirAdminAgenda(req) {
  const authHeader = String(req.get("Authorization") || "");
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new Error("NAO_AUTORIZADO");

  const decoded = await admin.auth().verifyIdToken(match[1]);
  const email = String(decoded.email || "").toLowerCase();
  if (!ADMIN_EMAILS.includes(email)) throw new Error("NAO_AUTORIZADO");
  return decoded;
}

exports.linkPublico = onRequest({
  region: REGION,
}, async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { success: false, error: "Metodo nao permitido." });
    return;
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const acao = String(body.acao || "");
    const token = String(body.token || "");

    if (acao === "BUSCAR_CLIENTE") {
      const documentoLimpo = String(body.documentoLimpo || "").replace(/\D/g, "");
      const cliente = await buscarClientePorDocumento(documentoLimpo);
      sendJson(res, 200, { success: true, encontrado: Boolean(cliente), cliente });
      return;
    }

    if (acao === "CARREGAR_CONTRATO") {
      const { linkRef, link, pedido } = await carregarLinkPublico(token, "CONTRATO");
      await linkRef.set({ ultimoAcessoEm: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      sendJson(res, 200, { success: true, pedidoId: link.pedidoId, pedido: pedidoParaFormulario(pedido) });
      return;
    }

    if (acao === "CARREGAR_NF") {
      const { linkRef, link, pedido } = await carregarLinkPublico(token, "NF");
      await linkRef.set({ ultimoAcessoEm: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      sendJson(res, 200, { success: true, pedidoId: link.pedidoId, pedido: pedidoParaFormulario(pedido) });
      return;
    }

    if (acao === "SALVAR_CONTRATO") {
      const { linkRef, pedidoRef, pedido } = await carregarLinkPublico(token, "CONTRATO");
      const dadosContrato = body.dadosContrato || {};
      const valor = Number(body.valor || 0);
      const temNf = String(body.temNf || "NAO");
      const novoStatus = pedido.status === "PRE_RESERVA" ? "RESERVA" : pedido.status;

      await pedidoRef.update({
        dadosContrato,
        valor,
        temNf,
        status: novoStatus,
      });

      const pedidoAtualizado = {
        ...pedido,
        dadosContrato,
        valor,
        temNf,
        status: novoStatus,
      };

      const pdfReq = await chamarAppsScript({
        acao: "GERAR_PDF_CONTRATO",
        email_cliente: pedido.email,
        ...pedidoAtualizado,
        ...dadosContrato,
      });

      if (!pdfReq.success) {
        throw new Error(pdfReq.error || "Falha na geracao do PDF.");
      }

      const anexos = Array.isArray(pedido.anexos) ? [...pedido.anexos] : [];
      const countCt = anexos.filter((a) => String(a.nome || "").toUpperCase().includes("CONTRATO")).length;
      anexos.push({
        nome: `Contrato (${countCt + 1})`,
        url: pdfReq.pdfUrl,
        data: new Date().toISOString(),
      });

      await pedidoRef.update({
        anexos,
        linkContrato: "",
      });

      await linkRef.set({ ultimoUsoEm: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      sendJson(res, 200, { success: true, pdfUrl: pdfReq.pdfUrl });
      return;
    }

    if (acao === "SALVAR_NF") {
      const { linkRef, pedidoRef } = await carregarLinkPublico(token, "NF");
      await pedidoRef.update({
        dadosNf: body.dadosNf || {},
        nfStatus: "PENDENTE_CONTADOR",
      });
      await linkRef.set({ ultimoUsoEm: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      sendJson(res, 200, { success: true });
      return;
    }

    sendJson(res, 400, { success: false, error: "Acao invalida." });
  } catch (error) {
    logger.error("Erro no link publico.", error);
    const code = ["LINK_INVALIDO", "LINK_EXPIRADO", "PEDIDO_NAO_ENCONTRADO", "PEDIDO_INDISPONIVEL"].includes(error.message)
      ? 403
      : 500;
    sendJson(res, code, { success: false, error: error.message || "Erro interno." });
  }
});

exports.agendaApi = onRequest({
  region: REGION,
}, async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { success: false, error: "Metodo nao permitido." });
    return;
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const acao = String(body.acao || "");

    if (acao === "VERIFICAR_AGENDA_DIA") {
      const resultado = await verificarAgendaDia(body.dataBusca || body.dataStr);
      sendJson(res, 200, resultado);
      return;
    }

    if (acao === "SINCRONIZAR_PEDIDO_PUBLICO") {
      const pedidoId = String(body.pedidoId || "");
      const pedidoSnap = await db.collection("pedidos").doc(pedidoId).get();
      if (!pedidoSnap.exists) throw new Error("PEDIDO_NAO_ENCONTRADO");

      const pedido = pedidoSnap.data();
      const criadoEmMs = timestampMillis(pedido.criadoEm);
      const novoPedidoPublico = pedido.status === "PRE_RESERVA"
        && criadoEmMs
        && Date.now() - criadoEmMs < 30 * 60 * 1000;

      if (!novoPedidoPublico) throw new Error("NAO_AUTORIZADO");

      const resultado = await sincronizarPedidoComAgenda(pedidoId, "form_publico");
      sendJson(res, 200, resultado);
      return;
    }

    await exigirAdminAgenda(req);

    if (acao === "AGENDA_SINCRONIZAR_PEDIDO") {
      const resultado = await sincronizarPedidoComAgenda(String(body.pedidoId || ""), "painel");
      sendJson(res, 200, resultado);
      return;
    }

    if (acao === "AGENDA_CONFERIR") {
      const resultado = await conferirAgenda();
      sendJson(res, 200, resultado);
      return;
    }

    if (acao === "AGENDA_IMPORTAR_EVENTO") {
      const resultado = await importarEventoGoogleParaErp(String(body.eventId || ""));
      sendJson(res, 200, resultado);
      return;
    }

    sendJson(res, 400, { success: false, error: "Acao invalida." });
  } catch (error) {
    logger.error("Erro na API de agenda.", error);
    const code = ["NAO_AUTORIZADO", "PEDIDO_NAO_ENCONTRADO"].includes(error.message) ? 403 : 500;
    sendJson(res, code, { success: false, error: error.message || "Erro interno." });
  }
});

exports.sincronizarAgendaPedido = onDocumentWritten({
  document: "pedidos/{pedidoId}",
  region: REGION,
}, async (event) => {
  const beforeSnap = event.data?.before;
  const afterSnap = event.data?.after;
  const pedidoId = event.params.pedidoId;

  try {
    if (!afterSnap || !afterSnap.exists) {
      const before = beforeSnap?.exists ? beforeSnap.data() : null;
      if (before?.agendaId) {
        const calendar = await getCalendarClient();
        await deletarEventoAgenda(calendar, before.agendaId);
      }
      return;
    }

    const after = afterSnap.data();
    const before = beforeSnap?.exists ? beforeSnap.data() : null;

    if (before && !camposAgendaMudaram(before, after)) return;
    await sincronizarPedidoComAgenda(pedidoId, "gatilho_firestore");
  } catch (error) {
    logger.error("Falha ao sincronizar pedido com Google Agenda.", {
      pedidoId,
      error: String(error.message || error),
    });
    try {
      await db.collection("pedidos").doc(pedidoId).set({
        agendaSyncStatus: "ERRO",
        agendaSyncErro: String(error.message || error).slice(0, 500),
        agendaSyncAtualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    } catch (writeError) {
      logger.error("Falha ao gravar erro de sincronizacao da agenda.", writeError);
    }
  }
});

exports.notificarNovoOrcamento = onDocumentCreated({
  document: "pedidos/{pedidoId}",
  region: REGION,
  secrets: [VAPID_PRIVATE_KEY_SECRET],
}, async (event) => {
  const snap = event.data;
  if (!snap) return;

  const pedido = snap.data();
  if (pedido.status !== "PRE_RESERVA") return;

  await enviarPushPedido(pedido, event.params.pedidoId, snap.ref, "NOVO_PEDIDO");
});

exports.notificarAtualizacoesPedido = onDocumentWritten({
  document: "pedidos/{pedidoId}",
  region: REGION,
  secrets: [VAPID_PRIVATE_KEY_SECRET],
}, async (event) => {
  const beforeSnap = event.data?.before;
  const afterSnap = event.data?.after;

  if (!beforeSnap || !beforeSnap.exists || !afterSnap || !afterSnap.exists) return;

  const before = beforeSnap.data();
  const after = afterSnap.data();
  if (["REPROVADO", "LIXEIRA"].includes(after.status)) return;

  const contratoEntrou = (campoEntrou(before, after, "dadosContrato") || campoEntrou(before, after, "linkContrato"))
    && after.notificacaoPushContratoStatus !== "ENVIADO";
  const dadosNfEntraram = campoEntrou(before, after, "dadosNf")
    && after.notificacaoPushNfStatus !== "ENVIADO";

  if (contratoEntrou) {
    await enviarPushPedido(after, event.params.pedidoId, afterSnap.ref, "NOVO_CONTRATO");
  }

  if (dadosNfEntraram) {
    await enviarPushPedido(after, event.params.pedidoId, afterSnap.ref, "DADOS_NF");
  }
});

exports.espelharDisponibilidadePedido = onDocumentWritten({
  document: "pedidos/{pedidoId}",
  region: REGION,
}, async (event) => {
  const publicRef = db.collection("disponibilidade_publica").doc(event.params.pedidoId);
  const after = event.data?.after;

  if (!after || !after.exists) {
    await publicRef.delete();
    return;
  }

  const pedido = after.data();
  if (["REPROVADO", "LIXEIRA"].includes(pedido.status)) {
    await publicRef.delete();
    return;
  }

  await publicRef.set({
    dataStr: pedido.dataStr || pedido.data || "",
    horaInicio: pedido.horaInicio || "",
    horaTermino: pedido.horaTermino || calcularHoraTermino(pedido.horaInicio, pedido.duracao),
    duracao: pedido.duracao || "",
    cidade: pedido.cidade || "",
    uf: pedido.uf || "",
    status: pedido.status || "",
    statusAgenda: pedido.statusAgenda || "",
    tipo: pedido.tipo || "",
    agendaId: pedido.agendaId || "",
    agendaIcalUid: pedido.agendaIcalUid || "",
    atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: false });
});
