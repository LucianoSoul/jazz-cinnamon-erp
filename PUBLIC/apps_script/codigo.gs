/**
 * MOTOR DE AUTOMAÇÃO JAZZ CINNAMON (INTEGRAÇÃO FIREBASE ERP)
 * API exclusiva para Google Agenda, Drive, Docs e Gmail.
 */

const CONFIG = {
  CALENDAR_ID: '77ee282b8071d0ae9ed2cfb27ef8260acb93c76bc27dc96a2efc60cf32445e43@group.calendar.google.com',
  PASTA_COMPROVANTES_ID: '1hSsxvwceCGM3m9n8zjr_YLBVNCM5qBgH',
  PASTA_DESTINO_ID: '1txkbhJM-_I1C-5hfhQRHSja_6XfDcovQ', // Orçamentos
  EMAIL_NOTIFICACAO: 'luciano.cinnamon@gmail.com',
  
  IDS_TEMPLATES_ORCAMENTO: {
    COM_RIDER: '1lec4GdcIyW6eahiCEFBxl46O4RpVrKzWWVuDUjeCoGM', 
    SEM_RIDER: '1j6l8onEKK7YIlNdhNVhemCqza0AsFrTqg56N62z3rXg'
  },
  
  IDS_TEMPLATES_CONTRATO: {
    PF: { SEM_RIDER: '1LMHTSN4kwBozdbUapMspONhmy-ywIJBCL-WDTBwFF8g', COM_RIDER: '1AXxrfrRtzdHOvp8J0X0SrAIUo1cEYpevjfGoIpJn0jU' },
    PJ: { SEM_RIDER: '1vYxPmovOLqYI9dZRM6sRhTP-UBRTuzr9pAJ-35WlsVI', COM_RIDER: '1hZSQuxlbvDiBy_fNA_4z2GIs-6t48saIXJxO0X75NMc' }
  },
  
  PASTAS_CONTRATOS: { 
    CPF: '1wClJvCCbA1J57qmmWCn-E8zZkaylAiXB', 
    CNPJ: '1jfAzWKbX04RFgK-mCJGQaYj7dulmkUXw' 
  }
};

