// QLicitações — Netlify Function: Licenciamento + Webhook Hotmart
// Substitui Google Apps Script (doGet + doPost)
// Endpoint: /api/licenca (GET e POST)

const { createClient } = require('@supabase/supabase-js');
const nodemailer        = require('nodemailer');

// ─────────────────────────────────────────────
// CONFIGURAÇÃO
// ─────────────────────────────────────────────
const DIAS_AVISO_VENCIMENTO = 7;

const PRODUTOS_HOTMART = {
  "7318490": { plano: "Completo", segmento: "*", dias: 30,  preco: 39.90  }, // Mensal legado
  "7350190": { plano: "Completo", segmento: "*", dias: 30,  preco: 39.90  }, // Mensal assinatura
  "7318600": { plano: "Completo", segmento: "*", dias: 365, preco: 399.90 }, // Anual
};

// ─────────────────────────────────────────────
// UTILITÁRIOS
// ─────────────────────────────────────────────
function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

function getTransporter() {
  return nodemailer.createTransport({
    host:   "smtp.office365.com",
    port:   587,
    secure: false,
    auth: {
      user: process.env.EMAIL_LOGIN,
      pass: process.env.EMAIL_SENHA,
    },
    tls: { ciphers: "SSLv3" },
  });
}

function _gerarCodigoChave() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const partes = [];
  for (let s = 0; s < 3; s++) {
    let seg = "";
    for (let c = 0; c < 4; c++) {
      seg += chars[Math.floor(Math.random() * chars.length)];
    }
    partes.push(seg);
  }
  return "QL-" + partes.join("-");
}

function _formatarData(date) {
  const d  = new Date(date);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

function _capitalize(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : "";
}

// ─────────────────────────────────────────────
// ENTRY POINT
// ─────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = {
    "Content-Type":                "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  // Preflight CORS
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers };
  }

  try {
    if (event.httpMethod === "POST") {
      return await handleWebhook(event, headers);
    }
    if (event.httpMethod === "GET") {
      return await handleGet(event, headers);
    }
    return resp(headers, { ok: false, motivo: "Metodo nao permitido" }, 405);
  } catch (err) {
    console.error("Erro interno:", err);
    return resp(headers, { ok: false, motivo: "Erro interno: " + err.message }, 500);
  }
};

function resp(headers, body, status = 200) {
  return { statusCode: status, headers, body: JSON.stringify(body) };
}

// ─────────────────────────────────────────────
// GET — ações do aplicativo
// ─────────────────────────────────────────────
async function handleGet(event, headers) {
  const p    = event.queryStringParameters || {};
  const acao = p.acao || "";

  let resultado;

  if (acao === "validar") {
    resultado = await validarLicenca(p.chave, p.uuid, p.email);

  } else if (acao === "ativar") {
    resultado = await ativarLicenca(p.chave, p.uuid, p.email);

  } else if (acao === "gerar") {
    if (!process.env.ADMIN_SECRET || p.senha !== process.env.ADMIN_SECRET) {
      resultado = { ok: false, motivo: "Acesso negado" };
    } else {
      resultado = await gerarChave(p.plano, p.email, p.dias, p.segmentos);
    }

  } else if (acao === "gerar_web") {
    resultado = await gerarChaveWeb(p.email, p.plano, p.dias, p.segmentos, p.produto);

  } else if (acao === "recuperar") {
    resultado = await recuperarChave(p.email);

  } else {
    resultado = { ok: false, motivo: "Acao invalida" };
  }

  return resp(headers, resultado);
}

