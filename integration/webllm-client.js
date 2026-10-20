/**
 * WebLLM Client — модель прямо в браузере через WebGPU.
 * Резервный вариант когда Ollama не установлена.
 *
 * Установка: не требуется — модель сама скачивается в Cache Storage браузера
 * при первом запуске (~4-9 ГБ, один раз).
 *
 * Требования: Chrome 113+ / Edge 113+, включённый WebGPU (по умолчанию).
 *
 * Зависимость:  npm install @mlc-ai/web-llm
 * Импорт через CDN: см. внизу файла.
 *
 * KB-100 / Кадастр.Помощник
 */

// Модель по умолчанию — DeepSeek-R1-Distill-Qwen-7B (мощная reasoning-модель,
// влезает в 8 ГБ VRAM при q4f16 квантовании). Для слабого железа переключите на
// "DeepSeek-R1-Distill-Qwen-1.5B-q4f16_1-MLC".
const WEBLLM_MODEL_ID =
  localStorage.getItem('kadastr.webllm.model') ||
  'DeepSeek-R1-Distill-Qwen-7B-q4f16_1-MLC';

class WebLLMClient {
  constructor() {
    this.engine = null;
    this.modelId = WEBLLM_MODEL_ID;
    this.loaded = false;
    this.loadingProgress = 0;
    this.available = null;
  }

  /**
   * Проверка — поддерживает ли браузер WebGPU.
   */
  async ping() {
    if (this.available !== null) return this.available;
    try {
      if (!('gpu' in navigator)) {
        this.available = false;
        return false;
      }
      const adapter = await navigator.gpu.requestAdapter();
      this.available = !!adapter;
      return this.available;
    } catch (e) {
      this.available = false;
      return false;
    }
  }

  /**
   * Загрузка модели (один раз, далее берётся из кэша).
   * @param {Function} [onProgress] — (progress: 0..1, stage: string)
   */
  async loadModel(onProgress) {
    if (this.loaded) return;
    if (!window.webllm) {
      throw new Error('web-llm библиотека не загружена. Подключите CDN скрипт.');
    }
    const { CreateMLCEngine } = window.webllm;

    this.engine = await CreateMLCEngine(this.modelId, {
      initProgressCallback: ({ progress, text }) => {
        this.loadingProgress = progress;
        if (onProgress) onProgress(progress, text);
      },
    });
    this.loaded = true;
  }

  /**
   * Чат с моделью. Поддержка streaming.
   */
  async chat({ messages, onToken, options = {} }) {
    if (!this.loaded) {
      await this.loadModel();
    }

    const chunks = [];
    const stream = await this.engine.chat.completions.create({
      messages,
      stream: true,
      temperature: options.temperature ?? 0.3,
      top_p: options.top_p ?? 0.9,
      max_tokens: options.max_tokens ?? 2048,
    });

    let fullText = '';
    let reasoning = '';

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content || '';
      if (!delta) continue;

      // DeepSeek R1 distill возвращает reasoning в <think>...</think>
      const parts = this._splitReasoning(delta);
      if (parts.reasoning && onToken) onToken(parts.reasoning, true);
      if (parts.content && onToken) onToken(parts.content, false);
      reasoning += parts.reasoning;
      fullText += parts.content;
    }

    return {
      content: fullText.trim(),
      reasoning: reasoning.trim(),
      model: this.modelId,
      provider: 'webllm',
    };
  }

  /**
   * Function calling в WebLLM эмулируем через JSON-вывод (модель не поддерживает tools нативно).
   * Лучшая практика: дать модели системный промпт с описанием инструментов и
   * требовать ответ в виде JSON.
   */
  async chatWithTools({ messages, tools }) {
    const toolSchema = tools
      .map(
        (t) =>
          `- ${t.function.name}: ${t.function.description}. Аргументы: ${JSON.stringify(
            t.function.parameters?.properties || {}
          )}`
      )
      .join('\n');

    const systemMsg = {
      role: 'system',
      content:
        'Если для ответа нужен инструмент, верни ТОЛЬКО JSON в формате: ' +
        '{"tool":"имя","args":{...}} без пояснений.\n' +
        'Доступные инструменты:\n' + toolSchema,
    };

    const result = await this.chat({
      messages: [systemMsg, ...messages],
      options: { temperature: 0.1 },
    });

    let toolCalls = [];
    try {
      const trimmed = result.content
        .replace(/^```json\s*/i, '')
        .replace(/```\s*$/, '')
        .trim();
      const parsed = JSON.parse(trimmed);
      if (parsed.tool) {
        toolCalls = [
          {
            function: { name: parsed.tool, arguments: JSON.stringify(parsed.args || {}) },
          },
        ];
      }
    } catch (e) {
      // модель не вызвала инструмент — это норма
    }

    return {
      content: result.content,
      reasoning: result.reasoning,
      tool_calls: toolCalls,
      model: this.modelId,
      provider: 'webllm',
    };
  }

  _splitReasoning(text) {
    if (!text) return { reasoning: '', content: '' };
    const openIdx = text.indexOf('<think>');
    const closeIdx = text.indexOf('</think>');
    if (openIdx === -1 && closeIdx === -1) {
      return { reasoning: '', content: text };
    }
    if (openIdx !== -1 && closeIdx === -1) {
      return { reasoning: text.slice(openIdx + 7), content: '' };
    }
    if (openIdx !== -1 && closeIdx !== -1) {
      return {
        reasoning: text.slice(openIdx + 7, closeIdx),
        content: text.slice(closeIdx + 8),
      };
    }
    return { reasoning: '', content: text.replace(/<\/think>/g, '') };
  }

  setModel(modelId) {
    this.modelId = modelId;
    localStorage.setItem('kadastr.webllm.model', modelId);
    this.loaded = false;
  }

  async unload() {
    if (this.engine) {
      await this.engine.unload();
      this.loaded = false;
    }
  }
}

// CDN-импорт web-llm — для статичного сайта на GitHub Pages
// Подключается в HTML: <script type="module" src="https://esm.run/@mlc-ai/web-llm"></script>
// Либо динамически:
(async () => {
  if (!window.webllm) {
    try {
      const mod = await import('https://esm.run/@mlc-ai/web-llm');
      window.webllm = mod;
    } catch (e) {
      console.warn('WebLLM недоступен:', e.message);
    }
  }
})();

window.WebLLMClient = new WebLLMClient();
export default window.WebLLMClient;
