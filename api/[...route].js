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

async function requestCerebrasFallback(body, messages) {
  const key = String(process.env.CEREBRAS_API_KEY || "").trim();
  if (!key) return null;
  const fallbackModel = body.model === "netron-1.0" ? "gpt-oss-20b" : "gpt-oss-120b";
  try {
    const response = await fetch("https://api.cerebras.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: fallbackModel,
        messages: [{ role: "system", content: systemPrompt(body.mode) }, ...messages],
        temperature: 0.7,
        max_completion_tokens: COMPLETION_LIMITS[body.model] || COMPLETION_LIMITS["netron-1.0"]
      })
    });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => ({}));
    const content = payload?.choices?.[0]?.message?.content;
    return content ? { content, model: fallbackModel } : null;
  } catch {
    return null;
  }
}


function decodeHtml(value) {
  return String(value || "").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

async function searchReferenceSources(term, limit) {
  const results = [];
  const add = (title, url) => {
    if (title && /^https?:\/\//i.test(url) && !results.some((item) => item.url === url)) results.push({ title, url });
  };
  for (const language of ["tr", "en"]) {
    if (results.length >= limit) break;
    try {
      const response = await fetch("https://" + language + ".wikipedia.org/w/api.php?action=query&list=search&format=json&utf8=1&srlimit=5&srsearch=" + encodeURIComponent(term), {
        headers: { "User-Agent": "NetronLabsResearch/1.0 (+https://netron.net.tr)" }
      });
      const payload = await response.json().catch(() => ({}));
      for (const item of payload?.query?.search || []) {
        add("Wikipedia: " + item.title, "https://" + language + ".wikipedia.org/wiki/" + encodeURIComponent(String(item.title).replace(/ /g, "_")));
        if (results.length >= limit) break;
      }
    } catch {
      // A single reference provider must not prevent the remaining providers from working.
    }
  }
  if (results.length >= limit) return results.slice(0, limit);
  try {
    const response = await fetch("https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&site=stackoverflow&pagesize=5&q=" + encodeURIComponent(term), {
      headers: { "User-Agent": "NetronLabsResearch/1.0 (+https://netron.net.tr)" }
    });
    const payload = await response.json().catch(() => ({}));
    for (const item of payload?.items || []) {
      add("Stack Overflow: " + decodeHtml(item.title), String(item.link || ""));
      if (results.length >= limit) break;
    }
  } catch {
    // Reference search is best-effort and still returns any sources already found.
  }
  return results.slice(0, limit);
}

async function searchWeb(query, limit) {
  const term = String(query || "").trim().slice(0, 280);
  if (!term) return [];
  try {
    const response = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(term), {
      headers: { "User-Agent": "NetronLabsResearch/1.0 (+https://netron.net.tr)" }
    });
    if (!response.ok) return searchReferenceSources(term, limit);
    const html = await response.text();
    const results = [];
    const pattern = /<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = pattern.exec(html)) && results.length < limit) {
      let url = decodeHtml(match[1]);
      try {
        const parsed = new URL(url, "https://duckduckgo.com");
        url = parsed.searchParams.get("uddg") || parsed.href;
        url = decodeURIComponent(url);
      } catch { continue; }
      if (!/^https?:\/\//i.test(url) || /duckduckgo\.com/i.test(url)) continue;
      const title = decodeHtml(match[2]);
      if (title && !results.some((item) => item.url === url)) results.push({ title, url });
    }
    return results.length ? results : searchReferenceSources(term, limit);
  } catch {
    return searchReferenceSources(term, limit);
  }
}