// ─────────────────────────────────────────────
// POST — webhook Hotmart
// Agora com leitura real do header X-Hotmart-Hottok
// ─────────────────────────────────────────────
async function handleWebhook(event, headers) {
  const hottok        = process.env.HOTMART_HOTTOK;
  const tokenRecebido = event.headers["x-hotmart-hottok"] || "";

  if (!hottok || tokenRecebido !== hottok) {
    console.log("Webhook rejeitado — hottok invalido:", tokenRecebido);
    return resp(headers, { ok: false, motivo: "Acesso negado" }, 401);
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return resp(headers, { ok: false, motivo: "Payload invalido" }, 400);
  }

  const evento = payload.event || "";
  const dados  = payload.data  || {};

  console.log("Webhook recebido:", evento, JSON.stringify(payload).substring(0, 300));

  if (["PURCHASE_APPROVED", "PURCHASE_COMPLETE", "SUBSCRIPTION_REACTIVATED"].includes(evento)) {
    return resp(headers, await processarCompra(dados));
  }
  if (["PURCHASE_CANCELED", "PURCHASE_REFUNDED", "SUBSCRIPTION_CANCELLATION"].includes(evento)) {
    return resp(headers, await processarCancelamento(dados));
  }
  if (evento === "SUBSCRIPTION_RENEWAL_APPROVED") {
    return resp(headers, await processarRenovacao(dados));
  }

  return resp(headers, { ok: true, msg: "Evento ignorado: " + evento });
}

// ─────────────────────────────────────────────
// VALIDAR LICENÇA
// ─────────────────────────────────────────────
async function validarLicenca(chave, uuid, email) {
  if (!chave || !uuid) return { ok: false, motivo: "Parametros invalidos" };

  const sb = getSupabase();
  const { data, error } = await sb
    .from("licencas")
    .select("*")
    .eq("chave", chave.trim())
    .single();

  if (error || !data) return { ok: false, motivo: "Chave nao encontrada" };

  const status = (data.status || "").toLowerCase();
  if (status === "bloqueada" || status === "cancelada") {
    return { ok: false, motivo: "Licenca bloqueada ou cancelada" };
  }

  const hoje       = new Date(); hoje.setHours(0, 0, 0, 0);
  const vencimento = new Date(data.vencimento); vencimento.setHours(0, 0, 0, 0);

  if (hoje > vencimento) {
    await sb.from("licencas").update({ status: "vencida" }).eq("chave", chave.trim());
    return { ok: false, motivo: "Licenca vencida em " + _formatarData(vencimento) };
  }

  const uuidBanco = data.uuid_maquina || "";
  if (!uuidBanco || uuidBanco === "pendente") {
    return { ok: false, motivo: "Licenca nao ativada. Use a tela de ativacao." };
  }

  if (uuidBanco !== uuid) {
    await sb.from("licencas")
      .update({ obs: "UUID divergente em " + new Date().toISOString() })
      .eq("chave", chave.trim());
    return { ok: false, motivo: "Licenca registrada em outro computador. Contate: adm@qlengenharia.com" };
  }

  const diasRestantes = Math.ceil((vencimento - hoje) / (1000 * 60 * 60 * 24));

  // Registra último acesso e versão do app (se enviada)
  await sb.from("licencas")
    .update({ ultimo_acesso: new Date().toISOString() })
    .eq("chave", chave.trim());

  return {
    ok:               true,
    plano:            data.plano,
    dias_restantes:   diasRestantes,
    aviso_vencimento: diasRestantes <= DIAS_AVISO_VENCIMENTO,
    vencimento:       _formatarData(vencimento),
    segmentos_permitidos: data.segmentos || "*",
  };
}

// ─────────────────────────────────────────────
// ATIVAR LICENÇA
// ─────────────────────────────────────────────
async function ativarLicenca(chave, uuid, email) {
  if (!chave || !uuid || !email) return { ok: false, motivo: "Parametros invalidos" };

  const sb = getSupabase();
  const { data, error } = await sb
    .from("licencas")
    .select("*")
    .eq("chave", chave.trim().toUpperCase())
    .single();

  if (error || !data) return { ok: false, motivo: "Chave nao encontrada ou email invalido" };

  if (data.email.toLowerCase() !== email.trim().toLowerCase()) {
    return { ok: false, motivo: "Email nao corresponde a licenca." };
  }

  const status = (data.status || "").toLowerCase();
  if (status === "bloqueada" || status === "cancelada") {
    return { ok: false, motivo: "Licenca bloqueada ou cancelada" };
  }

  const hoje = new Date();
  const venc = new Date(data.vencimento);
  if (hoje > venc) return { ok: false, motivo: "Licenca vencida" };

  const uuidBanco = data.uuid_maquina || "";

  // Já ativada
  if (uuidBanco && uuidBanco !== "pendente") {
    if (uuidBanco === uuid) {
      return {
        ok: true,
        plano: data.plano,
        segmentos_permitidos: data.segmentos || "*",
        mensagem: "Licenca ja ativada nesta maquina",
      };
    }
    return { ok: false, motivo: "Licenca ja ativada em outro computador. Contate: adm@qlengenharia.com" };
  }

  const diasRestantes = Math.ceil((venc - hoje) / (1000 * 60 * 60 * 24));

  await sb.from("licencas").update({
    uuid_maquina:  uuid,
    status:        "ativa",
    obs:           new Date().toISOString(),
    aceite_termos: "true",
  }).eq("chave", chave.trim().toUpperCase());

  return {
    ok:                  true,
    plano:               data.plano,
    dias_restantes:      diasRestantes,
    vencimento:          _formatarData(venc),
    segmentos_permitidos: data.segmentos || "*",
    mensagem:            "Licenca ativada com sucesso!",
  };
}