function doPost(e) {
  const req = JSON.parse(e.postData.contents);
  let res = { success: false, error: "Ação não encontrada." };

  try {
    if (req.acao === "VERIFICAR_AGENDA_DIA") res = verificarAgendaDia(req.dataBusca);
    else if (req.acao === "CRIAR_PRE_RESERVA_AGENDA") res = criarPreReservaAgenda(req);
    else if (req.acao === "ALTERAR_STATUS_AGENDA") res = alterarStatusAgenda(req);
    else if (req.acao === "ATUALIZAR_DADOS_AGENDA") res = atualizarDadosAgenda(req);
    else if (req.acao === "EXCLUIR_EVENTO_AGENDA") res = excluirEventoAgenda(req);
    else if (req.acao === "CONFERIR_SINCRONIZACAO") res = conferirSincronizacao(req);
    else if (req.acao === "SALVAR_ARQUIVO") res = salvarArquivoDrive(req);
    else if (req.acao === "GERAR_PDF_ORCAMENTO") res = gerarPdfOrcamento(req);
    else if (req.acao === "GERAR_PDF_CONTRATO") res = gerarPdfContrato(req);
    
    // ====================================================================
    // ENVIO DE E-MAIL DOS PRESENTES DA GRAVATA DIGITAL (O que fizemos antes)
    // ====================================================================
    else if (req.acao === "ENVIAR_EMAIL") {
      let assunto = "Você recebeu um presente na sua Gravata Digital 🎁";
      let corpo = "Olá!\n\nTemos uma ótima notícia.\nVocê acaba de receber um presente através da sua Gravata Digital.\n\n" +
                  "Convidado: " + req.nome_convidado + "\n" +
                  "Valor do presente: R$ " + req.valor + "\n\n";
                  
      if (req.mensagem && req.mensagem.trim() !== "") {
        corpo += "Mensagem do convidado:\n\"" + req.mensagem + "\"\n\n";
      }
      
      corpo += "Todos os valores são registrados com segurança e serão organizados para repasse após a celebração, conforme combinado.\n" +
               "Seguimos acompanhando cada contribuição com cuidado e transparência para que você aproveite o seu evento com tranquilidade.\n\n" +
               "Com carinho e profissionalismo,\nEquipe Jazz Cinnamon";
               
      MailApp.sendEmail(req.email, assunto, corpo);
      res = { success: true };
    }

    // ====================================================================
    // NOVO: NOTIFICAR A BANDA (ADMIN) QUE O CLIENTE ATIVOU UM SERVIÇO
    // ====================================================================
    else if (req.acao === "NOTIFICAR_ADMIN_COMPRA") {
      let assunto = "🔥 Nova Ativação no Portal: " + req.cliente;
      
      // Formatar o WhatsApp para o link
      let wppLink = req.whatsapp ? "https://wa.me/" + req.whatsapp.replace(/\D/g, '') : "";
      let wppBtn = wppLink ? `<a href="${wppLink}" style="background-color:#25D366;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;font-weight:bold;display:inline-block;margin-top:10px;">Falar no WhatsApp</a>` : "<i>WhatsApp não informado</i>";
      
      let dataPtBr = String(req.data_evento);
      if (dataPtBr.includes('-')) dataPtBr = dataPtBr.split('-').reverse().join('/');
      
      let htmlBody = `
        <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #d4af37; border-bottom: 2px solid #d4af37; padding-bottom: 10px;">Novo Serviço Ativado!</h2>
          <p>O cliente <b>${req.cliente}</b> acabou de ativar novos módulos no Portal do Cliente.</p>
          
          <div style="background-color: #f8f9fa; padding: 15px; border-left: 4px solid #d4af37; margin: 20px 0;">
            <p style="margin:0;"><b>Serviços Adquiridos:</b><br><span style="color:#d4af37; font-weight:bold;">${req.servicos}</span></p>
          </div>
          
          <p style="margin: 5px 0;"><b>📅 Data do Evento:</b> ${dataPtBr}</p>
          <p style="margin: 5px 0;"><b>📍 Local:</b> ${req.cidade_uf}</p>
          <p style="margin: 5px 0;"><b>👤 Cliente:</b> ${req.cliente}</p>
          ${wppBtn}
          
          <hr style="border: none; border-top: 1px solid #eee; margin: 25px 0;">
          
          <p style="margin: 5px 0;"><a href="${req.link_portal}" style="color: #2563eb; text-decoration: none;">🔗 Acessar Portal do Cliente</a></p>
          <p style="margin: 5px 0;"><a href="${req.link_playlist}" style="color: #2563eb; text-decoration: none;">🎵 Acessar Jukebox (Convidados)</a></p>
        </div>
      `;
      
      MailApp.sendEmail({
        to: CONFIG.EMAIL_NOTIFICACAO, // Manda para luciano.cinnamon@gmail.com
        subject: assunto,
        htmlBody: htmlBody
      });
      
      res = { success: true };
    }

    // ====================================================================
    // NOVA AÇÃO: AVISO DE NOVO ORÇAMENTO/PEDIDO ERP
    // ====================================================================
    else if (req.acao === "NOTIFICAR_NOVO_PEDIDO") {
      let wppLink = req.whatsapp ? "https://wa.me/" + String(req.whatsapp).replace(/\D/g, '') : "";
      let wppBtn = wppLink ? `<a href="${wppLink}" style="background-color:#25D366;color:white;padding:12px 24px;text-decoration:none;border-radius:5px;font-weight:bold;display:inline-block;margin: 15px 0;">CHAMAR NO WHATSAPP</a>` : "<p><i>WhatsApp não informado</i></p>";
      
      // Tratamento da data para DD/MM/YYYY
      let dataPtBr = String(req.data_evento || "");
      if (dataPtBr.includes('-')) dataPtBr = dataPtBr.split('-').reverse().join('/');
      
      let htmlBody = `
        <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; background-color: #f9f9f9; padding: 25px; border-radius: 8px; border-top: 5px solid #d4af37; box-shadow: 0 4px 10px rgba(0,0,0,0.05);">
          <h2 style="color: #d4af37; text-transform: uppercase; margin-top: 0;">NOVO PEDIDO: ${req.cliente || 'CLIENTE NÃO INFORMADO'}</h2>
          
          ${wppBtn}
          
          <div style="background-color: #fff; padding: 15px; border-radius: 5px; border: 1px solid #eee; margin-bottom: 20px;">
              <p style="margin: 8px 0; font-size: 15px;"><b>DATA:</b> ${dataPtBr} ${req.dia_semana ? `(${req.dia_semana})` : ''}</p>
              <p style="margin: 8px 0; font-size: 15px;"><b>Horário:</b> ${req.horario || 'Não informado'}</p>
              <p style="margin: 8px 0; font-size: 15px;"><b>Local:</b> ${req.cidade || ''} - ${req.uf || ''}</p>
              <p style="margin: 8px 0; font-size: 15px;"><b>Convidados:</b> ${req.convidados || '0'}</p>
              <p style="margin: 8px 0; font-size: 15px;"><b>Status:</b> <span style="color: #10b981; font-weight: bold;">${req.status || 'NOVO'}</span></p>
          </div>
          
          <a href="${req.link_painel || 'https://cinnamon-jukebox.vercel.app/admin'}" style="background-color:#111318;color:#d4af37;padding:12px 25px;text-decoration:none;border-radius:5px;font-weight:bold;display:inline-block;text-transform:uppercase; border: 1px solid #d4af37;">ABRIR PAINEL</a>
        </div>
      `;
      
      MailApp.sendEmail({
        to: CONFIG.EMAIL_NOTIFICACAO,
        subject: `🚨 NOVO PEDIDO: ${req.cliente || 'CLIENTE'}`,
        htmlBody: htmlBody
      });
      
      res = { success: true };
    }
    
  } catch(error) {
    res.error = error.toString();
  }

  return ContentService.createTextOutput(JSON.stringify(res)).setMimeType(ContentService.MimeType.JSON);
}

