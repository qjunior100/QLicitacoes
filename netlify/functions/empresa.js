// QLicitações — Netlify Function: Atualizar empresa/CNPJ
// Endpoint: /api/empresa (GET)
// Chamado por license.py após o usuário salvar configurações

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

  const p     = event.queryStringParameters || {};
  const chave = (p.chave   || "").trim();
  const empresa = (p.empresa || "").trim();
  const cnpj    = (p.cnpj   || "").trim();

  if (!chave) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, motivo: "chave obrigatoria" }) };
  }

  try {
    const sb = getSupabase();

    // Verifica se a chave existe antes de atualizar
    const { data, error } = await sb
      .from("licencas")
      .select("chave")
      .eq("chave", chave)
      .single();

    if (error || !data) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: false, motivo: "Chave nao encontrada" }) };
    }

    // Atualiza empresa e CNPJ
    const updates = {};
    if (empresa) updates.empresa = empresa;
    if (cnpj)    updates.cnpj    = cnpj;

    if (Object.keys(updates).length > 0) {
      await sb.from("licencas").update(updates).eq("chave", chave);
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };

  } catch (err) {
    console.error("Erro empresa:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, motivo: err.message }) };
  }
};