// ─────────────────────────────────────────────
// GERAR CHAVE — uso exclusivo do vendedor / admin
// ─────────────────────────────────────────────
async function gerarChave(plano, email, dias, segmentos) {
  if (!plano || !email || !dias) {
    return { ok: false, motivo: "plano, email e dias sao obrigatorios" };
  }

  const segmentosPermitidos = plano.toLowerCase() === "completo" ? "*" : (segmentos || "");
  const chave = _gerarCodigoChave();

  const hoje       = new Date();
  const vencimento = new Date(hoje);
  vencimento.setDate(vencimento.getDate() + parseInt(dias));

  const sb = getSupabase();
  const { error } = await sb.from("licencas").insert({
    chave,
    email:          email.toLowerCase().trim(),
    uuid_maquina:   "pendente",
    plano,
    data_criacao:   hoje.toISOString(),
    vencimento:     vencimento.toISOString().split("T")[0],
    status:         "pendente",
    segmentos:      segmentosPermitidos,
  });

  if (error) return { ok: false, motivo: "Erro ao gerar chave: " + error.message };

  return {
    ok:                  true,
    chave,
    email,
    plano,
    dias:                parseInt(dias),
    segmentos_permitidos: segmentosPermitidos,
    vencimento:          _formatarData(vencimento),
  };
}

// ─────────────────────────────────────────────
// GERAR CHAVE WEB — chamado pela página ativar.html
// ─────────────────────────────────────────────
async function gerarChaveWeb(email, plano, dias, segmentos, produtoId) {
  if (!email || !plano || !dias) {
    return { ok: false, motivo: "Dados incompletos. Tente novamente." };
  }

  email = email.trim().toLowerCase();
  if (!email.includes("@") || !email.includes(".")) {
    return { ok: false, motivo: "Email invalido." };
  }

  const sb = getSupabase();
  const { data: linhas } = await sb
    .from("licencas")
    .select("*")
    .eq("email", email)
    .not("status", "eq", "cancelada")
    .not("status", "eq", "bloqueada")
    .order("data_criacao", { ascending: false });

  if (!linhas || linhas.length === 0) {
    return { ok: false, motivo: "Email nao encontrado. Verifique se usou o mesmo email da compra no Hotmart, ou aguarde alguns minutos e tente novamente." };
  }

  const registro      = linhas[0];
  const planoRegistrado  = (registro.plano || "").toLowerCase();
  const planoSolicitado  = plano.trim().toLowerCase();
  const diasSolicitados  = parseInt(dias);
  const cicloSolicitado  = diasSolicitados >= 365 ? "Anual" : "Mensal";

  const dtCriacao = new Date(registro.data_criacao);
  const dtVenc    = new Date(registro.vencimento);
  const diffDias  = Math.round((dtVenc - dtCriacao) / (1000 * 60 * 60 * 24));
  const cicloRegistrado = diffDias >= 365 ? "Anual" : "Mensal";

  if (planoRegistrado && planoRegistrado !== planoSolicitado) {
    return { ok: false, motivo: `Sua compra e do plano ${_capitalize(planoRegistrado)} ${cicloRegistrado}. Selecione o plano correto ou entre em contato com o suporte.` };
  }

  if (cicloSolicitado !== cicloRegistrado) {
    return { ok: false, motivo: `Sua compra e do plano ${_capitalize(planoRegistrado)} ${cicloRegistrado}, nao ${cicloSolicitado}. Selecione o ciclo correto ou entre em contato com o suporte.` };
  }

  const cfg = {
    plano,
    segmento: planoSolicitado === "completo" ? "*" : (segmentos || ""),
    dias:     parseInt(dias),
  };

  if (registro.chave) {
    try { await _enviarEmailChave(email, "Cliente", registro.chave, cfg, "reenvio"); } catch (e) {}
    return { ok: true, msg: "Chave enviada para " + email };
  }

  const resultado = await gerarChave(plano, email, dias, segmentos);
  if (!resultado.ok) return resultado;

  try {
    await _enviarEmailChave(email, "Cliente", resultado.chave, cfg, "nova");
  } catch (e) {
    // Email falhou — retorna chave na tela para o cliente não ficar sem acesso
    return { ok: true, chave: resultado.chave, avisoEmail: "Chave gerada. Salve pois o email nao foi enviado." };
  }

  return { ok: true, msg: "Chave gerada e enviada para " + email };
}