function researchContext(mode, sources) {
  if (!sources.length) return "Web kaynagi su an alinamadi. Kaynak varmis gibi davranma.";
  const list = sources.map((source, index) => "[" + (index + 1) + "] " + source.title + ": " + source.url).join("\n");
  const depth = mode === "deep" ? "Karsilastirma, belirsizlikler ve sonuc bolumleriyle ayrintili bir arastirma raporu yaz." : mode === "agent" ? "Arastirma bulgularina dayanarak uygulanabilir plan, riskler ve sonraki adimlari yaz." : "Kaynaklari kisa ve dogru bicimde ozetle.";
  return depth + " Sadece asagidaki kaynaklara dayan; kullandigin iddialarda [numara] ile atif yap.\n\nKAYNAKLAR:\n" + list;
}


function imageDimensions(aspectRatio) {
  if (aspectRatio === "16:9") return { width: 1024, height: 576 };
  if (aspectRatio === "9:16") return { width: 576, height: 1024 };
  return { width: 768, height: 768 };
}

function dataUriFromBuffer(buffer, contentType = "image/jpeg") {
  return "data:" + contentType + ";base64," + Buffer.from(buffer).toString("base64");
}

async function requestCloudflareImage(body) {
  const workerUrl = String(process.env.CLOUDFLARE_IMAGE_WORKER_URL || "").trim();
  const token = String(process.env.CLOUDFLARE_IMAGE_WORKER_TOKEN || "").trim();
  if (!workerUrl || !token) return null;
  try {
    const response = await fetch(workerUrl, {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: String(body.prompt || "").trim().slice(0, 1800),
        aspect_ratio: String(body.aspect_ratio || "1:1")
      })
    });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null);
    const image = payload?.image || payload?.dataURI;
    return image ? {
      image,
      provider: "cloudflare-workers-ai",
      model: payload.model || "@cf/black-forest-labs/flux-1-schnell"
    } : null;
  } catch {
    return null;
  }
}

async function requestPollinationsImage(body) {
  const prompt = String(body.prompt || "").trim().slice(0, 1800);
  if (!prompt) return null;
  const size = imageDimensions(String(body.aspect_ratio || "1:1"));
  const url = "https://image.pollinations.ai/prompt/" + encodeURIComponent(prompt)
    + "?width=" + size.width + "&height=" + size.height + "&nologo=true&seed=" + Math.floor(Math.random() * 2147483647);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "NetronLabsImage/1.0 (+https://netron.net.tr)" }
    });
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") || "image/jpeg";
    if (!contentType.startsWith("image/")) return null;
    const buffer = await response.arrayBuffer();
    if (!buffer.byteLength) return null;
    return {
      image: dataUriFromBuffer(buffer, contentType),
      provider: "pollinations",
      model: "pollinations-flux"
    };
  } catch {
    return null;
  }
}

