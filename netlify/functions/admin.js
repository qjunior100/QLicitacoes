// QLicitações — Netlify Function: Painel Admin
// Endpoint: /api/admin (GET)
// Substitui as ações admin do doGet no Apps Script

const { createClient } = require("@supabase/supabase-js");

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

exports.handler = async (event) => {
  const headers = {
    "Content-Type":                "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers };

  const p = event.queryStringParameters || {};

  // Autenticação obrigatória em todas as ações admin
  if (!process.env.ADMIN_SECRET || p.senha !== process.env.ADMIN_SECRET) {
    return { statusCode: 401, headers, body: JSON.stringify({ ok: false, motivo: "Acesso negado" }) };
  }

  const acao = p.acao || "";
  const sb   = getSupabase();

  try {

    // ── RESUMO (cards do dashboard) ──────────────────────────
    if (acao === "resumo") {
      const { data, error } = await sb.from("licencas").select("status, vencimento");
      if (error) throw error;

      const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
      const em7  = new Date(hoje); em7.setDate(em7.getDate() + 7);

      let total = 0, ativos = 0, vencendo7 = 0, vencidos = 0, bloqueados = 0;
      for (const r of data || []) {
        total++;
        const st   = (r.status || "").toLowerCase();
        const venc = r.vencimento ? new Date(r.vencimento) : null;
        if (venc) venc.setHours(0, 0, 0, 0);

        if (st === "bloqueada" || st === "cancelada") { bloqueados++; continue; }
        if (venc && venc < hoje)  { vencidos++; continue; }
        if (st === "ativa")       { ativos++; }
        if (venc && venc >= hoje && venc <= em7) vencendo7++;
      }

      return ok(headers, { total, ativos, vencendo7, vencidos, bloqueados });
    }

    // ── LISTAR LICENÇAS ──────────────────────────────────────
    if (acao === "listar") {
      const { data, error } = await sb
        .from("licencas")
        .select("*")
        .order("data_criacao", { ascending: false });
      if (error) throw error;
      return ok(headers, { licencas: data });
    }

    // ── BLOQUEAR ─────────────────────────────────────────────
    if (acao === "bloquear") {
      if (!p.chave) return erro(headers, "chave e obrigatoria");
      const { error } = await sb.from("licencas")
        .update({ status: "bloqueada", obs: "Bloqueado manualmente em " + new Date().toISOString() })
        .eq("chave", p.chave);
      if (error) throw error;
      return ok(headers, { msg: "Licenca bloqueada: " + p.chave });
    }

    // ── DESBLOQUEAR ──────────────────────────────────────────
    if (acao === "desbloquear") {
      if (!p.chave) return erro(headers, "chave e obrigatoria");
      const { error } = await sb.from("licencas")
        .update({ status: "ativa", obs: "Desbloqueado manualmente em " + new Date().toISOString() })
        .eq("chave", p.chave);
      if (error) throw error;
      return ok(headers, { msg: "Licenca desbloqueada: " + p.chave });
    }

    // ── ESTENDER VENCIMENTO ──────────────────────────────────
    if (acao === "estender") {
      if (!p.chave) return erro(headers, "chave e obrigatoria");
      const dias = parseInt(p.dias || "30");
      if (isNaN(dias) || dias <= 0) return erro(headers, "dias deve ser um numero positivo");

      const { data, error } = await sb.from("licencas")
        .select("vencimento")
        .eq("chave", p.chave)
        .single();
      if (error || !data) return erro(headers, "Chave nao encontrada");

      const hoje    = new Date();
      const vencAtual = new Date(data.vencimento);
      const base    = vencAtual > hoje ? vencAtual : hoje;
      base.setDate(base.getDate() + dias);

      await sb.from("licencas").update({
        vencimento: base.toISOString().split("T")[0],
        status:     "ativa",
        obs:        `Estendido ${dias} dias em ` + new Date().toISOString(),
      }).eq("chave", p.chave);

      return ok(headers, { msg: `Licenca estendida ${dias} dias. Novo vencimento: ${base.toISOString().split("T")[0]}` });
    }

    // ── CANCELAR ─────────────────────────────────────────────
    if (acao === "cancelar") {
      if (!p.chave) return erro(headers, "chave e obrigatoria");
      const { error } = await sb.from("licencas")
        .update({ status: "cancelada", obs: "Cancelado manualmente em " + new Date().toISOString() })
        .eq("chave", p.chave);
      if (error) throw error;
      return ok(headers, { msg: "Licenca cancelada: " + p.chave });
    }

    // ── BUSCAR POR EMAIL ─────────────────────────────────────
    if (acao === "buscar_email") {
      if (!p.email) return erro(headers, "email e obrigatorio");
      const { data, error } = await sb.from("licencas")
        .select("*")
        .eq("email", p.email.toLowerCase().trim())
        .order("data_criacao", { ascending: false });
      if (error) throw error;
      return ok(headers, { licencas: data || [] });
    }

    // ── REMOVER UUID (reativar em nova máquina) ──────────────
    if (acao === "remover_uuid") {
      if (!p.chave) return erro(headers, "chave e obrigatoria");
      const { error } = await sb.from("licencas")
        .update({ uuid_maquina: "pendente", status: "pendente", obs: "UUID removido em " + new Date().toISOString() })
        .eq("chave", p.chave);
      if (error) throw error;
      return ok(headers, { msg: "UUID removido. Cliente pode ativar em nova maquina." });
    }

    return erro(headers, "Acao invalida: " + acao);

  } catch (err) {
    console.error("Erro admin:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, motivo: err.message }) };
  }
};

function ok(headers, data) {
  return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ...data }) };
}

function erro(headers, motivo, status = 400) {
  return { statusCode: status, headers, body: JSON.stringify({ ok: false, motivo }) };
}
