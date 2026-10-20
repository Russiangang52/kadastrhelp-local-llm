/**
 * Ollama Client — локальный клиент для DeepSeek R1 / Qwen2.5 через Ollama.
 * Данные НЕ покидают машину пользователя. Работает офлайн после установки Ollama.
 *
 * Установка Ollama:  https://ollama.com/download
 * Загрузка модели:   ollama pull deepseek-r1:14b
 *                    (или deepseek-r1:7b для слабого железа)
 * Запуск сервиса:    ollama serve  (по умолчанию http://localhost:11434)
 *
 * KB-100 / Кадастр.Помощник — локальная ИИ-интеграция
 */

const OLLAMA_URL = localStorage.getItem('kadastr.ollama.url') || 'http://localhost:11434';
const OLLAMA_MODEL = localStorage.getItem('kadastr.ollama.model') || 'deepseek-r1:14b';
const REQUEST_TIMEOUT_MS = 120000; // R1 «думает» долго — ставим 2 минуты

class OllamaClient {
  constructor() {
    this.baseUrl = OLLAMA_URL;
    this.model = OLLAMA_MODEL;
    this.available = null; // null = не проверено, true/false = состояние
  }

  /**
   * Проверка доступности Ollama на локальной машине.
   * Используется llm-router'ом для автофолбэка на WebLLM.
   */
  async ping() {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 2000);
      const resp = await fetch(`${this.baseUrl}/api/tags`, {
        signal: controller.signal,
      });
      clearTimeout(t);
      if (!resp.ok) return false;
      const data = await resp.json();
      this.available = (data.models || []).some(
        (m) => m.name === this.model || m.name.startsWith(this.model.split(':')[0])
      );
      return this.available;
    } catch (e) {
      this.available = false;
      return false;
    }
  }

  /**
   * Список установленных моделей — для UI выбора модели.
   */
  async listModels() {
    try {
      const resp = await fetch(`${this.baseUrl}/api/tags`);
      if (!resp.ok) return [];
      const data = await resp.json();
      return (data.models || []).map((m) => ({
        name: m.name,
        size: m.size,
        modified: m.modified_at,
      }));
    } catch (e) {
      return [];
    }
  }

  /**
   * Основной чат-вызов с поддержкой streaming.
   * DeepSeek R1 возвращает reasoning внутри <think>...</think>,
   * мы его парсим и убираем из финального ответа.
   *
   * @param {Object} params
   * @param {Array} params.messages — [{role, content}, ...]
   * @param {Function} [params.onToken] — колбэк для стриминга (token, isReasoning)
   * @param {Object} [params.options] — {temperature, top_p, num_ctx, ...}
   * @returns {Promise<{content: string, reasoning: string, raw: Object}>}
   */
  async chat({ messages, onToken, options = {} }) {
    const payload = {
      model: this.model,
      messages,
      stream: true,
      options: {
        temperature: 0.3, // для юридических задач — низкая температура
        top_p: 0.9,
        num_ctx: 16384,   // 16K контекст для R1
        ...options,
      },
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const resp = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!resp.ok) {
        throw new Error(`Ollama HTTP ${resp.status}: ${await resp.text()}`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullContent = '';
      let fullReasoning = '';

      // R1 стримит по строкам JSON с \n в конце
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const chunk = JSON.parse(line);
            const delta = chunk.message?.content || '';
            // Парсим блоки
            const parts = this._splitReasoning(delta);
            if (parts.reasoning && onToken) onToken(parts.reasoning, true);
            if (parts.content && onToken) onToken(parts.content, false);
            fullReasoning += parts.reasoning;
            fullContent += parts.content;
          } catch (e) {
            // частичный JSON — пропустим, дополним на следующей итерации
          }
        }
      }

      return {
        content: fullContent.trim(),
        reasoning: fullReasoning.trim(),
        model: this.model,
        provider: 'ollama',
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Вызов с поддержкой tools (function calling).
   * Для Ollama поддерживается через tool_calls в формате OpenAI-совместимом.
   *
   * @param {Array} messages
   * @param {Array} tools — схема инструментов в формате OpenAI
   * @returns {Promise<{content, tool_calls}>}
   */
  async chatWithTools({ messages, tools }) {
    const payload = {
      model: this.model,
      messages,
      tools,
      stream: false,
      options: { temperature: 0.2, num_ctx: 16384 },
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const resp = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error(`Ollama HTTP ${resp.status}`);
      const data = await resp.json();
      const parts = this._splitReasoning(data.message?.content || '');
      return {
        content: parts.content.trim(),
        reasoning: parts.reasoning.trim(),
        tool_calls: data.message?.tool_calls || [],
        model: this.model,
        provider: 'ollama',
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Разделяет reasoning-блок <think>...</think> от основного контента.
   * DeepSeek R1 всегда оборачивает рассуждения в <think>.
   */
  _splitReasoning(text) {
    if (!text) return { reasoning: '', content: '' };
    // Снимаем незакрытый <think> и накопленный reasoning
    const openIdx = text.indexOf('<think>');
    const closeIdx = text.indexOf('</think>');
    if (openIdx === -1 && closeIdx === -1) {
      return { reasoning: '', content: text };
    }
    if (openIdx !== -1 && closeIdx === -1) {
      // reasoning ещё не закрыт
      return {
        reasoning: text.slice(openIdx + 7),
        content: '',
      };
    }
    if (openIdx !== -1 && closeIdx !== -1) {
      const reasoning = text.slice(openIdx + 7, closeIdx);
      const content = text.slice(closeIdx + 8);
      return { reasoning, content };
    }
    // closeIdx есть, openIdx нет — артефакт
    return { reasoning: '', content: text.replace(/<\/think>/g, '') };
  }

  /**
   * Сменить модель (для UI настроек).
   */
  setModel(model) {
    this.model = model;
    localStorage.setItem('kadastr.ollama.model', model);
  }

  /**
   * Сменить URL (для удалённого сервера в LAN).
   */
  setUrl(url) {
    this.baseUrl = url.replace(/\/$/, '');
    localStorage.setItem('kadastr.ollama.url', this.baseUrl);
  }
}

// Экспорт как синглтон
window.OllamaClient = new OllamaClient();
export default window.OllamaClient;