module.exports = async (req, res) => {
  if (!setCors(req, res)) return res.status(403).json({ error: "Bu origin icin erisim yok." });
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!allow(req)) return res.status(429).json({ error: "Cok fazla istek gonderildi. Bir dakika sonra tekrar dene." });

  const path = route(req);
  const hasGroq = Boolean(String(process.env.GROQ_API_KEY || "").trim());
  const hasCerebras = Boolean(String(process.env.CEREBRAS_API_KEY || "").trim());
  const hasCloudflareImage = Boolean(String(process.env.CLOUDFLARE_IMAGE_WORKER_URL || "").trim() && String(process.env.CLOUDFLARE_IMAGE_WORKER_TOKEN || "").trim());
  if (req.method === "GET" && path === "/health") return res.status(200).json({ ok: true, service: "netron-node-api", fallback: hasCerebras ? "cerebras" : null, imageProvider: hasCloudflareImage ? "cloudflare-workers-ai" : "pollinations" });
  if (req.method === "GET" && path === "/catalog") return res.status(200).json({
    configured: hasGroq || hasCerebras,
    models: {
      text: Object.entries(MODELS).map(([id, base]) => ({ id, base, label: id })),
      image: [
        { id: "netron-image-1.0", label: "Netron Image 1.0 - Hızlı", base: "@cf/black-forest-labs/flux-1-schnell" },
        { id: "netron-image-1.5", label: "Netron Image 1.5 - Kaliteli", base: "@cf/black-forest-labs/flux-1-schnell" },
        { id: "netron-image-xl", label: "Netron Image XL - Yüksek Kalite", base: "@cf/black-forest-labs/flux-1-schnell" }
      ],
      video: []
    },
    services: {
      text: { configured: hasGroq || hasCerebras, provider: hasGroq ? "groq" : "cerebras", fallbackConfigured: hasCerebras },
      image: { configured: true, provider: hasCloudflareImage ? "cloudflare-workers-ai" : "pollinations", fallbackConfigured: true },
      video: { configured: false }
    }
  });
  if (req.method === "GET" && path === "/search") {
    const query = String(req.query?.q || "");
    return res.status(200).json({ query, sources: await searchWeb(query, 8) });
  }

  if (req.method === "POST" && path === "/image") {
    const body = req.body || {};
    if (!String(body.prompt || "").trim()) return res.status(400).json({ error: "Gorsel promptu gerekli." });
    const image = await requestCloudflareImage(body) || await requestPollinationsImage(body);
    if (!image) return res.status(503).json({ error: "Gorsel saglayicilari su an yanit vermiyor." });
    return res.status(200).json({ output: image });
  }

  if (req.method !== "POST" || path !== "/chat") return res.status(404).json({ error: "API endpoint bulunamadi." });

  const body = req.body || {};
  const messages = Array.isArray(body.messages) ? body.messages.slice(-24).map((item) => ({
    role: item?.role === "assistant" ? "assistant" : "user",
    content: String(item?.content || "").slice(0, 14000)
  })).filter((item) => item.content.trim()) : [];
  if (!messages.length) return res.status(400).json({ error: "Bos mesaj gonderilemez." });
  const researchModes = new Set(["web", "agent", "deep"]);
  const sources = researchModes.has(body.mode) ? await searchWeb(messages[messages.length - 1]?.content || "", body.mode === "deep" ? 10 : 6) : [];
  const preparedMessages = sources.length || researchModes.has(body.mode) ? [{ role: "system", content: researchContext(body.mode, sources) }, ...messages] : messages;
  if (!hasGroq && !hasCerebras) return res.status(503).json({ error: "Netron API henuz yapilandirilmamis." });

  const fallback = async () => {
    const result = await requestCerebrasFallback(body, preparedMessages);
    return result ? res.status(200).json({ message: { role: "assistant", content: result.content }, provider: "cerebras", fallback: true, sources }) : null;
  };

  if (!hasGroq) {
    const response = await fallback();
    return response || res.status(503).json({ error: "Yedek Netron sunucusu yanit vermiyor." });
  }

  try {
    const upstream = await fetch(GROQ_URL, {
      method: "POST",
      headers: { Authorization: "Bearer " + process.env.GROQ_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODELS[body.model] || MODELS["netron-1.0"],
        messages: [{ role: "system", content: systemPrompt(body.mode) }, ...preparedMessages],
        temperature: 0.7,
        max_completion_tokens: COMPLETION_LIMITS[body.model] || COMPLETION_LIMITS["netron-1.0"]
      })
    });
    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      const response = await fallback();
      if (response) return response;
      if (upstream.status === 429) return res.status(429).json({ error: "Netron sunucusu kisa sureli yogun. Yaklasik 20 saniye sonra tekrar dene.", retryAfter: 20 });
      return res.status(upstream.status).json({ error: payload?.error?.message || "Groq istegi basarisiz." });
    }
    const content = payload?.choices?.[0]?.message?.content;
    if (!content) return res.status(502).json({ error: "Yapay zeka metin donmedi." });
    return res.status(200).json({ message: { role: "assistant", content }, provider: "groq", sources });
  } catch (error) {
    const response = await fallback();
    return response || res.status(502).json({ error: String(error.message || "Sunucu hatasi.") });
  }
};