// ==============================================================================
// 1. GOOGLE AGENDA (Sincronização 100% Blindada e Instantânea)
// ==============================================================================

function atualizarEventoCompleto(ev, dados, cor, sufixo) {
  if (dados.dataStr && dados.horaInicio) {
    let strData = String(dados.dataStr);
    let parts = strData.includes('-') ? strData.split('-') : strData.split('/');
    let ano = parts[0].length === 4 ? parts[0] : parts[2];
    let mes = parts[1];
    let dia = parts[0].length === 4 ? parts[2] : parts[0];

    const [h, m] = dados.horaInicio.split(':').map(Number);
    let duracaoMinutos = parseFloat((dados.duracao || '2:00').replace(':','.')) * 60;
    const startDt = new Date(ano, mes-1, dia, h, m);
    const endDt = new Date(startDt.getTime() + (duracaoMinutos * 60 * 1000));
    ev.setTime(startDt, endDt);
  }
  
  let clienteStr = dados.cliente || dados.nome_contratante_formal;
  if (!clienteStr && ev.getTitle()) {
    let match = ev.getTitle().match(/JAZZ CINNAMON - (.*?) \(/);
    if (match) clienteStr = match[1];
  }
  if (!clienteStr) clienteStr = "CLIENTE";
  
  let tipoStr = dados.tipo || "EVENTO";

  ev.setTitle(`JAZZ CINNAMON - ${clienteStr} (${tipoStr}) - ${sufixo}`);
  if (cor) ev.setColor(cor);

  let descAtual = ev.getDescription() || "";
  let locAtual = ev.getLocation() || "";

  let oldWhatsapp = "";
  let oldValor = "";
  let oldTraje = "";
  let oldBateria = "";
  let oldObs = "";
  
  if (descAtual) {
    let lines = descAtual.split('\n');
    let inObs = false;
    for (let i = 0; i < lines.length; i++) {
      let l = lines[i].trim();
      if (!l) continue;
      if (l.startsWith('R$')) { oldValor = l; inObs = false; } 
      else if (l.startsWith('TRAJE:')) { oldTraje = l.substring(6).trim(); inObs = false; } 
      else if (l.startsWith('BATERIA:')) { oldBateria = l.substring(8).trim(); inObs = false; } 
      else if (l.startsWith('OBSERVAÇAO:')) { oldObs = l.substring(11).trim(); inObs = true; } 
      else if (inObs) { oldObs += "\n" + l; } 
      else if (l.includes(' - ') && !l.includes(',') && !l.startsWith('JAZZ')) {
         let p = l.split(' - ');
         if (p.length > 1) oldWhatsapp = p.slice(1).join(' - ').trim();
      }
    }
  }

  let localNome = dados.local || "";
  let endereco = dados.local_evento_endereco || dados.contratante_endereco || dados.endereco || "";
  let cidadeUf = "";
  if (dados.cidade && dados.uf) cidadeUf = `${dados.cidade}-${dados.uf}`;
  else if (dados.cidade) cidadeUf = dados.cidade;
  else if (dados.uf) cidadeUf = dados.uf;
  
  let arr = [];
  if (localNome) arr.push(localNome);
  if (endereco) arr.push(endereco);
  if (cidadeUf) arr.push(cidadeUf);
  let linha1 = arr.join(", ");
  
  if (linha1) ev.setLocation(linha1);
  else if (locAtual) linha1 = locAtual;
  else linha1 = "LOCAL A DEFINIR";
  
  let whatsapp = dados.whatsapp || oldWhatsapp || "S/ WHATSAPP";
  
  let valorFormatado = oldValor || "R$ 0,00";
  if (dados.valor_final_contrato !== undefined && dados.valor_final_contrato !== "") {
    valorFormatado = "R$ " + parseFloat(dados.valor_final_contrato || 0).toLocaleString('pt-BR', {minimumFractionDigits: 2});
  } else if (dados.valor !== undefined && dados.valor !== "") {
    valorFormatado = "R$ " + parseFloat(dados.valor || 0).toLocaleString('pt-BR', {minimumFractionDigits: 2});
  }
  
  let desc = `${linha1}\n\n`;
  desc += `${clienteStr} - ${whatsapp}\n`;
  desc += `${valorFormatado}\n\n`;
  desc += `TRAJE: ${oldTraje}\n`;
  desc += `BATERIA: ${oldBateria}\n`;
  desc += `OBSERVAÇAO: ${oldObs}`;
  
  ev.setDescription(desc);
}

function verificarAgendaDia(dataStr) {
  const cal = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
  let strData = String(dataStr);
  let parts = strData.includes('-') ? strData.split('-') : strData.split('/');
  const ano = parts[0].length === 4 ? parts[0] : parts[2];
  const mes = parts[1];
  const dia = parts[0].length === 4 ? parts[2] : parts[0];

  const dataBusca = new Date(ano, mes-1, dia, 12, 0, 0);
  const eventos = cal.getEventsForDay(dataBusca);
  
  const ext = [];
  eventos.forEach(ev => {
    if (!ev.getTitle().includes("JAZZ CINNAMON")) {
       let stTime = Utilities.formatDate(ev.getStartTime(), "GMT-3", "HH:mm");
       let enTime = Utilities.formatDate(ev.getEndTime(), "GMT-3", "HH:mm");
       ext.push({ titulo: ev.getTitle(), horaInicio: stTime, horaTermino: enTime });
    }
  });
  return { success: true, eventosExternos: ext };
}

function criarPreReservaAgenda(dados) {
  const cal = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
  
  let strData = String(dados.dataStr);
  let parts = strData.includes('-') ? strData.split('-') : strData.split('/');
  let ano = parts[0].length === 4 ? parts[0] : parts[2];
  let mes = parts[1];
  let dia = parts[0].length === 4 ? parts[2] : parts[0];
  
  const [h, m] = (dados.horaInicio || "19:00").split(':').map(Number);
  
  let duracaoMinutos = 120;
  if (dados.duracao) duracaoMinutos = parseFloat(dados.duracao.replace(':','.')) * 60;
  
  const startDt = new Date(ano, mes-1, dia, h, m);
  const endDt = new Date(startDt.getTime() + (duracaoMinutos * 60 * 1000));
  
  const ev = cal.createEvent(`JAZZ CINNAMON - ${dados.cliente} (${dados.tipo || 'EVENTO'}) - PRE-RESERVA`, startDt, endDt);
  atualizarEventoCompleto(ev, dados, CalendarApp.EventColor.BLUE, "PRE-RESERVA");
  
  return { success: true, eventId: ev.getId() };
}

function alterarStatusAgenda(dados) {
  if(!dados.agendaId) return { success: false, error: "ID da agenda não fornecido." };
  const cal = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
  
  let cor = CalendarApp.EventColor.BLUE;
  let sufixo = "PRE-RESERVA";
  if(dados.status === 'RESERVA') { cor = CalendarApp.EventColor.GREEN; sufixo = "RESERVA"; } 
  else if(dados.status === 'CONFIRMADO') { cor = CalendarApp.EventColor.MAUVE; sufixo = "CONFIRMADO"; }

  let ev;
  try { ev = cal.getEventById(dados.agendaId); } catch(e) {}

  if(!ev) {
     if(!dados.dataStr || !dados.horaInicio) return { success: false, error: "Falta data para recriar o evento." };
     let strData = String(dados.dataStr);
     let parts = strData.includes('-') ? strData.split('-') : strData.split('/');
     let ano = parts[0].length === 4 ? parts[0] : parts[2];
     let mes = parts[1];
     let dia = parts[0].length === 4 ? parts[2] : parts[0];
     
     const [h, m] = (dados.horaInicio || "19:00").split(':').map(Number);
     let duracaoMinutos = 120;
     if (dados.duracao) duracaoMinutos = parseFloat(dados.duracao.replace(':','.')) * 60;
     const startDt = new Date(ano, mes-1, dia, h, m);
     const endDt = new Date(startDt.getTime() + (duracaoMinutos * 60 * 1000));
     
     ev = cal.createEvent(`JAZZ CINNAMON - ${dados.cliente} (${dados.tipo || 'EVENTO'}) - ${sufixo}`, startDt, endDt);
     atualizarEventoCompleto(ev, dados, cor, sufixo);
     return { success: true, novoStatus: sufixo, newEventId: ev.getId() };
  }

  try {
    atualizarEventoCompleto(ev, dados, cor, sufixo);
    return { success: true, novoStatus: sufixo };
  } catch (e) { return { success: false, error: e.toString() }; }
}

function atualizarDadosAgenda(dados) {
  if(!dados.agendaId) return { success: false, error: "ID da agenda não fornecido." };
  const cal = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
  let ev;
  
  try { ev = cal.getEventById(dados.agendaId); } catch(e) {}

  let currentTitle = ev ? ev.getTitle() : "";
  let sufixo = "PRE-RESERVA";
  let cor = CalendarApp.EventColor.BLUE;

  if (dados.status) {
    if(dados.status === 'RESERVA') { cor = CalendarApp.EventColor.GREEN; sufixo = "RESERVA"; } 
    else if(dados.status === 'CONFIRMADO') { cor = CalendarApp.EventColor.MAUVE; sufixo = "CONFIRMADO"; }
  } else {
    if (currentTitle.includes("CONFIRMADO")) { cor = CalendarApp.EventColor.MAUVE; sufixo = "CONFIRMADO"; }
    else if (currentTitle.includes("RESERVA")) { cor = CalendarApp.EventColor.GREEN; sufixo = "RESERVA"; }
  }

  if(!ev) {
     if(!dados.dataStr || !dados.horaInicio) return { success: false, error: "Falta data/hora para recriar." };
     let strData = String(dados.dataStr);
     let parts = strData.includes('-') ? strData.split('-') : strData.split('/');
     let ano = parts[0].length === 4 ? parts[0] : parts[2];
     let mes = parts[1];
     let dia = parts[0].length === 4 ? parts[2] : parts[0];
     
     const [h, m] = (dados.horaInicio || "19:00").split(':').map(Number);
     let duracaoMinutos = 120;
     if (dados.duracao) duracaoMinutos = parseFloat(dados.duracao.replace(':','.')) * 60;
     const startDt = new Date(ano, mes-1, dia, h, m);
     const endDt = new Date(startDt.getTime() + (duracaoMinutos * 60 * 1000));
     
     ev = cal.createEvent(`JAZZ CINNAMON - ${dados.cliente} (${dados.tipo || 'EVENTO'}) - ${sufixo}`, startDt, endDt);
     atualizarEventoCompleto(ev, dados, cor, sufixo);
     return { success: true, newEventId: ev.getId() };
  }

  try {
    atualizarEventoCompleto(ev, dados, cor, sufixo);
    return { success: true };
  } catch (e) { return { success: false, error: e.toString() }; }
}

function excluirEventoAgenda(dados) {
  if(!dados.agendaId) return { success: true, msg: "Sem evento na agenda para excluir" };
  const cal = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
  const ev = cal.getEventById(dados.agendaId);
  if(ev) ev.deleteEvent();
  return { success: true };
}

function conferirSincronizacao(req) {
  const cal = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
  const pedidos = req.pedidos || [];
  let divergencias = [];

  for (let p of pedidos) {
    let agendaId = p.agendaId;
    let eventFound = null;

    if (agendaId) {
      try { eventFound = cal.getEventById(agendaId); } catch(e) { }
    }

    if (!eventFound) {
       divergencias.push({ id: p.id, tipo: 'AUSENTE', msg: 'Evento não foi encontrado no Google Agenda. Deseja recriá-lo?', dados: p });
    } else {
       let strData = String(p.dataStr);
       let parts = strData.includes('-') ? strData.split('-') : strData.split('/');
       if (parts.length < 3) continue;
       
       let ano = parts[0].length === 4 ? parts[0] : parts[2];
       let mes = parts[1];
       let dia = parts[0].length === 4 ? parts[2] : parts[0];
       
       let [h, m] = (p.horaInicio || "00:00").split(':').map(Number);
       let sysStart = new Date(ano, mes-1, dia, h, m);
       
       let calStart = eventFound.getStartTime();
       if (Math.abs(calStart.getTime() - sysStart.getTime()) > 60000) {
           divergencias.push({ id: p.id, tipo: 'DIVERGENTE', msg: 'A data/horário na agenda difere do ERP. Deseja corrigir a agenda?', dados: p });
       }
    }
  }

  let dataInicio = new Date();
  if (req.dataInicioStr) {
    let pInit = req.dataInicioStr.split('-');
    if (pInit.length === 3) dataInicio = new Date(pInit[0], pInit[1]-1, pInit[2], 0, 0, 0);
  } else {
    dataInicio.setHours(0,0,0,0);
  }

  let dataFim = new Date(dataInicio);
  dataFim.setFullYear(dataFim.getFullYear() + 2); 
  
  if (pedidos.length > 0) {
     let maxTime = dataInicio.getTime();
     for (let p of pedidos) {
        if (!p.dataStr) continue;
        let strData = String(p.dataStr);
        let pts = strData.includes('-') ? strData.split('-') : strData.split('/');
        if (pts.length !== 3) continue;
        
        let ano = pts[0].length === 4 ? pts[0] : pts[2];
        let mes = pts[1];
        let dia = pts[0].length === 4 ? pts[2] : pts[0];
        
        let d = new Date(ano, mes-1, dia);
        if (d.getTime() > maxTime) maxTime = d.getTime();
     }
     dataFim = new Date(maxTime);
     dataFim.setDate(dataFim.getDate() + 30); 
  }

  const eventosAgenda = cal.getEvents(dataInicio, dataFim);
  
  eventosAgenda.forEach(ev => {
     let titulo = ev.getTitle() || "";
     
     if (titulo.toUpperCase().includes("JAZZ CINNAMON")) return;
     
     let st = ev.getStartTime();
     let en = ev.getEndTime();
     let dataEvStr = Utilities.formatDate(st, "GMT-3", "yyyy-MM-dd");
     let horaIniStr = Utilities.formatDate(st, "GMT-3", "HH:mm");
     let horaFimStr = Utilities.formatDate(en, "GMT-3", "HH:mm");
     
     let criadores = ev.getCreators();
     let criadorEmail = criadores.length > 0 ? criadores[0] : "Desconhecido";
     
     let pedidoConflitante = pedidos.find(p => {
         let pStr = String(p.dataStr);
         if (pStr.includes('/')) {
             let pP = pStr.split('/');
             return `${pP[2]}-${pP[1]}-${pP[0]}` === dataEvStr;
         }
         return pStr === dataEvStr;
     });
     
     if (pedidoConflitante) {
         divergencias.push({
             id: 'ext_' + ev.getId().replace(/@.*/,''),
             tipo: 'CONFLITO',
             cliente: titulo,
             dataStr: dataEvStr,
             horaInicio: horaIniStr,
             horaTermino: horaFimStr,
             criador: criadorEmail,
             dados: pedidoConflitante 
         });
     } else {
         divergencias.push({
             id: 'ext_' + ev.getId().replace(/@.*/,''),
             tipo: 'EXTERNO',
             cliente: titulo,
             dataStr: dataEvStr,
             horaInicio: horaIniStr,
             horaTermino: horaFimStr,
             criador: criadorEmail,
             dados: { 
                 cliente: titulo, 
                 dataStr: dataEvStr, 
                 horaInicio: horaIniStr,
                 duracao: "2:00"
             }
         });
     }
  });

  return { success: true, divergencias: divergencias };
}

// ==============================================================================
// 2. GOOGLE DRIVE E PDFS MANTIDOS INTACTOS ABAIXO
// ==============================================================================

function salvarArquivoDrive(req) {
  const allowedMimes = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg'];
  if (!allowedMimes.includes(req.mimeType)) throw new Error("Tipo de arquivo não permitido.");
  
  const data = Utilities.base64Decode(req.base64.split(',')[1]);
  const blob = Utilities.newBlob(data, req.mimeType, req.filename);
  const folder = DriveApp.getFolderById(CONFIG.PASTA_COMPROVANTES_ID);
  const file = folder.createFile(blob);
  
  return { success: true, url: file.getUrl() };
}

function gerarPdfOrcamento(dados) {
  const folder = DriveApp.getFolderById(CONFIG.PASTA_DESTINO_ID);
  const templateId = parseInt(dados.convidados) >= 80 ? CONFIG.IDS_TEMPLATES_ORCAMENTO.COM_RIDER : CONFIG.IDS_TEMPLATES_ORCAMENTO.SEM_RIDER;
  
  let versaoStr = dados.versaoDoc > 0 ? ` (${dados.versaoDoc})` : "";
  const nomeArquivo = `ORÇAMENTO JAZZ CINNAMON - ${dados.cliente}${versaoStr}`;
  
  const copia = DriveApp.getFileById(templateId).makeCopy(nomeArquivo, folder);
  const doc = DocumentApp.openById(copia.getId());
  const body = doc.getBody();
  const hoje = new Date();
  const meses = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
  
  let txtDisp = dados.statusAgenda === "LIVRE" ? "DATA LIVRE NA AGENDA - DISPONÍVEL" : 
                dados.statusAgenda === "CONCORRENCIA" ? "DATA COM PRÉ-RESERVAS EM ANDAMENTO - AGUARDANDO CONFIRMAÇÃO" :
                "DATA COM EVENTO CONFIRMADO - SUJEITO A ANÁLISE DE HORÁRIO/LOGÍSTICA";

  let valorNumerico = parseFloat(dados.valor || 0);
  let valorFormatado = valorNumerico.toLocaleString('pt-BR', {minimumFractionDigits: 2});
  let extenso = valorPorExtenso(valorNumerico);
  let valorFinalComExtenso = `R$ ${valorFormatado} (${extenso})`;

  const dataValidade = new Date(); dataValidade.setDate(hoje.getDate() + 10);
  const textoValidade = `${dataValidade.getDate()} de ${meses[dataValidade.getMonth()]} de ${dataValidade.getFullYear()}`;

  let dataPtBr = String(dados.dataStr);
  if (dataPtBr.includes('-')) dataPtBr = dataPtBr.split('-').reverse().join('/');

  body.replaceText('{{Nome Completo / Empresa}}', dados.cliente);
  body.replaceText('{{Tipo de Evento}}', dados.tipo);
  body.replaceText('{{Local}}', `${dados.local} - ${dados.cidade}/${dados.uf}`);
  body.replaceText('{{Num_CONV}}', dados.convidados);
  body.replaceText('{{Dia do Evento}}', dataPtBr);
  body.replaceText('{{HORA_INICIO}}', dados.horaInicio);
  body.replaceText('{{VALOR}}', valorFinalComExtenso); 
  body.replaceText('{{DATA_GERACAO_ORCAMENTO}}', `${hoje.getDate()} de ${meses[hoje.getMonth()]} de ${hoje.getFullYear()}`);
  body.replaceText('{{VALIDADE_ORCAMENTO}}', textoValidade); 
  body.replaceText('{{DURACAO_EVENTO}}', dados.duracao);
  body.replaceText('{{Disponibilidade DATA}}', txtDisp);
  
  doc.saveAndClose();
  const pdf = folder.createFile(copia.getAs('application/pdf'));

  if(dados.enviarEmail !== false && dados.email) {
    const htmlEmail = `<div style="font-family: Arial, sans-serif; color: #333; max-width: 600px;"><p>Olá <b>${dados.cliente}</b>,</p><p>Segue em anexo o orçamento que solicitou através do nosso sistema para seu evento no dia <b>${dataPtBr}</b>, em <b>${dados.cidade}-${dados.uf}</b>.</p><p>Oferecemos desconto para pagamento à vista no ato da assinatura do contrato.</p><p>Qualquer dúvida entre em contato através do whatsapp (54) 99175 8831, falar com Luciano.</p><br><p>Atenciosamente,</p><p><b>O JAZZ NOSSO DE CADA DIA</b><br>Cnpj: 50.322.210/0001-74</p></div>`;
    MailApp.sendEmail({ to: dados.email, subject: `Orçamento Jazz Cinnamon - ${dataPtBr}`, htmlBody: htmlEmail, attachments: [pdf] });
  }

  return { success: true, pdfUrl: pdf.getUrl(), docUrl: copia.getUrl(), enviado: dados.enviarEmail !== false };
}

function gerarPdfContrato(dados) {
  const docLimpo = String(dados.documento).replace(/\D/g, ''); 
  const isPJ = docLimpo.length > 11;
  const isRider = dados.tem_rider === "SIM";
  
  const folderId = isPJ ? CONFIG.PASTAS_CONTRATOS.CNPJ : CONFIG.PASTAS_CONTRATOS.CPF;
  const folder = DriveApp.getFolderById(folderId);
  const templateId = isPJ ? (isRider ? CONFIG.IDS_TEMPLATES_CONTRATO.PJ.COM_RIDER : CONFIG.IDS_TEMPLATES_CONTRATO.PJ.SEM_RIDER) : (isRider ? CONFIG.IDS_TEMPLATES_CONTRATO.PF.COM_RIDER : CONFIG.IDS_TEMPLATES_CONTRATO.PF.SEM_RIDER);
  
  let versaoStr = dados.versaoDoc > 0 ? ` (${dados.versaoDoc})` : "";
  const nomeArquivo = `CONTRATO JAZZ CINNAMON - ${dados.nome_contratante_formal}${versaoStr}`;

  const copia = DriveApp.getFileById(templateId).makeCopy(nomeArquivo, folder);
  const doc = DocumentApp.openById(copia.getId());
  const body = doc.getBody();

  let valFinal = parseFloat(dados.valor_final_contrato || 0);
  let valExtenso = valorPorExtenso(valFinal);
  let halfPay = valFinal / 2;
  let halfPayExtenso = valorPorExtenso(halfPay);

  let dataPtBr = String(dados.dataStr);
  if (dataPtBr.includes('-')) dataPtBr = dataPtBr.split('-').reverse().join('/');
  
  const dataEventoExtenso = dataPorExtenso(dataPtBr);
  const horaInicioExtenso = formatarHoraExtenso(dados.horaInicio);
  
  let [durH, durM] = (dados.duracao || "02:00").split(':').map(Number);
  let duracaoShow = "";
  if(durH > 0) duracaoShow += durH === 1 ? "UMA HORA" : (durH === 2 ? "DUAS HORAS" : `${durH} HORAS`);
  if(durM > 0) duracaoShow += (duracaoShow?" E ":"") + (durM===30 ? "MEIA" : `${durM} MINUTOS`);
  if(duracaoShow === "") duracaoShow = "A DEFINIR";

  const hoje = new Date();
  const meses = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];
  const dataContratoExtenso = `${hoje.getDate()} de ${meses[hoje.getMonth()]} de ${hoje.getFullYear()}`;
  
  const sufixo = isPJ ? "CNPJ" : "CPF";
  const tagDoc = isPJ ? "{{CNPJ}}" : "{{CPF}}";

  body.replaceText('{{Nome Contratante}}', dados.nome_contratante_formal);
  body.replaceText(tagDoc, dados.documento); 
  body.replaceText(`{{CIDADE ${sufixo}}}`, dados.contratante_cidade);
  body.replaceText(`{{ESTADO ${sufixo}}}`, dados.contratante_uf);
  body.replaceText(`{{ENDEREÇO ${sufixo}}}`, dados.contratante_endereco + ", " + dados.bairro); 
  body.replaceText(`{{CEP ${sufixo}}}`, dados.contratante_cep);
  
  body.replaceText(`{{DATA EVE ${sufixo}}}`, dataEventoExtenso);
  body.replaceText(`{{MUN EVE ${sufixo}}}`, dados.cidade); 
  body.replaceText(`{{EST EVE ${sufixo}}}`, dados.uf);
  body.replaceText(`{{LOCAL EVE ${sufixo}}}`, dados.local);
  body.replaceText(`{{END EVE ${sufixo}}}`, dados.local_evento_endereco);
  body.replaceText(`{{INICIO ${sufixo}}}`, horaInicioExtenso);
  body.replaceText(`{{TEMP EVE ${sufixo}}}`, duracaoShow);
  
  body.replaceText('{{VALOR ORC}}', "R$ " + valFinal.toLocaleString('pt-BR', {minimumFractionDigits: 2}));
  body.replaceText('{{VALOR EXTENSO}}', valExtenso);
  body.replaceText('{{half_pay}}', "R$ " + halfPay.toLocaleString('pt-BR', {minimumFractionDigits: 2}));
  body.replaceText('{{HALF_PAY_EXTENSO}}', halfPayExtenso);
  body.replaceText('{{DATA CONTRATO}}', dataContratoExtenso);

  doc.saveAndClose();
  const pdf = folder.createFile(copia.getAs('application/pdf'));

  if(dados.email_cliente) {
    const htmlClient = `<div style="font-family: 'Montserrat', Arial, sans-serif; color: #1a1a1a; max-width: 600px; margin: 0 auto; background-color: #fcfaf7; padding: 30px; border-top: 4px solid #c5a059; border-radius: 8px; box-shadow: 0 4px 10px rgba(0,0,0,0.05);"><h2 style="color: #c5a059; text-align: center; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 30px;">Contrato de Prestação de Serviços</h2><p style="font-size: 15px; line-height: 1.6;">Olá <b>${dados.nome_contratante_formal}</b>,</p><p style="font-size: 15px; line-height: 1.6;">É um imenso prazer confirmar a nossa parceria para o seu evento.</p><p style="font-size: 15px; line-height: 1.6;">Conforme acordado, anexamos a este e-mail o <b>Contrato de Prestação de Serviços Musicais</b> devidamente formalizado pelos nossos sistemas.</p><div style="background-color: #fff; border-left: 3px solid #c5a059; padding: 15px; margin: 25px 0;"><p style="margin: 0 0 10px 0; font-size: 14px;"><b>Data do Evento:</b> ${dataPtBr}</p><p style="margin: 0 0 10px 0; font-size: 14px;"><b>Localização:</b> ${dados.local} (${dados.cidade} - ${dados.uf})</p><p style="margin: 0; font-size: 14px; color: #10b981;"><b>Valor Final Acordado:</b> R$ ${valFinal.toLocaleString('pt-BR', {minimumFractionDigits: 2})}</p></div><p style="font-size: 15px; line-height: 1.6;">Pedimos a gentileza de conferir todos os dados em anexo. Caso as cláusulas estejam corretas, basta realizar o pagamento do sinal (descrito no contrato) para garantirmos a reserva oficial da sua data na nossa agenda.</p><br><p style="font-size: 13px; color: #777;">Atenciosamente,</p><p style="font-size: 16px; font-weight: bold; color: #1a1a1a; margin: 5px 0;">Luciano Souza</p></div>`;
    MailApp.sendEmail({ to: dados.email_cliente, bcc: CONFIG.EMAIL_NOTIFICACAO, subject: `Contrato de Prestação de Serviços - Jazz Cinnamon`, htmlBody: htmlClient, attachments: [pdf] });
  }

  return { success: true, pdfUrl: pdf.getUrl(), docUrl: copia.getUrl() };
}

