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
const PRODUCAO_EMAILS = ["sergiodobass@gmail.com"];

const STATUS_AGENDA = {
  PRE_RESERVA: { sufixo: "PRE-RESERVA", colorId: "7" },
  RESERVA: { sufixo: "RESERVA", colorId: "10" },
  CONFIRMADO: { sufixo: "CONFIRMADO", colorId: "3" },
};

const NOMES_CRIADORES_AGENDA = {
  "luciano.cinnamon@gmail.com": "Luciano",
  "sergiodobass@gmail.com": "Serginho",
};

function normalizarTextoBusca(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase();
}

function normalizarAtendimentoResponsavel(value, fallback = "") {
  const raw = normalizarTextoBusca(value);
  if (!raw) return fallback;
  if (raw.includes("SERG")) return "Serginho";
  if (raw.includes("LUCI")) return "Luciano";
  return fallback;
}

function atendimentoPorCriadorAgenda(criadorEmail = "", criadorNome = "") {
  const email = String(criadorEmail || "").trim().toLowerCase();
  if (email && NOMES_CRIADORES_AGENDA[email]) return NOMES_CRIADORES_AGENDA[email];
  const nome = normalizarAtendimentoResponsavel(criadorNome, "");
  return nome || "Luciano";
}

function atendimentoPedidoPadrao(pedido = {}) {
  const atendimentoInformado = normalizarAtendimentoResponsavel(pedido.atendimento, "");
  if (atendimentoInformado) return atendimentoInformado;

  const criadorEmail = pedido.origemCriadorEmail || pedido.criadorEmail || "";
  const criadorNome = pedido.origemCriadorNome || pedido.criadorNome || "";
  if (criadorEmail || criadorNome) return atendimentoPorCriadorAgenda(criadorEmail, criadorNome);

  return "Luciano";
}

function rolePorEmail(email = "") {
  const normalizado = String(email || "").trim().toLowerCase();
  if (ADMIN_EMAILS.includes(normalizado)) return "admin";
  if (PRODUCAO_EMAILS.includes(normalizado)) return "producao";
  return "";
}

function rolesPorClaims(claims = {}) {
  const roles = new Set();
  const role = String(claims.role || "").trim().toLowerCase();
  if (role === "admin" || role === "producao") roles.add(role);
  if (claims.admin === true) roles.add("admin");
  if (claims.producao === true) roles.add("producao");
  if (Array.isArray(claims.roles)) {
    claims.roles.forEach((item) => {
      const atual = String(item || "").trim().toLowerCase();
      if (atual === "admin" || atual === "producao") roles.add(atual);
    });
  }
  return [...roles];
}

function resolverRoleUsuario(decoded = {}) {
  const roles = rolesPorClaims(decoded);
  if (roles.length) return roles[0];
  return rolePorEmail(decoded.email || "");
}

function nomeUsuarioSistema(decoded = {}) {
  const role = resolverRoleUsuario(decoded);
  if (decoded.name) return String(decoded.name).trim();
  if (decoded.email) {
    const email = String(decoded.email).trim().toLowerCase();
    if (email === "luciano.cinnamon@gmail.com") return "Luciano";
    if (email === "sergiodobass@gmail.com") return "Serginho";
  }
  return role === "producao" ? "Produção" : "Admin";
}

function obterIpRequisicao(req) {
  const forwarded = String(req.get("x-forwarded-for") || "").split(",")[0].trim();
  return forwarded || req.ip || "";
}

function valorTextoSeguro(value, fallback = "") {
  return String(value ?? "").trim() || fallback;
}

function valorTextoOuVazio(value) {
  return String(value ?? "").trim();
}

