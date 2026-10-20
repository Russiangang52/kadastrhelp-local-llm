/**
 * Knowledge Base — локальная векторная база нормативных документов в IndexedDB.
 *
 * Хранит фрагменты ФЗ-218, ФЗ-221, приказа П/0082 прямо в браузере.
 * Поиск — простой TF-IDF + BM25 (без внешних эмбеддингов, чтобы не зависеть от сети).
 * Для серьёзной семантики можно подключить transformers.js, но для юридических
 * текстов обычный полнотекстовый поиск работает хорошо благодаря точной терминологии.
 *
 * KB-100 / Кадастр.Помощник
 */

const DB_NAME = 'kadastr_kb';
const DB_VERSION = 1;
const STORE_CHUNKS = 'chunks';
const STORE_META = 'meta';

class KnowledgeBase {
  constructor() {
    this.db = null;
    this.loaded = false;
    this.stats = { documents: 0, chunks: 0 };
  }

  /**
   * Инициализация: открыть IndexedDB, при первом запуске — загрузить данные.
   */
  async init() {
    if (this.loaded) return;

    this.db = await this._openDB();
    const metaCount = await this._count(STORE_META);
    if (metaCount === 0) {
      await this._loadDefaults();
    }
    this.stats.documents = await this._count(STORE_META);
    this.stats.chunks = await this._count(STORE_CHUNKS);
    this.loaded = true;
  }