function valorPorExtenso(v) { if (v === 0) return "zero reais"; v = parseFloat(v.toFixed(2)); var inteiro = Math.floor(v), resto = Math.round((v - inteiro) * 100), ret = ""; if (inteiro > 0) { ret = numeroPorExtenso(inteiro); ret += inteiro === 1 ? " real" : " reais"; } if (resto > 0) { if (ret !== "") ret += " e "; ret += numeroPorExtenso(resto); ret += resto === 1 ? " centavo" : " centavos"; } return ret; }
function numeroPorExtenso(n) { var u = ["", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez", "onze", "doze", "treze", "quatorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove"], d = ["", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"], c = ["", "cento", "duzentos", "trezentos", "quatrocentos", "quinhentos", "seiscentos", "setecentos", "oitocentos", "novecentos"]; if (n < 20) return u[n]; if (n < 100) return d[Math.floor(n/10)] + (n%10 ? " e " + u[n%10] : ""); if (n === 100) return "cem"; if (n < 1000) return c[Math.floor(n/100)] + (n%100 ? " e " + numeroPorExtenso(n%100) : ""); if (n < 1000000) { var mil = Math.floor(n/1000), resto = n%1000, t = (mil === 1 ? "um mil" : numeroPorExtenso(mil) + " mil"); if (resto > 0) { if (resto < 100 || resto % 100 === 0) t += " e "; else t += ", "; t += numeroPorExtenso(resto); } return t; } return n.toString(); }
function formatarHoraExtenso(horaStr) { if (!horaStr || !horaStr.includes(':')) return horaStr; const [h, m] = horaStr.split(':').map(Number); let texto = `${horaStr} (`; texto += numeroPorExtenso(h) + (h === 1 ? " hora" : " horas"); if (m > 0) { texto += " e " + numeroPorExtenso(m) + (m === 1 ? " minuto" : " minutos"); } texto += ")"; return texto; }
function dataPorExtenso(s) { if(!s || s.length < 8) return s; const m = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"]; let p; if(s.includes('-')) { p = s.split('-'); return `${p[2]} de ${m[parseInt(p[1],10) - 1]} de ${p[0]}`; } else { p = s.split('/'); return `${p[0]} de ${m[parseInt(p[1],10) - 1]} de ${p[2]}`; } }