const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

const MODELS = {
  "netron-1.0": "openai/gpt-oss-20b",
  "netron-1.5-qwen-27b": "qwen/qwen3.6-27b",
  "netron-2.0-qwen-32b": "qwen/qwen3-32b",
  "netron-2.1-nexus": "llama-3.3-70b-versatile",
  "netron-2.2-nexus": "openai/gpt-oss-120b"
};

const COMPLETION_LIMITS = {
  "netron-1.0": 900,
  "netron-1.5-qwen-27b": 1100,
  "netron-2.0-qwen-32b": 1300,
  "netron-2.1-nexus": 1500,
  "netron-2.2-nexus": 1800
};

const requests = new Map();

function setCors(req, res) {
  const allowed = new Set(["https://netron.net.tr", "https://www.netron.net.tr"]);
  const origin = String(req.headers.origin || "");
  if (origin && !allowed.has(origin)) return false;
  res.setHeader("Access-Control-Allow-Origin", origin || "https://netron.net.tr");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  return true;
}

function allow(req) {
  const ip = String(req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
  const now = Date.now();
  const recent = (requests.get(ip) || []).filter((time) => now - time < 60000);
  if (recent.length >= 20) return false;
  recent.push(now);
  requests.set(ip, recent);
  return true;
}

function route(req) {
  const parts = req.query?.route || req.query?.["...route"];
  if (Array.isArray(parts) && parts.length) return "/" + parts.join("/");
  if (typeof parts === "string" && parts) return "/" + parts;
  const pathname = String(req.url || "").split("?")[0];
  return pathname.replace(/^\/api/, "") || "/";
}

function systemPrompt(mode) {
  const rule = {
    web: "Web araci yoksa kaynak uydurma; kullaniciya net bir arama plani sun.",
    agent: "Hedefi uygulanabilir adimlara ayir, varsayimlari ve riskleri belirt.",
    deep: "Kaniti, belirsizligi ve sonraki adimlari ayri basliklarla sun."
  }[mode] || "Kisa, dogru ve yararli cevaplar ver.";
  return "Sen Netron AI adinda Turkce konusan bir asistansin. " + rule + " Gizli dusunme adimlarini yazma.";
}

module.exports = async (req, res) => {
  if (!setCors(req, res)) return res.status(403).json({ error: "Bu origin icin erisim yok." });
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!allow(req)) return res.status(429).json({ error: "Cok fazla istek gonderildi. Bir dakika sonra tekrar dene." });

  const path = route(req);
  if (req.method === "GET" && path === "/health") return res.status(200).json({ ok: true, service: "netron-node-api" });
  if (req.method === "GET" && path === "/catalog") return res.status(200).json({
    configured: Boolean(process.env.GROQ_API_KEY),
    models: { text: Object.entries(MODELS).map(([id, base]) => ({ id, base, label: id })) },
    services: { text: { configured: Boolean(process.env.GROQ_API_KEY), provider: "groq" } }
  });
  if (req.method !== "POST" || path !== "/chat") return res.status(404).json({ error: "API endpoint bulunamadi." });

  const key = String(process.env.GROQ_API_KEY || "").trim();
  if (!key) return res.status(503).json({ error: "Netron API henuz yapilandirilmamis." });
  const body = req.body || {};
  const model = MODELS[body.model] || MODELS["netron-1.0"];
  const messages = Array.isArray(body.messages) ? body.messages.slice(-24).map((item) => ({
    role: item?.role === "assistant" ? "assistant" : "user",
    content: String(item?.content || "").slice(0, 14000)
  })).filter((item) => item.content.trim()) : [];
  if (!messages.length) return res.status(400).json({ error: "Bos mesaj gonderilemez." });

  try {
    const upstream = await fetch(GROQ_URL, {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: systemPrompt(body.mode) }, ...messages],
        temperature: 0.7,
        max_completion_tokens: COMPLETION_LIMITS[body.model] || COMPLETION_LIMITS["netron-1.0"]
      })
    });
    const payload = await upstream.json().catch(() => ({}));
    if (upstream.status === 429) {
      return res.status(429).json({
        error: "Netron sunucusu kisa sureli yogun. Yaklasik 20 saniye sonra tekrar dene.",
        retryAfter: 20
      });
    }
    if (!upstream.ok) return res.status(upstream.status).json({ error: payload?.error?.message || "Groq istegi basarisiz." });
    const content = payload?.choices?.[0]?.message?.content;
    if (!content) return res.status(502).json({ error: "Yapay zeka metin donmedi." });
    return res.status(200).json({ message: { role: "assistant", content } });
  } catch (error) {
    return res.status(502).json({ error: String(error.message || "Sunucu hatasi.") });
  }
};