// ─────────────────────────────────────────────
// RECUPERAR CHAVE — cliente informa email e recebe por email
// ─────────────────────────────────────────────
async function recuperarChave(email) {
  if (!email || !email.includes("@")) return { ok: false, motivo: "Email invalido." };
  email = email.trim().toLowerCase();

  const sb = getSupabase();
  const { data: linhas } = await sb
    .from("licencas")
    .select("*")
    .eq("email", email)
    .not("status", "eq", "cancelada")
    .not("status", "eq", "bloqueada")
    .order("data_criacao", { ascending: false })
    .limit(1);

  if (!linhas || linhas.length === 0) {
    return { ok: false, motivo: "Nenhuma chave ativa encontrada para esse email. Verifique se usou o email correto na compra ou contate o suporte." };
  }

  const registro = linhas[0];
  const cfg = { plano: registro.plano, segmento: registro.segmentos || "*", dias: 30 };

  try {
    await _enviarEmailChave(email, "Cliente", registro.chave, cfg, "reenvio");
  } catch (e) {
    return { ok: true, chave: registro.chave, avisoEmail: "Chave encontrada. Salve pois o email nao foi enviado." };
  }

  return { ok: true, msg: "Chave enviada para " + email };
}

// ─────────────────────────────────────────────
// PROCESSAR COMPRA HOTMART
// ─────────────────────────────────────────────
async function processarCompra(dados) {
  const produtoId = String(dados.product?.id || "").trim();
  const email     = String(dados.buyer?.email || "").trim().toLowerCase();
  const nome      = String(dados.buyer?.name  || "Cliente").trim();

  if (!produtoId || !email) {
    return { ok: false, motivo: "Produto ou email ausente no payload" };
  }

  const cfg = PRODUTOS_HOTMART[produtoId];
  if (!cfg) {
    console.log("Produto nao mapeado:", produtoId, "| Email:", email);
    return { ok: false, motivo: "Produto nao mapeado: " + produtoId };
  }

  const sb = getSupabase();
  const { data: existente } = await sb
    .from("licencas")
    .select("chave, status, vencimento")
    .eq("email", email)
    .not("status", "eq", "cancelada")
    .not("status", "eq", "bloqueada")
    .order("data_criacao", { ascending: false })
    .limit(1);

  if (existente && existente.length > 0) {
    const chave = existente[0].chave;
    await _renovarVencimento(sb, chave, cfg.dias);
    await _enviarEmailChave(email, nome, chave, cfg, "renovacao");
    return { ok: true, msg: "Licenca renovada: " + chave };
  }

  const resultado = await gerarChave(cfg.plano, email, cfg.dias, cfg.segmento);
  if (!resultado.ok) return resultado;

  await _enviarEmailChave(email, nome, resultado.chave, cfg, "nova");
  return { ok: true, msg: "Chave gerada: " + resultado.chave };
}

