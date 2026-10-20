import kb from "./knowledge-base.js";
import wl from "./webllm-client.js";

const SYSTEM = `Ты — помощник кадастрового инженера в России. Отвечай по-русски, кратко и по делу.
Опирайся ТОЛЬКО на приведённые ИСТОЧНИКИ и ссылайся на них как [1], [2]. Если в источниках ответа нет — так и скажи и посоветуй сверить с первоисточником. Никогда не выдумывай номера статей, пунктов и сроки.`;
const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);
const src = (h) => (h.length ? h.map((x, i) => `[${i + 1}] ${x.docTitle}, ${x.location}: ${clip(x.text, 600)}`).join("\n")
  : "(в базе нет подходящих фрагментов)");

function parseTechPlan(xml) {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (doc.querySelector("parsererror")) return { error: "XML не разобран: файл повреждён или это не XML" };
  const all = [...doc.getElementsByTagName("*")];
  const get = (...n) => { for (const x of n) { const e = all.find((a) => a.localName.toLowerCase() === x.toLowerCase());
    if (e && e.textContent.trim()) return e.textContent.trim().replace(/\s+/g, " "); } return ""; };
  const r = {
    cadastralNumber: get("CadastralNumber", "Cadastral_Number"),
    objectType: get("ObjectType", "TypeRealty", "Object"),
    address: get("Readable_Address", "Address", "Location"),
    area: get("Area", "AreaValue"),
    purpose: get("Purpose", "Assignation_Name", "Assignation"),
    cadastralEngineer: get("FIO", "FullName", "Fio"),
    cadastralEngineerRegistration: get("NCertificate", "CertificateNumber", "RegistrationNumber"),
    date: get("DateCreate", "Date", "Date_Prepared"),
    attachments: [...new Set(all.filter((a) => /appendix|attachment/i.test(a.localName)).map((a) => clip(a.textContent.trim().replace(/\s+/g, " "), 60)).filter(Boolean))].slice(0, 8),
  };
  const labels = { cadastralNumber: "Кадастровый номер", objectType: "Тип объекта", address: "Адрес", area: "Площадь",
    cadastralEngineer: "Кадастровый инженер", cadastralEngineerRegistration: "Рег. № инженера", date: "Дата техплана" };
  r.missingFields = Object.keys(labels).filter((k) => !r[k]).map((k) => labels[k]);
  r.completeness = r.missingFields.length ? "incomplete" : "complete";
  return r;
}

function parseRemarks(text, start) {
  const out = [];
  for (const line of text.split("\n")) {
    const m = line.match(/(КРИТИЧНО|ВАЖНО|ИНФО)\s*[|:—–-]\s*(.+)/i);
    if (!m) continue;
    const [t, ref] = m[2].split("|").map((s) => s.trim());
    out.push({ n: start + out.length + 1, severity: m[1].toUpperCase(), text: t, reference: ref || "" });
  }
  return out;
}

function parseChecklist(text) {
  let group = "Документы"; const items = [];
  for (let l of text.split("\n")) {
    l = l.trim(); if (!l) continue;
    if (/^#+\s*/.test(l) || (/:\**$/.test(l) && !/^([-•*]|\d+[.)])\s/.test(l))) { group = l.replace(/^#+\s*/, "").replace(/[:*]/g, "").trim(); continue; }
    const m = l.match(/^(?:[-•*]|\d+[.)])\s*(.+)$/);
    if (m) items.push({ group, text: m[1].replace(/\*\*/g, "").replace(/\((?:обяз|по ситуации)[^)]*\)/i, "").trim(), required: /обяз/i.test(m[1]) });
  }
  return items;
}

const router = {
  kb, onProgress: null,
  async init() { await kb.init(); },
  async setProvider() {},
  setModel(m) { wl.setModel(m); },
  get model() { return wl.model; },
  deleteModel() { return wl.clearCache(); },
  async ensureLoaded() { await wl.load((r) => router.onProgress?.(r)); },
  async getStatus() {
    return { current: wl.hasWebGPU() ? "webllm" : null, ollama: {}, kb: kb.stats(),
      webllm: { model: wl.model, note: wl.loaded ? wl.model.split("-").slice(0, 3).join("-") : "модель не загружена", webgpu: wl.hasWebGPU() } };
  },
  async run(messages, onToken) { await this.ensureLoaded(); return wl.chat(messages, { onToken }); },

  async chat({ userMessage, context, history, onToken }) {
    const hits = kb.search(userMessage, 4);
    const card = context?.objectCard ? `\nКарточка объекта: ${JSON.stringify(context.objectCard)}` : "";
    const hist = (history || []).slice(0, -1).slice(-6).map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: clip(m.content || "", 800) }));
    const content = await this.run([{ role: "system", content: SYSTEM }, ...hist,
      { role: "user", content: `ИСТОЧНИКИ:\n${src(hits)}${card}\n\nВОПРОС: ${userMessage}` }], onToken);
    return { content, reasoning: "", provider: "webllm", citations: hits, toolResults: [] };
  },

  async analyzeTechPlan(xml, onToken) {
    const sc = parseTechPlan(xml);
    if (sc.error) return { structuralCheck: sc, remarks: [], summary: "", provider: "", citations: [] };
    const remarks = sc.missingFields.map((f, i) => ({ n: i + 1, severity: "КРИТИЧНО", text: `Не найдено поле: ${f}`, reference: "проверка без ИИ" }));
    if (sc.cadastralNumber && !/^\d{2}:\d{2}:\d{6,7}:\d{1,4}$/.test(sc.cadastralNumber))
      remarks.push({ n: remarks.length + 1, severity: "ВАЖНО", text: `Кадастровый номер «${sc.cadastralNumber}» не соответствует формату AA:BB:CCCCCC:N`, reference: "проверка без ИИ" });
    const hits = kb.search(`требования технический план ${sc.objectType} ${sc.purpose}`, 4);
    const { attachments, missingFields, completeness, ...fields } = sc;
    const text = await this.run([{ role: "system", content: SYSTEM },
      { role: "user", content: `ИСТОЧНИКИ:\n${src(hits)}\n\nДанные из техплана: ${JSON.stringify({ ...fields, приложения: attachments })}\n\nНайди возможные несоответствия требованиям из источников. Каждое замечание — отдельной строкой строго в формате:\nКРИТИЧНО|ВАЖНО|ИНФО | текст замечания | ссылка на источник [n]\nЕсли замечаний нет, напиши «Замечаний по данным нет». В конце одной строкой напомни, что нужна ручная проверка.` }], onToken);
    remarks.push(...parseRemarks(text, remarks.length));
    return { structuralCheck: sc, remarks, summary: text, provider: "webllm", citations: hits };
  },

  async generateDocumentChecklist(card) {
    const hits = kb.search(`документы кадастровый учёт ${card.objectType || ""} ${card.purpose || ""}`, 4);
    const text = await this.run([{ role: "system", content: SYSTEM },
      { role: "user", content: `ИСТОЧНИКИ:\n${src(hits)}\n\nКарточка объекта: ${JSON.stringify(card)}\n\nСоставь чек-лист документов. Группы — отдельными строками с двоеточием (правоустанавливающие, технические, удостоверяющие личность), пункты — через «- », в конце пункта (обязательно) или (по ситуации).` }]);
    return { checklist: parseChecklist(text), summary: text };
  },
};
export default router;
