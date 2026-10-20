// Локальная база: читает data/*.json (формат гибкий) и ищет по BM25. Всё в памяти, без сети.
const FILES = [["fz-218", "ФЗ-218"], ["fz-221", "ФЗ-221"], ["p-0082", "Приказ П/0082"]];
const tok = (s) => (String(s).toLowerCase().match(/[a-zа-яё0-9]+/g) || []).filter((w) => w.length > 2).map((w) => w.slice(0, 6));

function normalize(json, id, title) {
  const arr = Array.isArray(json) ? json
    : json.chunks || json.fragments || json.items || json.articles || json.sections || [];
  title = json.title || json.name || title;
  return arr.map((c, i) => {
    const text = typeof c === "string" ? c : c.text || c.content || c.body || c.fragment || "";
    const location = typeof c === "string" ? `фрагмент ${i + 1}`
      : c.location || c.ref || c.reference || c.article || c.point || c.title || c.id || `фрагмент ${i + 1}`;
    return { doc: id, docTitle: title, location: String(location), text: String(text) };
  }).filter((c) => c.text);
}

const kb = {
  chunks: [], idx: [], df: new Map(), avg: 1, loaded: false, docs: 0,
  async init() {
    this.chunks = []; this.docs = 0;
    for (const [id, title] of FILES) {
      try {
        const r = await fetch(`data/${id}.json`);
        if (!r.ok) continue;
        const c = normalize(await r.json(), id, title);
        if (c.length) { this.chunks.push(...c); this.docs++; }
      } catch (e) { console.warn("KB: не загружен", id, e); }
    }
    this.idx = this.chunks.map((c) => tok(c.text + " " + c.location));
    this.df = new Map();
    this.idx.forEach((t) => new Set(t).forEach((w) => this.df.set(w, (this.df.get(w) || 0) + 1)));
    this.avg = this.idx.reduce((a, t) => a + t.length, 0) / (this.idx.length || 1);
    this.loaded = this.chunks.length > 0;
  },
  stats() { return { loaded: this.loaded, documents: this.docs, chunks: this.chunks.length }; },
  search(query, k = 5, opts = {}) {
    const q = tok(query), N = this.chunks.length, out = [];
    this.chunks.forEach((c, i) => {
      if (opts.document && opts.document !== "all" && c.doc !== opts.document) return;
      const t = this.idx[i]; let s = 0;
      for (const w of new Set(q)) {
        const f = t.filter((x) => x === w).length; if (!f) continue;
        const n = this.df.get(w) || 0, idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        s += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * t.length / this.avg));
      }
      if (s > 0) out.push({ ...c, score: s });
    });
    return out.sort((a, b) => b.score - a.score).slice(0, k);
  },
  async clear() { this.chunks = []; this.idx = []; this.loaded = false; this.docs = 0; },
};
export default kb;