function tituloCaseSimples(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

function linkFichaProducao(pedidoId = "") {
  const pedido = String(pedidoId || "").trim();
  if (!pedido) return "";
  try {
    const url = new URL(env("PANEL_URL", DEFAULT_PANEL_URL));
    url.searchParams.set("view", "producao");
    url.searchParams.set("pedido", pedido);
    return url.toString();
  } catch (error) {
    const base = env("PANEL_URL", DEFAULT_PANEL_URL);
    const separador = base.includes("?") ? "&" : "?";
    return `${base}${separador}view=producao&pedido=${encodeURIComponent(pedido)}`;
  }
}

function normalizarWhatsAppBr(value = "") {
  return String(value || "").replace(/\D/g, "").slice(0, 13);
}

function normalizarTimeCurto(value = "") {
  const raw = String(value || "").trim();
  return /^([01]?\d|2[0-3]):([0-5]\d)$/.test(raw) ? raw : "";
}

function normalizarSimNao(value = "") {
  const raw = normalizarTextoBusca(value);
  if (["S", "SIM", "TRUE"].includes(raw)) return "S";
  return "N";
}

function normalizarSonorizacao(value = "") {
  const raw = normalizarTextoBusca(value).toLowerCase();
  return raw === "propria" ? "propria" : "terceirizada";
}

function normalizarBateria(value = "") {
  const raw = normalizarTextoBusca(value).toLowerCase();
  return raw === "eletronica" ? "eletronica" : "acustica";
}

function normalizarTraje(value = "") {
  const raw = normalizarTextoBusca(value).toLowerCase();
  return raw === "normal" ? "NORMAL" : "SOCIAL";
}

function normalizarLocalMapsUrl(value = "") {
  const raw = valorTextoSeguro(value);
  if (!raw) return "";

  if (/^https?:\/\//i.test(raw)) return raw;

  if (/^(maps\.app\.goo\.gl|goo\.gl\/maps|www\.google\.com\/maps|google\.com\/maps|maps\.google\.com)\b/i.test(raw)) {
    return `https://${raw}`;
  }

  if (/^[\w.-]+\.[a-z]{2,}(?:[\/?#].*)?$/i.test(raw)) {
    return `https://${raw}`;
  }

  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(raw)}`;
}

function producaoEventoDefault(pedidoId, pedido = {}, existente = {}) {
  return {
    pedidoId,
    clienteSnapshot: valorTextoSeguro(pedido.cliente || pedido.nome_contratante_formal),
    dataEventoSnapshot: valorTextoSeguro(pedido.dataStr || pedido.data),
    cidadeUfSnapshot: [pedido.cidade || "", pedido.uf || ""].filter(Boolean).join("-"),
    horaShowInicioSnapshot: valorTextoSeguro(pedido.horaInicio),
    horaShowFimSnapshot: valorTextoSeguro(pedido.horaTermino || calcularHoraTermino(pedido.horaInicio, pedido.duracao)),
    localMapsUrl: normalizarLocalMapsUrl(existente.localMapsUrl || existente.localTexto),
    camarim: normalizarSimNao(existente.camarim),
    sonorizacaoTipo: normalizarSonorizacao(existente.sonorizacaoTipo),
    empresaSomId: valorTextoSeguro(existente.empresaSomId),
    empresaSomNome: valorTextoSeguro(existente.empresaSomNome),
    responsavelNome: valorTextoSeguro(existente.responsavelNome),
    responsavelWhatsapp: valorTextoSeguro(existente.responsavelWhatsapp),
    horaPassagemSom: normalizarTimeCurto(existente.horaPassagemSom),
    bateriaTipo: normalizarBateria(existente.bateriaTipo),
    figurinoTraje: normalizarTraje(existente.figurinoTraje),
    figurinoCor: valorTextoSeguro(existente.figurinoCor),
    observacoes: valorTextoSeguro(existente.observacoes),
  };
}

function producaoEventoPayload(body = {}, pedidoId, pedido = {}) {
  return {
    ...producaoEventoDefault(pedidoId, pedido, body),
    localMapsUrl: normalizarLocalMapsUrl(body.localMapsUrl || body.localTexto),
    camarim: normalizarSimNao(body.camarim),
    sonorizacaoTipo: normalizarSonorizacao(body.sonorizacaoTipo),
    empresaSomId: valorTextoSeguro(body.empresaSomId),
    empresaSomNome: valorTextoSeguro(body.empresaSomNome),
    responsavelNome: valorTextoSeguro(body.responsavelNome),
    responsavelWhatsapp: normalizarWhatsAppBr(body.responsavelWhatsapp),
    horaPassagemSom: normalizarTimeCurto(body.horaPassagemSom),
    bateriaTipo: normalizarBateria(body.bateriaTipo),
    figurinoTraje: normalizarTraje(body.figurinoTraje),
    figurinoCor: valorTextoSeguro(body.figurinoCor),
    observacoes: valorTextoSeguro(body.observacoes),
  };
}

function campoMudou(before = {}, after = {}, campo) {
  return JSON.stringify(before?.[campo] ?? null) !== JSON.stringify(after?.[campo] ?? null);
}

async function registrarLogsProducao(pedidoId, before = {}, after = {}, actor = {}) {
  const campos = [
    ["localMapsUrl", "Local"],
    ["camarim", "Camarim"],
    ["sonorizacaoTipo", "Sonorização"],
    ["empresaSomNome", "Empresa"],
    ["responsavelNome", "Responsável no evento"],
    ["responsavelWhatsapp", "WhatsApp responsável"],
    ["horaPassagemSom", "Hora passagem de som"],
    ["bateriaTipo", "Bateria"],
    ["figurinoTraje", "Traje"],
    ["figurinoCor", "Cor figurino"],
    ["observacoes", "Observações"],
  ];

  const batch = db.batch();
  let mudou = false;
  campos.forEach(([campo, label]) => {
    if (!campoMudou(before, after, campo)) return;
    mudou = true;
    const ref = db.collection("pedidos").doc(pedidoId).collection("logs").doc();
    const antes = valorTextoSeguro(before?.[campo], "vazio");
    const depois = valorTextoSeguro(after?.[campo], "vazio");
    batch.set(ref, {
      type: "producao_change",
      field: campo,
      before: before?.[campo] ?? "",
      after: after?.[campo] ?? "",
      message: `${actor.nome || "Usuário"} alterou ${label} de "${antes}" para "${depois}"`,
      actorUid: actor.uid || "",
      actorEmail: actor.email || "",
      actorName: actor.nome || "",
      actorRole: actor.role || "",
      source: "painel_producao",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
  if (mudou) await batch.commit();
}

async function carregarProducaoEvento(pedidoId, pedido = {}) {
  if (!pedidoId) return null;
  const snap = await db.collection("producao_eventos").doc(pedidoId).get();
  if (!snap.exists) return producaoEventoDefault(pedidoId, pedido, {});
  return {
    ...producaoEventoDefault(pedidoId, pedido, snap.data()),
    ...snap.data(),
  };
}

async function listarParceirosSom() {
  const snapshot = await db.collection("parceiros_som").orderBy("nomeNormalizado").get();
  return snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
}

function nomeNormalizadoParceiro(nome = "") {
  return normalizarTextoBusca(nome).toLowerCase();
}

async function registrarTentativaAcessoProducao(req, pedidoId = "", decoded = null) {
  const role = resolverRoleUsuario(decoded || {});
  const payload = {
    type: "unauthorized_magic_link",
    pedidoId: String(pedidoId || "").trim(),
    uid: decoded?.uid || "",
    email: String(decoded?.email || "").toLowerCase(),
    role,
    ip: obterIpRequisicao(req),
    userAgent: String(req.get("user-agent") || ""),
    path: String(req.originalUrl || req.url || ""),
    source: "link_producao",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await db.collection("security_events").add(payload);

  if (payload.pedidoId) {
    await db.collection("pedidos").doc(payload.pedidoId).collection("logs").add({
      type: "security",
      field: "producao_link_access",
      before: "",
      after: "",
      message: `${payload.email || "Usuario nao autorizado"} tentou acessar a ficha de producao sem permissao.`,
      actorUid: payload.uid,
      actorEmail: payload.email,
      actorName: nomeUsuarioSistema(decoded || {}),
      actorRole: role,
      source: "magic_link",
      ip: payload.ip,
      userAgent: payload.userAgent,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
}

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

const CAMPOS_PROPAGADOS_GRUPO = [
  "status",
  "cliente",
  "documento",
  "documentoLimpo",
  "whatsapp",
  "email",
  "cidade",
  "uf",
  "local",
  "tipo",
  "convidados",
  "atendimento",
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

function montarInicioFimAgenda(pedido, producao = null) {
  const parsed = parseDataEvento(pedido.dataStr || pedido.data);
  if (!parsed) throw new Error("DATA_EVENTO_INVALIDA");

  const inicioShow = parseHorario(pedido.horaInicio || "19:00");
  const inicioShowMinutos = (inicioShow.hora * 60) + inicioShow.minuto;
  const duracaoMinutos = parseDuracaoMinutos(pedido.duracao, 120);
  const horaTerminoPedido = normalizarTimeCurto(pedido.horaTermino);
  let fimShowTotal = inicioShowMinutos + duracaoMinutos;

  if (horaTerminoPedido) {
    const fimShow = parseHorario(horaTerminoPedido);
    fimShowTotal = (fimShow.hora * 60) + fimShow.minuto;
    if (fimShowTotal <= inicioShowMinutos) fimShowTotal += 1440;
  }

  const inicioAgendaRaw = normalizarTimeCurto(producao?.horaPassagemSom)
    ? parseHorario(producao.horaPassagemSom)
    : inicioShow;
  let inicioAgendaMinutos = (inicioAgendaRaw.hora * 60) + inicioAgendaRaw.minuto;
  if (inicioAgendaMinutos > fimShowTotal) inicioAgendaMinutos = inicioShowMinutos;

  const fimTotal = Math.max(fimShowTotal, inicioAgendaMinutos + 15);
  const fimOffsetDias = Math.floor(fimTotal / 1440);
  const fimMinutos = fimTotal % 1440;
  const parsedFim = somarDiasData(parsed, fimOffsetDias);

  return {
    data: parsed,
    dataIso: formatarDataIsoLocal(parsed),
    inicio: `${String(Math.floor(inicioAgendaMinutos / 60)).padStart(2, "0")}:${String(inicioAgendaMinutos % 60).padStart(2, "0")}`,
    fim: `${String(Math.floor(fimMinutos / 60)).padStart(2, "0")}:${String(fimMinutos % 60).padStart(2, "0")}`,
    inicioShow: `${String(inicioShow.hora).padStart(2, "0")}:${String(inicioShow.minuto).padStart(2, "0")}`,
    fimShow: `${String(Math.floor(fimShowTotal % 1440 / 60)).padStart(2, "0")}:${String(fimShowTotal % 60).padStart(2, "0")}`,
    start: {
      dateTime: `${formatarDataIsoLocal(parsed)}T${String(Math.floor(inicioAgendaMinutos / 60)).padStart(2, "0")}:${String(inicioAgendaMinutos % 60).padStart(2, "0")}:00`,
      timeZone: CALENDAR_TIME_ZONE,
    },
    end: {
      dateTime: `${formatarDataIsoLocal(parsedFim)}T${String(Math.floor(fimMinutos / 60)).padStart(2, "0")}:${String(fimMinutos % 60).padStart(2, "0")}:00`,
      timeZone: CALENDAR_TIME_ZONE,
    },
    duracaoMinutos: Math.max(15, fimTotal - inicioAgendaMinutos),
    duracaoShowMinutos: Math.max(15, fimShowTotal - inicioShowMinutos),
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

function localAgendaPedido(pedido, producao = null, fallback = "") {
  const localProducao = normalizarLocalMapsUrl(producao?.localMapsUrl || producao?.localTexto);
  if (localProducao) return localProducao;

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

function montarDescricaoAgenda(pedido, producao = null, eventoExistente = null) {
  const anterior = parseDescricaoAgenda(eventoExistente?.description || "");
  const cliente = normalizarTextoAgenda(pedido.cliente || pedido.nome_contratante_formal, "CLIENTE");
  const whatsapp = safeText(pedido.whatsapp, anterior.whatsapp || "S/ WHATSAPP");
  const valorPedido = pedido.valor_final_contrato ?? pedido.valor;
  const valor = valorPedido !== undefined && valorPedido !== ""
    ? `R$ ${Number(valorPedido || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`
    : (anterior.valor || "R$ 0,00");
  const periodo = montarInicioFimAgenda(pedido, producao);
  const empresaSom = valorTextoOuVazio(producao?.empresaSomNome);
  const responsavel = valorTextoOuVazio(producao?.responsavelNome);
  const whatsappResponsavel = valorTextoOuVazio(producao?.responsavelWhatsapp);
  const passagemSom = valorTextoOuVazio(producao?.horaPassagemSom);
  const sonorizacao = producao?.sonorizacaoTipo ? tituloCaseSimples(producao.sonorizacaoTipo) : "";
  const bateria = producao?.bateriaTipo ? tituloCaseSimples(producao.bateriaTipo) : (anterior.bateria || "");
  const trajeBase = producao?.figurinoTraje ? tituloCaseSimples(producao.figurinoTraje) : "";
  const trajeCor = valorTextoOuVazio(producao?.figurinoCor);
  const traje = [trajeBase, trajeCor].filter(Boolean).join(" - ") || anterior.traje || "";
  const observacoes = valorTextoOuVazio(producao?.observacoes) || anterior.obs || "";
  const camarim = producao?.camarim === "S" ? "Sim" : (producao?.camarim === "N" ? "Nao" : "");
  const linkProducao = linkFichaProducao(pedido.id || pedido.pedidoId || "");

  return [
    `CLIENTE: ${cliente}`,
    `WHATSAPP CLIENTE: ${whatsapp}`,
    `VALOR: ${valor}`,
    `INICIO DO SHOW: ${periodo.inicioShow}`,
    `TERMINO DO SHOW: ${periodo.fimShow}`,
    passagemSom ? `PASSAGEM DE SOM: ${passagemSom}` : "",
    sonorizacao ? `SONORIZACAO: ${sonorizacao}` : "",
    empresaSom ? `EMPRESA DE SOM: ${empresaSom}` : "",
    responsavel ? `RESPONSAVEL NO EVENTO: ${responsavel}` : "",
    whatsappResponsavel ? `WHATSAPP RESPONSAVEL: ${whatsappResponsavel}` : "",
    camarim ? `CAMARIM: ${camarim}` : "",
    bateria ? `BATERIA: ${bateria}` : "",
    traje ? `TRAJE: ${traje}` : "",
    observacoes ? `OBSERVACOES: ${observacoes}` : "",
    linkProducao ? `Acessar Ficha de Producao: ${linkProducao}` : "",
  ].filter(Boolean).join("\n");
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

function roleAssinaturaPush(data = {}) {
  const role = String(data.role || "").trim().toLowerCase();
  if (role === "admin" || role === "producao") return role;
  return rolePorEmail(data.email || "");
}

function emailsRelacionadosPedido(pedido = {}) {
  return [
    pedido.ownerEmail,
    pedido.createdByEmail,
    pedido.criadorEmail,
    pedido.origemCriadorEmail,
  ].map((item) => String(item || "").trim().toLowerCase()).filter(Boolean);
}

function uidsRelacionadosPedido(pedido = {}) {
  return [
    pedido.ownerUid,
    pedido.createdByUid,
    pedido.criadorUid,
  ].map((item) => String(item || "").trim()).filter(Boolean);
}

function assinaturaPodeReceberPush(data = {}, pedido = {}) {
  const role = roleAssinaturaPush(data);
  if (role === "admin") return true;
  if (role !== "producao") return false;

  const email = String(data.email || "").trim().toLowerCase();
  const uid = String(data.uid || "").trim();
  if (email && emailsRelacionadosPedido(pedido).includes(email)) return true;
  if (uid && uidsRelacionadosPedido(pedido).includes(uid)) return true;

  const atendimento = atendimentoPedidoPadrao(pedido);
  if (atendimento === "Serginho" && (!email || PRODUCAO_EMAILS.includes(email))) return true;

  return false;
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

  const subscriptionsDocs = subscriptionsSnap.docs.filter((subscriptionDoc) =>
    assinaturaPodeReceberPush(subscriptionDoc.data() || {}, pedido),
  );
  if (!subscriptionsDocs.length) {
    await atualizarStatusPush(pedidoRef, tipoNotificacao, "SEM_INSCRICOES", {
      [`${prefixoStatusPush(tipoNotificacao)}Erro`]: "Nenhuma inscricao elegivel para este pedido.",
    });
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

  await Promise.all(subscriptionsDocs.map(async (subscriptionDoc) => {
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
  if (value?.seconds) return Number(value.seconds) * 1000;
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function numeroFinanceiro(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  const normalized = raw
    .replace(/[^\d,.-]/g, "")
    .replace(/\.(?=\d{3}(?:\D|$))/g, "")
    .replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function arredondarNumero(value, casas = 2) {
  const fator = 10 ** casas;
  return Math.round((Number(value) || 0) * fator) / fator;
}

function partesDataLocal(value) {
  const millis = timestampMillis(value);
  if (!millis) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CALENDAR_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(millis)).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return {
    ano: Number(parts.year),
    mes: Number(parts.month),
    dia: Number(parts.day),
  };
}

function dataIsoOuVazio(value) {
  const millis = timestampMillis(value);
  return millis ? new Date(millis).toISOString() : "";
}

function normalizarStatusConversao(status) {
  const raw = String(status || "PRE_RESERVA")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\s-]+/g, "_")
    .toUpperCase();
  if (raw === "PRE_RESERVA" || raw === "PRE") return "PRE_RESERVA";
  if (raw === "RESERVA") return "RESERVA";
  if (raw === "CONFIRMADO") return "CONFIRMADO";
  if (raw === "REPROVADO") return "REPROVADO";
  return raw || "PRE_RESERVA";
}

function dataInsercaoLeadPedido(pedido) {
  return pedido.data_insercao_lead
    || pedido.dataInsercaoLead
    || pedido.criadoEm
    || pedido.createdAt
    || pedido.dataCriacao
    || null;
}

function dataEnvioOrcamentoPedido(pedido) {
  return pedido.data_envio_orcamento
    || pedido.dataEnvioOrcamento
    || pedido.orcamentoEnviadoEm
    || null;
}

function dataReservaPedido(pedido) {
  return pedido.data_reserva
    || pedido.dataReserva
    || pedido.data_envio_orcamento
    || pedido.dataEnvioOrcamento
    || pedido.orcamentoEnviadoEm
    || null;
}

function dataConfirmacaoPedido(pedido) {
  return pedido.data_confirmacao
    || pedido.dataConfirmacao
    || pedido.confirmadoEm
    || null;
}

function dataReprovacaoPedido(pedido) {
  return pedido.data_reprovacao
    || pedido.dataReprovacao
    || pedido.reprovadoEm
    || null;
}

function normalizarFollowupPerda(status, statusEvento = "") {
  if (statusEvento !== "REPROVADO") return "";
  const raw = String(status || "PENDENTE")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\s-]+/g, "_")
    .toUpperCase();
  const validos = ["PENDENTE", "TRATADA", "REATIVAR_DEPOIS", "REATIVADA", "SEM_INTERESSE_FINAL"];
  return validos.includes(raw) ? raw : "PENDENTE";
}

function ehLeadComercialConversao(pedido) {
  const origem = String(pedido.origem || "").toLowerCase();
  if (["google_calendar", "google_calendar_manual"].includes(origem)) return false;
  if (pedido.origemCriadorEmail || pedido.origemCriadorNome) return false;
  return true;
}

function gerarInsightsConversao({ funil, receita, atendimento }) {
  const insights = [];

  if (funil.total_leads === 0) {
    insights.push("Nenhum lead inserido neste periodo.");
    return insights;
  }

  if (funil.taxa_fechamento === null) {
    insights.push("Ainda nao ha propostas enviadas suficientes para medir fechamento.");
  } else if (funil.taxa_fechamento > 30) {
    insights.push("Taxa de fechamento acima de 30%: excelente eficiencia comercial sobre propostas enviadas.");
  } else if (funil.taxa_fechamento >= 15) {
    insights.push("Taxa de fechamento intermediaria: vale revisar follow-up e proposta.");
  } else {
    insights.push("Taxa de fechamento baixa: existe oportunidade de qualificar abordagem e negociacao.");
  }

  if (funil.taxa_rejeicao >= 35) {
    insights.push("Taxa de rejeicao alta: investigue motivos de perda e ajuste oferta/comunicacao.");
  }

  if (atendimento.tempo_medio_atendimento_horas === null) {
    insights.push("Ainda nao ha base valida para medir tempo medio de atendimento.");
  } else if (atendimento.tempo_medio_atendimento_horas > 24) {
    insights.push("Tempo medio de atendimento alto pode estar impactando conversoes.");
  } else if (atendimento.tempo_medio_atendimento_horas <= 6) {
    insights.push("Atendimento comercial rapido: bom sinal para conversao de leads.");
  }

  if (funil.leads_nao_atendidos > 0) {
    insights.push(`${funil.leads_nao_atendidos} lead(s) ainda em pre-reserva aguardando atendimento.`);
  }

  if (receita.receita_perdida > receita.receita_fechada && receita.receita_perdida > 0) {
    insights.push("Alto volume de receita perdida indica oportunidade de remarketing.");
  }

  if (receita.receita_pendente > receita.receita_fechada) {
    insights.push("Pipeline pendente maior que a receita fechada: priorize follow-up dos leads e reservas.");
  }

  return insights;
}

async function calcularDadosConversao(mes, ano) {
  const mesNum = Number(mes);
  const anoNum = Number(ano);
  if (!Number.isInteger(mesNum) || mesNum < 1 || mesNum > 12 || !Number.isInteger(anoNum)) {
    throw new Error("PARAMETROS_INVALIDOS");
  }

  const snapshot = await db.collection("pedidos").get();
  const registros = [];

  snapshot.forEach((docSnap) => {
    const pedido = { id: docSnap.id, ...docSnap.data() };
    if (!ehLeadComercialConversao(pedido)) return;

    const dataLead = dataInsercaoLeadPedido(pedido);
    const partes = partesDataLocal(dataLead);
    if (!partes || partes.mes !== mesNum || partes.ano !== anoNum) return;

    const status = normalizarStatusConversao(pedido.status_evento || pedido.status);
    if (status === "LIXEIRA") return;

    const dataEnvio = dataEnvioOrcamentoPedido(pedido);
    const dataReserva = dataReservaPedido(pedido);
    const dataConfirmacao = dataConfirmacaoPedido(pedido);
    const dataReprovacao = dataReprovacaoPedido(pedido);
    const valor = numeroFinanceiro(pedido.valor_orcamento ?? pedido.valor ?? pedido.valor_final_contrato);
    const cidade = safeText(pedido.cidade || "", "");
    const uf = safeText(pedido.uf || "", "");
    const local = safeText(pedido.local || pedido.localEvento || pedido.endereco || [cidade, uf].filter(Boolean).join(" - "), "");
    const disponibilidade = disponibilidadePush(pedido);
    const statusFollowupPerda = normalizarFollowupPerda(
      pedido.status_followup_perda || pedido.statusFollowupPerda,
      status,
    );

    registros.push({
      id: pedido.id,
      cliente: safeText(pedido.cliente || pedido.nome_contratante_formal, "Cliente"),
      whatsapp: String(pedido.whatsapp || pedido.telefone || pedido.celular || ""),
      email: safeText(pedido.email || pedido.email_contratante || pedido.emailCliente, ""),
      documento: safeText(pedido.documento || pedido.cpfCnpj || pedido.cpf_cnpj || "", ""),
      tipo_evento: safeText(pedido.tipo_evento || pedido.tipo, "EVENTO"),
      data_evento: pedido.dataStr || pedido.data || "",
      hora_inicio: safeText(pedido.horaInicio || pedido.hora_inicio || pedido.hora || "", ""),
      hora_termino: safeText(pedido.horaTermino || pedido.hora_termino || "", ""),
      duracao: safeText(pedido.duracao || "", ""),
      cidade,
      uf,
      local,
      convidados: safeText(pedido.convidados || pedido.numeroConvidados || pedido.qtdConvidados || pedido.quantidade_convidados || "", ""),
      data_insercao_lead: dataLead,
      data_envio_orcamento: dataEnvio,
      data_reserva: dataReserva,
      data_confirmacao: dataConfirmacao,
      data_reprovacao: dataReprovacao,
      status_evento: status,
      disponibilidade,
      status_followup_perda: statusFollowupPerda,
      followup_perda_atualizado_em: pedido.followup_perda_atualizado_em || pedido.followupPerdaAtualizadoEm || null,
      followup_perda_tratado_em: pedido.followup_perda_tratado_em || pedido.followupPerdaTratadoEm || null,
      valor_orcamento: valor,
      motivo_reprovacao: pedido.motivo_reprovacao || pedido.motivoReprovacao || "",
      motivo_reprovacao_observacao: pedido.motivo_reprovacao_observacao || "",
    });
  });

  const resumoDetalhadoConversao = (item) => ({
    id: item.id,
    cliente: item.cliente,
    whatsapp: item.whatsapp,
    email: item.email,
    documento: item.documento,
    tipo_evento: item.tipo_evento,
    data_evento: item.data_evento,
    hora_inicio: item.hora_inicio,
    hora_termino: item.hora_termino,
    duracao: item.duracao,
    cidade: item.cidade,
    uf: item.uf,
    local: item.local,
    convidados: item.convidados,
    data_insercao_lead: dataIsoOuVazio(item.data_insercao_lead),
    data_envio_orcamento: dataIsoOuVazio(item.data_envio_orcamento),
    data_reserva: dataIsoOuVazio(item.data_reserva),
    data_confirmacao: dataIsoOuVazio(item.data_confirmacao),
    data_reprovacao: dataIsoOuVazio(item.data_reprovacao),
    status_evento: item.status_evento,
    disponibilidade: item.disponibilidade,
    status_followup_perda: item.status_followup_perda,
    followup_perda_atualizado_em: dataIsoOuVazio(item.followup_perda_atualizado_em),
    followup_perda_tratado_em: dataIsoOuVazio(item.followup_perda_tratado_em),
    valor: arredondarNumero(item.valor_orcamento),
    tempo_atendimento_horas: item.tempo_atendimento_horas ?? null,
    motivo_reprovacao: item.motivo_reprovacao,
    motivo_reprovacao_observacao: item.motivo_reprovacao_observacao,
  });

  const ordenarPorDataEvento = (a, b) => {
    const dataA = timestampMillis(a.data_evento) || timestampMillis(a.data_insercao_lead) || 0;
    const dataB = timestampMillis(b.data_evento) || timestampMillis(b.data_insercao_lead) || 0;
    return dataA - dataB || String(a.cliente).localeCompare(String(b.cliente), "pt-BR");
  };

  const totalLeads = registros.length;
  const totalReservas = registros.filter((item) => item.status_evento === "RESERVA").length;
  const totalConfirmados = registros.filter((item) => item.status_evento === "CONFIRMADO").length;
  const totalReprovados = registros.filter((item) => item.status_evento === "REPROVADO").length;
  const leadsAtendidos = registros.filter((item) => item.status_evento !== "PRE_RESERVA").length;
  const leadsNaoAtendidos = registros.filter((item) => item.status_evento === "PRE_RESERVA").length;

  const receitaFechada = registros
    .filter((item) => item.status_evento === "CONFIRMADO")
    .reduce((acc, item) => acc + item.valor_orcamento, 0);
  const receitaPendente = registros
    .filter((item) => item.status_evento === "RESERVA")
    .reduce((acc, item) => acc + item.valor_orcamento, 0);
  const receitaPerdida = registros
    .filter((item) => item.status_evento === "REPROVADO")
    .reduce((acc, item) => acc + item.valor_orcamento, 0);
  const perdasPendentes = registros
    .filter((item) => item.status_evento === "REPROVADO" && item.status_followup_perda === "PENDENTE");
  const receitaPerdidaPendenteAcao = perdasPendentes
    .reduce((acc, item) => acc + item.valor_orcamento, 0);

  registros.forEach((item) => {
    const inicio = timestampMillis(item.data_insercao_lead);
    const reserva = timestampMillis(item.data_reserva);
    item.tempo_atendimento_horas = item.status_evento !== "PRE_RESERVA" && inicio && reserva && reserva >= inicio
      ? arredondarNumero((reserva - inicio) / (1000 * 60 * 60))
      : null;
  });

  const temposAtendimento = registros
    .map((item) => {
      if (item.status_evento === "PRE_RESERVA") return null;
      const inicio = timestampMillis(item.data_insercao_lead);
      const reserva = timestampMillis(item.data_reserva);
      if (!inicio || !reserva || reserva < inicio) return null;
      return (reserva - inicio) / (1000 * 60 * 60);
    })
    .filter((value) => Number.isFinite(value));

  const tempoMedioAtendimento = temposAtendimento.length
    ? arredondarNumero(temposAtendimento.reduce((acc, value) => acc + value, 0) / temposAtendimento.length)
    : null;
  const taxaFechamento = leadsAtendidos ? arredondarNumero((totalConfirmados / leadsAtendidos) * 100) : null;
  const taxaAtendimento = totalLeads ? arredondarNumero((leadsAtendidos / totalLeads) * 100) : null;

  const funil = {
    total_leads: totalLeads,
    leads_atendidos: leadsAtendidos,
    leads_nao_atendidos: leadsNaoAtendidos,
    confirmados: totalConfirmados,
    reprovados: totalReprovados,
    em_negociacao: totalReservas,
    total_reservas: totalReservas,
    total_confirmados: totalConfirmados,
    total_reprovados: totalReprovados,
    taxa_fechamento: taxaFechamento,
    taxa_atendimento: taxaAtendimento,
    taxa_conversao: taxaFechamento,
    taxa_rejeicao: totalLeads ? arredondarNumero((totalReprovados / totalLeads) * 100) : 0,
    taxa_lead_para_reserva: taxaAtendimento,
    taxa_reserva_para_confirmado: taxaFechamento,
  };

  const receita = {
    receita_fechada: arredondarNumero(receitaFechada),
    receita_pendente: arredondarNumero(receitaPendente),
    receita_perdida: arredondarNumero(receitaPerdida),
    receita_perdida_pendente_acao: arredondarNumero(receitaPerdidaPendenteAcao),
    perdas_pendentes_acao: perdasPendentes.length,
  };

  const followupPerdas = {
    total_reprovados: totalReprovados,
    pendentes: perdasPendentes.length,
    receita_pendente_acao: arredondarNumero(receitaPerdidaPendenteAcao),
  };

  const atendimento = {
    tempo_medio_atendimento_horas: tempoMedioAtendimento,
    total_leads_sem_resposta: leadsNaoAtendidos,
    total_com_base_tempo: temposAtendimento.length,
  };

  const sla = {
    tempo_medio_resposta_horas: tempoMedioAtendimento,
    tempo_medio_atendimento_horas: tempoMedioAtendimento,
    total_leads_sem_resposta: leadsNaoAtendidos,
    total_com_base_tempo: temposAtendimento.length,
  };

  const perdasTop5 = registros
    .filter((item) => item.status_evento === "REPROVADO")
    .sort((a, b) => b.valor_orcamento - a.valor_orcamento)
    .slice(0, 5)
    .map((item) => ({
      ...resumoDetalhadoConversao(item),
      data: dataIsoOuVazio(item.data_insercao_lead),
    }));

  const detalhes = {
    leads: registros
      .slice()
      .sort(ordenarPorDataEvento)
      .map(resumoDetalhadoConversao),
    atendidos: registros
      .filter((item) => item.status_evento !== "PRE_RESERVA")
      .sort(ordenarPorDataEvento)
      .map(resumoDetalhadoConversao),
    nao_atendidos: registros
      .filter((item) => item.status_evento === "PRE_RESERVA")
      .sort(ordenarPorDataEvento)
      .map(resumoDetalhadoConversao),
    em_negociacao: registros
      .filter((item) => item.status_evento === "RESERVA")
      .sort(ordenarPorDataEvento)
      .map(resumoDetalhadoConversao),
    confirmados: registros
      .filter((item) => item.status_evento === "CONFIRMADO")
      .sort(ordenarPorDataEvento)
      .map(resumoDetalhadoConversao),
    reprovados: registros
      .filter((item) => item.status_evento === "REPROVADO")
      .sort((a, b) => b.valor_orcamento - a.valor_orcamento)
      .map(resumoDetalhadoConversao),
    perdas_pendentes: perdasPendentes
      .slice()
      .sort((a, b) => b.valor_orcamento - a.valor_orcamento)
      .map(resumoDetalhadoConversao),
    leads_sem_resposta: registros
      .filter((item) => item.status_evento === "PRE_RESERVA")
      .sort(ordenarPorDataEvento)
      .map(resumoDetalhadoConversao),
    atendidos_com_tempo: registros
      .filter((item) => item.status_evento !== "PRE_RESERVA" && item.tempo_atendimento_horas !== null)
      .sort((a, b) => a.tempo_atendimento_horas - b.tempo_atendimento_horas)
      .map(resumoDetalhadoConversao),
  };

  return {
    success: true,
    mes: mesNum,
    ano: anoNum,
    funil,
    receita,
    followup_perdas: followupPerdas,
    atendimento,
    sla,
    perdas_top5: perdasTop5,
    detalhes,
    insights: gerarInsightsConversao({ funil, receita, atendimento }),
  };
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

function variantesAgendaId(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];

  const variantes = new Set([raw]);
  if (raw.includes("@")) variantes.add(raw.split("@")[0]);
  return [...variantes].filter(Boolean);
}

function adicionarVariantesAgenda(set, value) {
  variantesAgendaId(value).forEach((item) => set.add(item));
}

function eventoRelacionadoPorIds(event, ids, icals = ids) {
  const chaves = [
    ...variantesAgendaId(event?.id),
    ...variantesAgendaId(event?.iCalUID),
  ];
  return chaves.some((chave) => ids.has(chave) || icals.has(chave));
}

async function buscarEventoAgenda(calendar, agendaId) {
  const id = String(agendaId || "").trim();
  if (!id) return null;

  const calendarId = getCalendarId();
  const tentativasGet = variantesAgendaId(id);

  for (const eventId of tentativasGet) {
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

async function buscarEventoPorAssinaturaPedido(calendar, pedido, producao = null) {
  const assinatura = assinaturaAgendaPedido(pedido, producao);
  if (!assinatura) return null;

  const periodo = montarInicioFimAgenda(pedido, producao);
  const diaSeguinte = formatarDataIsoLocal(somarDiasData(periodo.data, 1));
  const { data } = await calendar.events.list({
    calendarId: getCalendarId(),
    timeMin: `${periodo.dataIso}T00:00:00-03:00`,
    timeMax: `${diaSeguinte}T00:00:00-03:00`,
    singleEvents: true,
    orderBy: "startTime",
    showDeleted: false,
    maxResults: 50,
  });

  return (data.items || []).find((event) => assinaturaAgendaEvento(event) === assinatura) || null;
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

function recursoEventoAgenda(pedido, eventoExistente = null, producao = null) {
  const periodo = montarInicioFimAgenda(pedido, producao);
  const status = statusConfigAgenda(pedido.status);
  const location = localAgendaPedido(pedido, producao, eventoExistente?.location || "");
  const description = montarDescricaoAgenda(pedido, producao, eventoExistente);
  const projectionHash = [
    tituloAgendaPedido(pedido),
    location,
    periodo.start.dateTime,
    periodo.end.dateTime,
    String(description.length),
    description.slice(0, 120),
  ].join("|").slice(0, 480);

  return {
    summary: tituloAgendaPedido(pedido),
    location,
    description,
    start: periodo.start,
    end: periodo.end,
    colorId: status.colorId,
    extendedProperties: {
      private: {
        pedidoId: String(pedido.id || pedido.pedidoId || ""),
        source: "gestao_master",
        projectionHash,
      },
    },
  };
}

async function sincronizarDocumentoPedidoComAgenda(pedidoRef, pedidoId, pedido, origem = "manual") {
  const calendar = await getCalendarClient();
  const pedidoComId = { id: pedidoId, ...pedido };
  const agendaIdAtual = pedidoComId.agendaId || pedidoComId.agendaEventId || "";
  const producao = await carregarProducaoEvento(pedidoId, pedidoComId);

  if (!statusAtivoAgenda(pedidoComId.status)) {
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

  let eventoExistente = agendaIdAtual ? await buscarEventoAgenda(calendar, agendaIdAtual) : null;
  if (!eventoExistente) {
    eventoExistente = await buscarEventoPorAssinaturaPedido(calendar, pedidoComId, producao);
  }
  const resource = recursoEventoAgenda(pedidoComId, eventoExistente, producao);
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

async function sincronizarPedidoComAgenda(pedidoId, origem = "manual") {
  if (!pedidoId) throw new Error("PEDIDO_ID_OBRIGATORIO");

  const pedidoRef = db.collection("pedidos").doc(pedidoId);
  const pedidoSnap = await pedidoRef.get();
  if (!pedidoSnap.exists) throw new Error("PEDIDO_NAO_ENCONTRADO");

  return sincronizarDocumentoPedidoComAgenda(pedidoRef, pedidoId, pedidoSnap.data(), origem);
}

async function sincronizarGrupoPorPedidoId(pedidoId, origem = "manual") {
  const grupo = await carregarGrupoPedido(pedidoId);
  const resultados = [];

  for (const pedido of grupo.pedidos) {
    const pedidoRef = db.collection("pedidos").doc(pedido.id);
    const resultado = await sincronizarDocumentoPedidoComAgenda(pedidoRef, pedido.id, pedido, origem);
    resultados.push({ pedidoId: pedido.id, ...resultado });
  }

  const principalResultado = resultados.find((item) => item.pedidoId === grupo.principalId) || resultados[0] || { success: true };
  return {
    success: true,
    grupoId: grupo.grupoId,
    principalId: grupo.principalId,
    agendaId: principalResultado.agendaId || "",
    agendaIcalUid: principalResultado.agendaIcalUid || "",
    resultados,
  };
}

function camposAgendaMudaram(before = {}, after = {}) {
  return CAMPOS_RELEVANTES_AGENDA.some((campo) => JSON.stringify(before[campo] ?? null) !== JSON.stringify(after[campo] ?? null));
}

function patchDatasEstagio(before = {}, after = {}) {
  const statusAnterior = normalizarStatusConversao(before.status);
  const statusAtual = normalizarStatusConversao(after.status);
  const patch = {};

  if (statusAtual === statusAnterior) return patch;
  if (statusAtual === "RESERVA" && !after.data_reserva && !after.dataReserva) {
    patch.data_reserva = admin.firestore.FieldValue.serverTimestamp();
  }
  if (statusAtual === "RESERVA" && !after.data_envio_orcamento && !after.dataEnvioOrcamento) {
    patch.data_envio_orcamento = admin.firestore.FieldValue.serverTimestamp();
  }
  if (statusAtual === "CONFIRMADO" && !after.data_confirmacao && !after.dataConfirmacao) {
    patch.data_confirmacao = admin.firestore.FieldValue.serverTimestamp();
  }
  if (statusAtual === "REPROVADO" && !after.data_reprovacao && !after.dataReprovacao) {
    patch.data_reprovacao = admin.firestore.FieldValue.serverTimestamp();
  }
  if (statusAtual === "REPROVADO" && !after.status_followup_perda && !after.statusFollowupPerda) {
    patch.status_followup_perda = "PENDENTE";
  }

  return patch;
}

function patchAtendimentoPedido(before = {}, after = {}) {
  const atendimentoAtual = normalizarAtendimentoResponsavel(after.atendimento, "");
  if (atendimentoAtual) {
    return String(after.atendimento || "").trim() === atendimentoAtual ? {} : { atendimento: atendimentoAtual };
  }

  return { atendimento: atendimentoPedidoPadrao(after) };
}

function ehSubeventoPedido(pedidoId = "", pedido = {}) {
  return Boolean(pedido?.ehSubevento && pedido?.eventoPrincipalId && pedido.eventoPrincipalId !== pedidoId);
}

function grupoIdPedido(pedidoId = "", pedido = {}) {
  return String(pedido?.grupoId || pedido?.eventoPrincipalId || pedidoId || "").trim();
}

function ordemPedidoGrupo(pedidoId = "", pedido = {}) {
  if (!pedido) return 999;
  if (pedido.ehEventoPrincipal || !ehSubeventoPedido(pedidoId, pedido)) return 1;
  const ordem = Number(pedido.subeventoOrdem || pedido.ordemApresentacao || 0);
  return Number.isFinite(ordem) && ordem > 0 ? ordem : 999;
}

function ordenarPedidosGrupo(pedidos = []) {
  return [...pedidos].sort((a, b) => {
    const ordemA = ordemPedidoGrupo(a.id, a);
    const ordemB = ordemPedidoGrupo(b.id, b);
    if (ordemA !== ordemB) return ordemA - ordemB;

    const dataA = formatarDataIsoLocal(parseDataEvento(a.dataStr || a.data) || { ano: 9999, mes: 12, dia: 31 });
    const dataB = formatarDataIsoLocal(parseDataEvento(b.dataStr || b.data) || { ano: 9999, mes: 12, dia: 31 });
    if (dataA !== dataB) return dataA.localeCompare(dataB);

    return String(a.horaInicio || "").localeCompare(String(b.horaInicio || ""));
  });
}

async function carregarGrupoPedido(pedidoId) {
  if (!pedidoId) throw new Error("PEDIDO_ID_OBRIGATORIO");

  const pedidoRef = db.collection("pedidos").doc(pedidoId);
  const pedidoSnap = await pedidoRef.get();
  if (!pedidoSnap.exists) throw new Error("PEDIDO_NAO_ENCONTRADO");

  const pedido = pedidoSnap.data();
  const principalId = ehSubeventoPedido(pedidoId, pedido) ? String(pedido.eventoPrincipalId || "") : pedidoId;
  const principalRef = db.collection("pedidos").doc(principalId);
  const principalSnap = principalId === pedidoId ? pedidoSnap : await principalRef.get();
  if (!principalSnap.exists) throw new Error("PEDIDO_NAO_ENCONTRADO");

  const principal = principalSnap.data();
  const grupoId = grupoIdPedido(principalId, principal);
  if (!grupoId) {
    return {
      principalId,
      grupoId: principalId,
      principal: { id: principalId, ...principal },
      pedidos: [{ id: principalId, ...principal }],
    };
  }

  const grupoSnap = await db.collection("pedidos").where("grupoId", "==", grupoId).get();
  const pedidos = [];
  grupoSnap.forEach((docSnap) => pedidos.push({ id: docSnap.id, ...docSnap.data() }));

  if (!pedidos.find((item) => item.id === principalId)) {
    pedidos.push({ id: principalId, ...principal });
  }

  return {
    principalId,
    grupoId,
    principal: { id: principalId, ...principal },
    pedidos: ordenarPedidosGrupo(pedidos),
  };
}

function camposGrupoAlterados(before = {}, after = {}) {
  const patch = {};
  CAMPOS_PROPAGADOS_GRUPO.forEach((campo) => {
    if (JSON.stringify(before[campo] ?? null) !== JSON.stringify(after[campo] ?? null)) {
      patch[campo] = after[campo] ?? "";
    }
  });
  return patch;
}

async function propagarCamposGrupoDoPrincipal(pedidoId, before = {}, after = {}) {
  if (ehSubeventoPedido(pedidoId, after)) return;
  if (!before || !Object.keys(before).length) return;

  const grupoId = grupoIdPedido(pedidoId, after);
  if (!grupoId) return;

  const patch = camposGrupoAlterados(before, after);
  if (!Object.keys(patch).length) return;

  const grupoSnap = await db.collection("pedidos").where("grupoId", "==", grupoId).get();
  const batch = db.batch();
  let alterados = 0;

  grupoSnap.forEach((docSnap) => {
    if (docSnap.id === pedidoId) return;
    const dados = docSnap.data();
    if (!ehSubeventoPedido(docSnap.id, dados)) return;
    batch.set(docSnap.ref, patch, { merge: true });
    alterados += 1;
  });

  if (alterados > 0) await batch.commit();
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
  const criadorNome = NOMES_CRIADORES_AGENDA[criadorEmail] || criadorEmail || "Google Agenda";
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
    criadorNome,
    atendimento: atendimentoPorCriadorAgenda(criadorEmail, criadorNome),
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
    adicionarVariantesAgenda(ids, pedido.agendaId);
    adicionarVariantesAgenda(ids, pedido.agendaIcalUid);
    adicionarVariantesAgenda(icals, pedido.agendaId);
    adicionarVariantesAgenda(icals, pedido.agendaIcalUid);
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
    .filter((event) => !eventoRelacionadoPorIds(event, ids, icals))
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
  const byAssinatura = new Map();

  eventos.forEach((event) => {
    variantesAgendaId(event.id).forEach((chave) => byId.set(chave, event));
    variantesAgendaId(event.iCalUID).forEach((chave) => byIcal.set(chave, event));
    const assinatura = assinaturaAgendaEvento(event);
    if (assinatura) byAssinatura.set(assinatura, event);
  });

  return { byId, byIcal, byAssinatura };
}

function normalizarChaveAgenda(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function assinaturaAgendaPedido(pedido, producao = null) {
  try {
    const periodo = montarInicioFimAgenda(pedido, producao);
    return `${periodo.dataIso}|${periodo.inicio}|${normalizarChaveAgenda(tituloAgendaPedido(pedido))}`;
  } catch (error) {
    return "";
  }
}

function assinaturaAgendaEvento(event) {
  const inicio = partesLocaisEventoGoogle(event?.start?.dateTime || event?.start?.date);
  if (!inicio) return "";

  const dataIso = `${String(inicio.ano).padStart(4, "0")}-${String(inicio.mes).padStart(2, "0")}-${String(inicio.dia).padStart(2, "0")}`;
  const hora = `${String(inicio.hora).padStart(2, "0")}:${String(inicio.minuto).padStart(2, "0")}`;
  return `${dataIso}|${hora}|${normalizarChaveAgenda(event?.summary)}`;
}

function buscarEventoGoogleDoPedido(pedido, maps, producao = null) {
  const chaves = [
    ...variantesAgendaId(pedido.agendaId),
    ...variantesAgendaId(pedido.agendaIcalUid),
  ];

  for (const chave of chaves) {
    const evento = maps.byId.get(chave) || maps.byIcal.get(chave);
    if (evento) return evento;
  }

  const assinatura = assinaturaAgendaPedido(pedido, producao);
  return assinatura ? maps.byAssinatura.get(assinatura) || null : null;
}

function eventoEsperadoDiverge(pedido, evento, producao = null) {
  try {
    const esperado = recursoEventoAgenda(pedido, evento, producao);
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
    if ((evento.description || "") !== (esperado.description || "")) divergencias.push("descricao");
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

  const producaoSnaps = await Promise.all(
    pedidos.map((pedido) => db.collection("producao_eventos").doc(pedido.id).get()),
  );
  const producaoPorPedido = new Map();
  producaoSnaps.forEach((snap, index) => {
    if (!snap.exists) return;
    producaoPorPedido.set(pedidos[index].id, {
      ...producaoEventoDefault(pedidos[index].id, pedidos[index], snap.data()),
      ...snap.data(),
    });
  });

  const chavesPedidosAgenda = new Set();
  const assinaturasPedidosAgenda = new Set();
  pedidos.forEach((pedido) => {
    adicionarVariantesAgenda(chavesPedidosAgenda, pedido.agendaId);
    adicionarVariantesAgenda(chavesPedidosAgenda, pedido.agendaIcalUid);
    const assinatura = assinaturaAgendaPedido(pedido, producaoPorPedido.get(pedido.id));
    if (assinatura) assinaturasPedidosAgenda.add(assinatura);
  });

  const manuais = eventosGoogle
    .filter((event) => {
      if (eventoRelacionadoPorIds(event, chavesPedidosAgenda)) return false;
      const assinatura = assinaturaAgendaEvento(event);
      return !assinatura || !assinaturasPedidosAgenda.has(assinatura);
    })
    .map((event) => resumoEventoGoogle(event));

  const ausentes = [];
  const divergentes = [];

  pedidos.forEach((pedido) => {
    const producao = producaoPorPedido.get(pedido.id) || null;
    const evento = buscarEventoGoogleDoPedido(pedido, maps, producao);

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

    const divergencias = eventoEsperadoDiverge(pedido, evento, producao);
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
    atendimento: resumo.atendimento || "Luciano",
    criadoEm: admin.firestore.FieldValue.serverTimestamp(),
  });

  await sincronizarPedidoComAgenda(docRef.id, "importacao_google");
  return { success: true, pedidoId: docRef.id };
}

async function carregarPedidoAtivoOuFalhar(pedidoId) {
  const id = String(pedidoId || "").trim();
  if (!id) throw new Error("PEDIDO_ID_OBRIGATORIO");

  const pedidoRef = db.collection("pedidos").doc(id);
  const pedidoSnap = await pedidoRef.get();
  if (!pedidoSnap.exists) throw new Error("PEDIDO_NAO_ENCONTRADO");

  const pedido = { id: pedidoSnap.id, ...pedidoSnap.data() };
  if (["REPROVADO", "LIXEIRA"].includes(String(pedido.status || "").toUpperCase())) {
    throw new Error("PEDIDO_INDISPONIVEL");
  }

  return { pedidoRef, pedidoSnap, pedido };
}

async function carregarRespostaProducao(pedidoId) {
  const { pedido } = await carregarPedidoAtivoOuFalhar(pedidoId);
  const [producao, parceirosSom] = await Promise.all([
    carregarProducaoEvento(pedidoId, pedido),
    listarParceirosSom(),
  ]);

  return {
    success: true,
    pedidoId,
    producao,
    parceirosSom,
  };
}

async function cadastrarParceiroSom(body = {}, actor = {}) {
  const nome = valorTextoSeguro(body.nome);
  if (!nome) throw new Error("NOME_EMPRESA_OBRIGATORIO");

  const nomeNormalizado = nomeNormalizadoParceiro(nome);
  const existentes = await db.collection("parceiros_som")
    .where("nomeNormalizado", "==", nomeNormalizado)
    .limit(1)
    .get();

  let parceiroRef;
  if (!existentes.empty) {
    parceiroRef = existentes.docs[0].ref;
  } else {
    parceiroRef = db.collection("parceiros_som").doc();
    await parceiroRef.set({
      nome,
      nomeNormalizado,
      ativo: true,
      responsavelNome: valorTextoSeguro(body.responsavelNome),
      whatsapp: normalizarWhatsAppBr(body.whatsapp),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdByUid: actor.uid || "",
      createdByEmail: actor.email || "",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedByUid: actor.uid || "",
      updatedByEmail: actor.email || "",
    }, { merge: true });
  }

  const parceiroSnap = await parceiroRef.get();
  return {
    success: true,
    parceiro: { id: parceiroSnap.id, ...parceiroSnap.data() },
    parceirosSom: await listarParceirosSom(),
  };
}

async function salvarFichaProducao(body = {}, actor = {}) {
  const pedidoId = String(body.pedidoId || "").trim();
  const { pedido } = await carregarPedidoAtivoOuFalhar(pedidoId);
  const producaoRef = db.collection("producao_eventos").doc(pedidoId);
  const producaoSnap = await producaoRef.get();
  const before = producaoEventoDefault(pedidoId, pedido, producaoSnap.exists ? producaoSnap.data() : {});

  let payload = producaoEventoPayload(body, pedidoId, pedido);
  const convidados = parseInt(String(pedido.convidados || "0"), 10) || 0;
  if (convidados > 80) payload.sonorizacaoTipo = "terceirizada";

  if (payload.empresaSomId) {
    const parceiroSnap = await db.collection("parceiros_som").doc(payload.empresaSomId).get();
    if (parceiroSnap.exists) {
      payload.empresaSomNome = valorTextoSeguro(parceiroSnap.data().nome, payload.empresaSomNome);
    } else {
      payload.empresaSomId = "";
      payload.empresaSomNome = "";
    }
  }

  payload = {
    ...payload,
    localTexto: payload.localMapsUrl,
  };

  const basePersistencia = {
    ...payload,
    pedidoId,
    clienteSnapshot: valorTextoSeguro(pedido.cliente || pedido.nome_contratante_formal),
    dataEventoSnapshot: valorTextoSeguro(pedido.dataStr || pedido.data),
    cidadeUfSnapshot: [pedido.cidade || "", pedido.uf || ""].filter(Boolean).join("-"),
    horaShowInicioSnapshot: valorTextoSeguro(pedido.horaInicio),
    horaShowFimSnapshot: valorTextoSeguro(pedido.horaTermino || calcularHoraTermino(pedido.horaInicio, pedido.duracao)),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedByUid: actor.uid || "",
    updatedByEmail: actor.email || "",
    updatedByRole: actor.role || "",
    updatedByName: actor.nome || "",
    syncStatus: "PROCESSANDO",
    syncError: admin.firestore.FieldValue.delete(),
  };

  if (!producaoSnap.exists) {
    basePersistencia.createdAt = admin.firestore.FieldValue.serverTimestamp();
    basePersistencia.createdByUid = actor.uid || "";
    basePersistencia.createdByEmail = actor.email || "";
  }

  await producaoRef.set(basePersistencia, { merge: true });
  await registrarLogsProducao(pedidoId, before, payload, actor);

  try {
    const sync = await sincronizarGrupoPorPedidoId(pedidoId, "painel_producao");
    await producaoRef.set({
      syncStatus: "SINCRONIZADO",
      syncUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      syncError: admin.firestore.FieldValue.delete(),
      agendaId: sync.agendaId || "",
      agendaIcalUid: sync.agendaIcalUid || "",
    }, { merge: true });

    return {
      success: true,
      pedidoId,
      agendaId: sync.agendaId || "",
      agendaIcalUid: sync.agendaIcalUid || "",
      producao: {
        ...before,
        ...payload,
      },
    };
  } catch (error) {
    await producaoRef.set({
      syncStatus: "ERRO",
      syncUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      syncError: String(error.message || error).slice(0, 500),
    }, { merge: true });
    throw error;
  }
}

async function decodificarTokenAgenda(req, obrigatorio = true) {
  const authHeader = String(req.get("Authorization") || "");
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    if (obrigatorio) throw new Error("NAO_AUTORIZADO");
    return null;
  }

  return admin.auth().verifyIdToken(match[1]);
}

function actorAgenda(decoded = {}) {
  return {
    uid: decoded?.uid || "",
    email: String(decoded?.email || "").toLowerCase(),
    nome: nomeUsuarioSistema(decoded),
    role: resolverRoleUsuario(decoded),
  };
}

async function exigirAcessoAgenda(req, niveis = ["admin"]) {
  const decoded = await decodificarTokenAgenda(req, true);
  const role = resolverRoleUsuario(decoded);
  if (!niveis.includes(role)) throw new Error("NAO_AUTORIZADO");
  return { decoded, role, actor: actorAgenda(decoded) };
}

exports.getDadosConversao = onRequest({
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
    await exigirAcessoAgenda(req, ["admin"]);
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const resultado = await calcularDadosConversao(body.mes, body.ano);
    sendJson(res, 200, resultado);
  } catch (error) {
    logger.error("Erro em getDadosConversao.", error);
    const code = error.message === "NAO_AUTORIZADO" ? 403 : (error.message === "PARAMETROS_INVALIDOS" ? 400 : 500);
    sendJson(res, code, { success: false, error: error.message || "Erro interno." });
  }
});

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

      const resultado = await sincronizarGrupoPorPedidoId(pedidoId, "form_publico");
      sendJson(res, 200, resultado);
      return;
    }

    if (acao === "PRODUCAO_REGISTRAR_TENTATIVA") {
      const decoded = await decodificarTokenAgenda(req, false);
      await registrarTentativaAcessoProducao(req, String(body.pedidoId || ""), decoded);
      sendJson(res, 200, { success: true });
      return;
    }

    if (acao === "AGENDA_SINCRONIZAR_PEDIDO") {
      await exigirAcessoAgenda(req, ["admin", "producao"]);
      const resultado = await sincronizarGrupoPorPedidoId(String(body.pedidoId || ""), "painel");
      sendJson(res, 200, resultado);
      return;
    }

    if (acao === "PRODUCAO_CARREGAR") {
      await exigirAcessoAgenda(req, ["admin", "producao"]);
      const resultado = await carregarRespostaProducao(String(body.pedidoId || ""));
      sendJson(res, 200, resultado);
      return;
    }

    if (acao === "PRODUCAO_CADASTRAR_EMPRESA") {
      const { actor } = await exigirAcessoAgenda(req, ["admin", "producao"]);
      const resultado = await cadastrarParceiroSom(body, actor);
      sendJson(res, 200, resultado);
      return;
    }

    if (acao === "PRODUCAO_SALVAR") {
      const { actor } = await exigirAcessoAgenda(req, ["admin", "producao"]);
      const resultado = await salvarFichaProducao(body, actor);
      sendJson(res, 200, resultado);
      return;
    }

    if (acao === "AGENDA_CONFERIR") {
      await exigirAcessoAgenda(req, ["admin"]);
      const resultado = await conferirAgenda();
      sendJson(res, 200, resultado);
      return;
    }

    if (acao === "AGENDA_IMPORTAR_EVENTO") {
      await exigirAcessoAgenda(req, ["admin"]);
      const resultado = await importarEventoGoogleParaErp(String(body.eventId || ""));
      sendJson(res, 200, resultado);
      return;
    }

    sendJson(res, 400, { success: false, error: "Acao invalida." });
  } catch (error) {
    logger.error("Erro na API de agenda.", error);
    const code = ["NAO_AUTORIZADO"].includes(error.message)
      ? 403
      : (["PEDIDO_NAO_ENCONTRADO", "PEDIDO_INDISPONIVEL", "PEDIDO_ID_OBRIGATORIO", "NOME_EMPRESA_OBRIGATORIO"].includes(error.message) ? 400 : 500);
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

    const patch = {
      ...patchDatasEstagio(before || {}, after),
      ...patchAtendimentoPedido(before || {}, after),
    };
    if (Object.keys(patch).length) {
      await afterSnap.ref.set(patch, { merge: true });
    }

    const afterNormalizado = { ...after, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => typeof value === "string")) };
    await propagarCamposGrupoDoPrincipal(pedidoId, before || {}, afterNormalizado);

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

exports.auditarStatusPedido = onDocumentWritten({
  document: "pedidos/{pedidoId}",
  region: REGION,
}, async (event) => {
  const beforeSnap = event.data?.before;
  const afterSnap = event.data?.after;
  if (!beforeSnap?.exists || !afterSnap?.exists) return;

  const before = beforeSnap.data() || {};
  const after = afterSnap.data() || {};
  const statusAntes = normalizarStatusConversao(before.status);
  const statusDepois = normalizarStatusConversao(after.status);
  if (statusAntes === statusDepois) return;

  await db.collection("pedidos").doc(event.params.pedidoId).collection("logs").add({
    type: "status_change",
    field: "status",
    before: before.status || "",
    after: after.status || "",
    message: `${valorTextoSeguro(after.statusUpdatedByName, "Usuario do sistema")} alterou Status de "${before.status || "vazio"}" para "${after.status || "vazio"}"`,
    actorUid: after.statusUpdatedByUid || "",
    actorEmail: after.statusUpdatedByEmail || "",
    actorName: after.statusUpdatedByName || "",
    actorRole: after.statusUpdatedByRole || "",
    source: "painel_status",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
});

exports.notificarNovoOrcamento = onDocumentCreated({
  document: "pedidos/{pedidoId}",
  region: REGION,
  secrets: [VAPID_PRIVATE_KEY_SECRET],
}, async (event) => {
  const snap = event.data;
  if (!snap) return;

  const pedido = snap.data();
  if (pedido.ehSubevento) return;
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
  if (after.ehSubevento) return;
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