// ─────────────────────────────────────────────
// PROCESSAR CANCELAMENTO HOTMART
// ─────────────────────────────────────────────
async function processarCancelamento(dados) {
  const email = String(dados.buyer?.email || "").trim().toLowerCase();
  if (!email) return { ok: false, motivo: "Email ausente" };

  const sb = getSupabase();
  await sb.from("licencas")
    .update({ status: "cancelada", obs: "Cancelado via Hotmart em " + new Date().toISOString() })
    .eq("email", email)
    .not("status", "eq", "cancelada")
    .not("status", "eq", "bloqueada");

  return { ok: true, msg: "Licencas canceladas para: " + email };
}

// ─────────────────────────────────────────────
// PROCESSAR RENOVAÇÃO MENSAL HOTMART
// ─────────────────────────────────────────────
async function processarRenovacao(dados) {
  const email     = String(dados.buyer?.email  || "").trim().toLowerCase();
  const nome      = String(dados.buyer?.name   || "Cliente").trim();
  const produtoId = String(dados.product?.id   || "").trim();

  const cfg = PRODUTOS_HOTMART[produtoId];
  if (!cfg) return { ok: false, motivo: "Produto nao mapeado: " + produtoId };

  const sb = getSupabase();
  const { data: existente } = await sb
    .from("licencas")
    .select("chave")
    .eq("email", email)
    .not("status", "eq", "cancelada")
    .not("status", "eq", "bloqueada")
    .limit(1);

  if (!existente || existente.length === 0) {
    return await processarCompra(dados);
  }

  const chave = existente[0].chave;
  await _renovarVencimento(sb, chave, cfg.dias);
  await _enviarEmailChave(email, nome, chave, cfg, "renovacao");
  return { ok: true, msg: "Renovado: " + chave };
}

// ─────────────────────────────────────────────
// RENOVAR VENCIMENTO
// ─────────────────────────────────────────────
async function _renovarVencimento(sb, chave, dias) {
  const { data } = await sb.from("licencas").select("vencimento").eq("chave", chave).single();
  if (!data) return;

  const hoje    = new Date();
  const vencAtual = new Date(data.vencimento);
  const base    = vencAtual > hoje ? vencAtual : hoje;
  base.setDate(base.getDate() + dias);

  await sb.from("licencas").update({
    vencimento: base.toISOString().split("T")[0],
    status:     "ativa",
    obs:        "Renovado via Hotmart em " + new Date().toISOString(),
  }).eq("chave", chave);
}

// ─────────────────────────────────────────────
// ENVIAR EMAIL COM A CHAVE
// ─────────────────────────────────────────────
async function _enviarEmailChave(email, nome, chave, cfg, tipo) {
  const segTxt  = cfg.segmento === "*" ? "Todos os segmentos (Plano Completo)" : (cfg.segmento || "Todos");
  const tipoTxt = tipo === "renovacao" ? "renovada" : "gerada";
  const diasTxt = cfg.dias >= 365 ? "365 dias (1 ano)" : cfg.dias + " dias";

  const corpo =
    `Ola, ${nome}!\n\n` +
    `Sua licenca QLicitacoes foi ${tipoTxt} com sucesso.\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `CHAVE DE ACESSO: ${chave}\n` +
    `Plano: ${cfg.plano}\n` +
    `Segmento: ${segTxt}\n` +
    `Validade: ${diasTxt}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `COMO ATIVAR:\n` +
    `1. Baixe o QLicitacoes em: https://qlicitacoes.com.br/download\n` +
    `2. Extraia o arquivo .zip e execute o QLicitacoes.exe\n` +
    `3. Se o Windows alertar, clique em 'Mais informacoes' e depois 'Executar assim mesmo'\n` +
    `4. Insira sua chave e o email: ${email}\n` +
    `5. Configure sua empresa e comece a buscar licitacoes!\n\n` +
    `Duvidas? Responda este email ou acesse: https://qlicitacoes.com.br/instrucoes\n\n` +
    `Equipe QLicitacoes`;

  const transporter = getTransporter();
  await transporter.sendMail({
    from:    '"QL Engenharia" <querobim@qlengenharia.com>',
    to:      email,
    subject: "Sua chave de acesso QLicitacoes",
    text:    corpo,
  });
}