  async _openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_CHUNKS)) {
          const store = db.createObjectStore(STORE_CHUNKS, { keyPath: 'id' });
          store.createIndex('docId', 'docId', { unique: false });
          store.createIndex('location', 'location', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'docId' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async _count(store) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, 'readonly');
      const req = tx.objectStore(store).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Загрузка фрагментов из встроенных JSON (файлы в /data/).
   * Запускается один раз при первом открытии приложения.
   */
  async _loadDefaults() {
    const docs = [
      { docId: 'fz-218', url: './data/fz-218.json', title: 'ФЗ-218 «О государственной регистрации недвижимости»' },
      { docId: 'fz-221', url: './data/fz-221.json', title: 'ФЗ-221 «О кадастровой деятельности»' },
      { docId: 'p-0082', url: './data/p-0082.json', title: 'Приказ Росреестра от 15.03.2022 № П/0082' },
    ];

    for (const doc of docs) {
      try {
        const resp = await fetch(doc.url);
        if (!resp.ok) {
          console.warn(`Не удалось загрузить ${doc.url}: ${resp.status}`);
          continue;
        }
        const data = await resp.json();
        await this._addDocument(doc.docId, doc.title, data.chunks || []);
      } catch (e) {
        console.warn(`Ошибка загрузки ${doc.docId}:`, e.message);
      }
    }
  }

  /**
   * Добавить документ в базу (с чанками).
   *
   * @param {string} docId — 'fz-218', 'p-0082' и т.д.
   * @param {string} title — название документа
   * @param {Array} chunks — [{location, text, keywords}]
   */
  async _addDocument(docId, title, chunks) {
    const tx = this.db.transaction([STORE_META, STORE_CHUNKS], 'readwrite');
    tx.objectStore(STORE_META).put({
      docId,
      title,
      chunkCount: chunks.length,
      added: Date.now(),
    });
    const chunksStore = tx.objectStore(STORE_CHUNKS);
    chunks.forEach((chunk, i) => {
      chunksStore.put({
        id: `${docId}#${i}`,
        docId,
        docTitle: title,
        location: chunk.location || `ч. ${i + 1}`,
        text: chunk.text,
        keywords: chunk.keywords || [],
        tokens: this._tokenize(chunk.text + ' ' + (chunk.keywords || []).join(' ')),
      });
    });
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Поиск фрагментов по запросу. Используется BM25-подобный рейтинг.
   *
   * @param {string} query — поисковый запрос
   * @param {number} limit — сколько результатов вернуть (по умолчанию 5)
   * @param {Object} [filter] — {document: 'fz-218'} для фильтра по одному документу
   * @returns {Promise<Array<{docId, docTitle, location, text, score}>>}
   */
  async search(query, limit = 5, filter = {}) {
    if (!this.loaded) await this.init();
    const queryTokens = this._tokenize(query);
    if (queryTokens.length === 0) return [];

    // Загружаем все чанки (для серьёзной БД можно оптимизировать, но
    // для 200-500 чанков в IndexedDB — быстро)
    const allChunks = await this._getAllChunks(filter.document);
    const N = allChunks.length;
    if (N === 0) return [];

    // IDF по всем документам
    const df = {};
    queryTokens.forEach((t) => (df[t] = 0));
    allChunks.forEach((chunk) => {
      queryTokens.forEach((t) => {
        if (chunk.tokens.includes(t)) df[t]++;
      });
    });

    // BM25
    const k1 = 1.5;
    const b = 0.75;
    const avgDl =
      allChunks.reduce((s, c) => s + c.tokens.length, 0) / Math.max(N, 1);

    const scored = allChunks.map((chunk) => {
      let score = 0;
      queryTokens.forEach((t) => {
        if (df[t] === 0) return;
        const tf = chunk.tokens.filter((x) => x === t).length;
        const idf = Math.log((N - df[t] + 0.5) / (df[t] + 0.5) + 1);
        const dl = chunk.tokens.length;
        score +=
          idf *
          ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (dl / avgDl))));
      });
      return { ...chunk, score };
    });

    return scored
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((c) => ({
        docId: c.docId,
        docTitle: c.docTitle,
        location: c.location,
        text: c.text,
        score: c.score,
      }));
  }

  /**
   * Поиск внутри одного документа.
   */
  async searchByDoc(docId, query, limit = 5) {
    return this.search(query, limit, { document: docId });
  }

  async _getAllChunks(filterDoc) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_CHUNKS, 'readonly');
      const store = tx.objectStore(STORE_CHUNKS);
      const req = store.getAll();
      req.onsuccess = () => {
        let result = req.result || [];
        if (filterDoc) result = result.filter((c) => c.docId === filterDoc);
        resolve(result);
      };
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Токенизация: нижний регистр, удаление пунктуации, стоп-слова.
   * Для русского юридического текста — простой нормализованный токенайзер.
   */
  _tokenize(text) {
    if (!text) return [];
    return text
      .toLowerCase()
      .replace(/[«»"'.!?,;:()\[\]{}]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
  }

  /**
   * Добавить свой документ (например, методичку организации).
   */
  async addCustomDocument(docId, title, chunks) {
    if (!this.loaded) await this.init();
    await this._addDocument(docId, title, chunks);
    this.stats.documents = await this._count(STORE_META);
    this.stats.chunks = await this._count(STORE_CHUNKS);
  }

  /**
   * Очистить базу (для отладки).
   */
  async clear() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([STORE_META, STORE_CHUNKS], 'readwrite');
      tx.objectStore(STORE_META).clear();
      tx.objectStore(STORE_CHUNKS).clear();
      tx.oncomplete = () => {
        this.stats = { documents: 0, chunks: 0 };
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  }
}

// Минимальный набор стоп-слов русского языка
const STOP_WORDS = new Set([
  'и', 'в', 'во', 'не', 'что', 'он', 'на', 'я', 'с', 'со', 'как', 'а', 'то',
  'все', 'она', 'так', 'его', 'но', 'да', 'ты', 'к', 'у', 'же', 'вы', 'за',
  'бы', 'по', 'только', 'ее', 'мне', 'было', 'вот', 'от', 'меня', 'есть',
  'о', 'из', 'ему', 'теперь', 'когда', 'даже', 'ну', 'вдруг', 'ли', 'если',
  'уже', 'или', 'ни', 'быть', 'был', 'него', 'до', 'вас', 'нибудь', 'опять',
  'уж', 'вам', 'ведь', 'там', 'потом', 'себя', 'ничего', 'ей', 'может', 'они',
  'тут', 'где', 'есть', 'надо', 'ней', 'для', 'мы', 'тебя', 'их', 'чем',
  'была', 'сам', 'чтоб', 'без', 'будто', 'чего', 'раз', 'тоже', 'себе', 'под',
  'будет', 'ж', 'тогда', 'кто', 'этот', 'того', 'потому', 'этого', 'какой',
  'совсем', 'ним', 'здесь', 'этом', 'один', 'почти', 'мой', 'тем', 'чтобы',
  'нее', 'сейчас', 'были', 'куда', 'зачем', 'всех', 'никогда', 'можно', 'при',
  'наконец', 'два', 'об', 'другой', 'хоть', 'после', 'над', 'больше', 'тот',
  'через', 'эти', 'нас', 'про', 'всего', 'них', 'какая', 'много', 'разве',
  'три', 'эту', 'моя', 'впрочем', 'хорошо', 'свою', 'этой', 'перед', 'иногда',
  'лучше', 'чуть', 'том', 'нельзя', 'такой', 'им', 'более', 'всегда', 'конечно',
  'всю', 'между',
]);

window.KnowledgeBase = KnowledgeBase;
export { KnowledgeBase };
