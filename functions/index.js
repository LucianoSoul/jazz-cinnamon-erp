const admin = require("firebase-admin");
const logger = require("firebase-functions/logger");
const { defineSecret } = require("firebase-functions/params");
const { onDocumentCreated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const webpush = require("web-push");

admin.initializeApp();

const db = admin.firestore();
const REGION = "southamerica-east1";
const DEFAULT_PANEL_URL = "https://jazz-cinnamon-erp.web.app/painel_erp.html";
const DEFAULT_VAPID_SUBJECT = "mailto:luciano.cinnamon@gmail.com";
const NOTIFICATION_ICON_URL = "https://firebasestorage.googleapis.com/v0/b/jazz-cinnamon-erp.firebasestorage.app/o/BOTAO%20ERP.png?alt=media";
const URL_BACKEND = "https://script.google.com/macros/s/AKfycbx9NsoG0R-NNtbECB-Qw96YDcZaexKDmbfH90vIiXzwElYALIJBO5NdUC9tCuO4AXUh/exec";
const VAPID_PRIVATE_KEY_SECRET = defineSecret("VAPID_PRIVATE_KEY");

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
    atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: false });
});
