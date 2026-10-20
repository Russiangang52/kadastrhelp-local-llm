// WebLLM: модель работает в браузере на GPU пользователя. Данные никуда не отправляются.
// Библиотека: сначала локальная копия vendor/web-llm.js, затем CDN (зафиксированная версия).
const LIBS = ["../vendor/web-llm.js", "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.79/+esm"];
let lib, engine, loadedModel = null;

async function getLib() {
  if (lib) return lib;
  for (const u of LIBS) {
    try { lib = await import(u); return lib; } catch (e) { console.warn("WebLLM lib:", u, e); }
  }
  throw new Error("Не удалось загрузить библиотеку WebLLM (нужен интернет при первом запуске).");
}

const client = {
  model: localStorage.getItem("kadastr.model") || "Qwen2.5-3B-Instruct-q4f16_1-MLC",
  get loaded() { return !!engine && loadedModel === this.model; },
  hasWebGPU() { return !!navigator.gpu; },
  setModel(m) { this.model = m; localStorage.setItem("kadastr.model", m); },
  async load(onProgress) {
    if (!this.hasWebGPU()) {
      throw Object.assign(new Error("WebGPU недоступен. Нужен Chrome/Edge 113+ и видеокарта с поддержкой WebGPU."), { code: "NO_PROVIDER" });
    }
    if (this.loaded) return;
    const w = await getLib();
    try { await engine?.unload(); } catch (_) {}
    engine = await w.CreateMLCEngine(this.model, { initProgressCallback: onProgress });
    loadedModel = this.model;
  },
  async chat(messages, { onToken, temperature = 0.2, max_tokens = 1200 } = {}) {
    await this.load();
    const stream = await engine.chat.completions.create({ messages, stream: true, temperature, max_tokens });
    let out = "";
    for await (const c of stream) {
      const t = c.choices[0]?.delta?.content || "";
      if (t) { out += t; onToken?.(t, false); }
    }
    return out;
  },
  async clearCache() {
    const w = await getLib();
    await w.deleteModelAllInfoInCache?.(this.model);
    try { await engine?.unload(); } catch (_) {}
    engine = null; loadedModel = null;
  },
};
export default client;
