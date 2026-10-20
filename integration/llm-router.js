/**
 * LLM Router — главный модуль маршрутизации.
 *
 * Стратегия:
 * 1. Сначала пробуем Ollama (локальный сервер, лучшее качество, ноль утечек).
 * 2. Если Ollama недоступна — переключаемся на WebLLM (модель в браузере).
 * 3. Если недоступны обе — показываем ошибку с инструкцией.
 *
 * Все вызовы ИИ в приложении идут через этот модуль.
 *
 * KB-100 / Кадастр.Помощник
 */

import ollama from './ollama-client.js';
import webllm from './webllm-client.js';
import { SYSTEM_PROMPT, buildPrompt } from './system-prompt.js';
import { KadastrTools } from './kadastr-tools.js';
import { KnowledgeBase } from './knowledge-base.js';

const PROVIDER_KEY = 'kadastr.llm.provider';
const AUTO_FALLBACK = true; // автофолбэк Ollama → WebLLM

class LLMRouter {
  constructor() {
    this.provider = null; // 'ollama' | 'webllm' | null
    this.tools = new KadastrTools();
    this.kb = new KnowledgeBase();
    this.initialized = false;
  }

  /**
   * Инициализация: загрузка нормативки в IndexedDB, выбор провайдера.
   * Вызывается один раз при старте приложения.
   */
  async init() {
    if (this.initialized) return;

    // Загружаем базу знаний (ФЗ-218, П/0082) в IndexedDB
    await this.kb.init();

    // Определяем доступного провайдера
    const saved = localStorage.getItem(PROVIDER_KEY);
    if (saved === 'ollama' || saved === 'webllm') {
      this.provider = saved;
    } else {
      this.provider = await this._detectProvider();
      localStorage.setItem(PROVIDER_KEY, this.provider || '');
    }

    this.initialized = true;
    return this.provider;
  }

  /**
   * Автоопределение: сначала Ollama (она мощнее), потом WebLLM.
   * Возвращает строку 'ollama' | 'webllm' | null.
   */
  async _detectProvider() {
    if (AUTO_FALLBACK) {
      if (await ollama.ping()) return 'ollama';
      if (await webllm.ping()) return 'webllm';
    } else {
      const saved = localStorage.getItem(PROVIDER_KEY);
      if (saved) return saved;
    }
    return null;
  }

  /**
   * Принудительно сменить провайдера (для UI настроек).
   */
  async setProvider(name) {
    if (!['ollama', 'webllm'].includes(name)) {
      throw new Error(`Неизвестный провайдер: ${name}`);
    }
    this.provider = name;
    localStorage.setItem(PROVIDER_KEY, name);
    if (name === 'webllm' && !webllm.loaded) {
      await webllm.loadModel();
    }
  }

  /**
   * Получить текущего клиента.
   */
  _client() {
    if (this.provider === 'ollama') return ollama;
    if (this.provider === 'webllm') return webllm;
    return null;
  }

  /**
   * Главный метод чата с RAG + function calling.
   *
   * @param {Object} params
   * @param {string} params.userMessage — вопрос пользователя
   * @param {Object} [params.context] — {objectCard, xmlContent, documentText}
   * @param {Array} [params.history] — история диалога
   * @param {Function} [params.onToken] — стриминг токенов
   * @returns {Promise<{content, reasoning, toolResults, provider, citations}>}
   */
  async chat({ userMessage, context = {}, history = [], onToken }) {
    if (!this.initialized) await this.init();
    if (!this.provider) {
      throw this._noProviderError();
    }

    // 1. RAG: ищем релевантные статьи законов
    const citations = await this.kb.search(userMessage, 3);

    // 2. Строим системный промпт с контекстом объекта и найденными статьями
    const systemContent = buildPrompt({
      role: 'assistant',
      context,
      citations,
    });

    // 3. Формируем сообщения
    const messages = [
      { role: 'system', content: systemContent },
      ...history.slice(-6).map((m) => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content,
      })),
      { role: 'user', content: userMessage },
    ];

    // 4. Первый вызов — с инструментами (function calling)
    const tools = this.tools.getSchema();
    let response;
    try {
      response = await this._client().chatWithTools({ messages, tools });
    } catch (e) {
      // Если tools не сработали — повторяем без них
      response = await this._client().chat({ messages, onToken });
      return {
        content: response.content,
        reasoning: response.reasoning,
        toolResults: [],
        provider: this.provider,
        citations,
      };
    }

    // 5. Если модель вызвала инструмент — выполняем и продолжаем диалог
    const toolResults = [];
    if (response.tool_calls && response.tool_calls.length > 0) {
      messages.push({
        role: 'assistant',
        content: response.reasoning || '',
        tool_calls: response.tool_calls,
      });

      for (const call of response.tool_calls) {
        const toolName = call.function.name;
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch (e) {
          args = {};
        }
        const result = await this.tools.execute(toolName, args);
        toolResults.push({ tool: toolName, args, result });
        messages.push({
          role: 'tool',
          name: toolName,
          content: JSON.stringify(result, null, 2),
        });
      }

      // Финальный вызов с результатами инструментов
      const finalResp = await this._client().chat({ messages, onToken });
      return {
        content: finalResp.content,
        reasoning: finalResp.reasoning,
        toolResults,
        provider: this.provider,
        citations,
      };
    }

    // 6. Обычный ответ без инструментов
    if (onToken && response.content) {
      onToken(response.content, false);
    }
    return {
      content: response.content,
      reasoning: response.reasoning,
      toolResults: [],
      provider: this.provider,
      citations,
    };
  }

  /**
   * Анализ XML техплана — специализированный режим.
   * Загружает XML, парсит структуру, передаёт модели для сверки с П/0082.
   *
   * @param {string} xmlContent — содержимое XML техплана
   * @param {Function} [onToken]
   * @returns {Promise<{remarks: Array, summary: string}>}
   */
  async analyzeTechPlan(xmlContent, onToken) {
    if (!this.initialized) await this.init();
    if (!this.provider) throw this._noProviderError();

    // Локальный структурный парсинг (без ИИ — для базовой проверки)
    const structuralCheck = await this.tools.execute('parse_techplan_xml', {
      xml: xmlContent,
    });

    // ИИ-анализ: даём модели структуру + релевантные пункты П/0082
    const p0082Citations = await this.kb.searchByDoc('p-0082', 'технический план требования состав структура', 5);

    const messages = [
      {
        role: 'system',
        content: buildPrompt({
          role: 'techplan_analyzer',
          context: { structuralCheck, citations: p0082Citations },
        }),
      },
      {
        role: 'user',
        content:
          'Проанализируй техплан и сформируй перечень замечаний по П/0082.\n\n' +
          'СТРУКТУРА ТЕХПЛАНА:\n' +
          JSON.stringify(structuralCheck, null, 2) +
          '\n\nЗамечания оформи списком в формате:\n' +
          '1. [КРИТИЧНО/ВАЖНО/ИНФО] Описание проблемы — ссылка на пункт П/0082',
      },
    ];

    const response = await this._client().chat({ messages, onToken });

    return {
      remarks: this._parseRemarks(response.content),
      summary: response.content,
      reasoning: response.reasoning,
      structuralCheck,
      provider: this.provider,
      citations: p0082Citations,
    };
  }

  /**
   * Сгенерировать чек-лист документов для объекта.
   */
  async generateDocumentChecklist(objectCard, onToken) {
    if (!this.initialized) await this.init();
    if (!this.provider) throw this._noProviderError();

    const citations = await this.kb.search(
      `документы для кадастрового учёта ${objectCard.objectType || ''} ${objectCard.purpose || ''}`,
      3
    );

    const messages = [
      {
        role: 'system',
        content: buildPrompt({ role: 'checklist_generator', context: { objectCard, citations } }),
      },
      {
        role: 'user',
        content:
          'Сформируй чек-лист документов для кадастрового учёта объекта.\n' +
          'Карточка объекта:\n' +
          JSON.stringify(objectCard, null, 2),
      },
    ];

    const response = await this._client().chat({ messages, onToken });
    return {
      checklist: this._parseChecklist(response.content),
      summary: response.content,
      provider: this.provider,
      citations,
    };
  }

  /**
   * Парсинг «1. [КРИТИЧНО] ...» в структурированный список замечаний.
   */
  _parseRemarks(text) {
    const remarks = [];
    const lines = text.split('\n');
    let counter = 0;
    for (const line of lines) {
      const m = line.match(/^\s*(\d+)[\.\)]\s*\[?(КРИТИЧНО|ВАЖНО|ИНФО)\]?\s*(.+?)(?:\s*—\s*(.+))?$/i);
      if (m) {
        remarks.push({
          n: ++counter,
          severity: (m[2] || 'ИНФО').toUpperCase(),
          text: m[3].trim(),
          reference: m[4]?.trim() || '',
        });
      }
    }
    return remarks;
  }

  _parseChecklist(text) {
    const items = [];
    const lines = text.split('\n');
    let group = 'Общие';
    for (const line of lines) {
      const g = line.match(/^##\s*(.+)$/);
      if (g) {
        group = g[1].trim();
        continue;
      }
      const item = line.match(/^\s*[-*]\s*\[( |x)\]\s*(.+)$/i);
      if (item) {
        items.push({
          group,
          text: item[2].trim(),
          required: item[1].toLowerCase() === 'x',
        });
      }
    }
    return items;
  }

  _noProviderError() {
    const err = new Error(
      'Не найден локальный ИИ-движок. Установите Ollama (https://ollama.com) ' +
        'и загрузите модель `ollama pull deepseek-r1:14b`, ' +
        'либо откройте сайт в Chrome 113+ для WebLLM.'
    );
    err.code = 'NO_PROVIDER';
    return err;
  }

  /**
   * Статус провайдеров для UI настроек.
   */
  async getStatus() {
    const [ollamaOk, webllmOk] = await Promise.all([
      ollama.ping(),
      webllm.ping(),
    ]);
    return {
      current: this.provider,
      ollama: {
        available: ollamaOk,
        url: ollama.baseUrl,
        model: ollama.model,
        models: ollamaOk ? await ollama.listModels() : [],
      },
      webllm: {
        available: webllmOk,
        model: webllm.modelId,
        loaded: webllm.loaded,
        progress: webllm.loadingProgress,
      },
      kb: {
        loaded: this.kb.loaded,
        documents: this.kb.stats?.documents || 0,
        chunks: this.kb.stats?.chunks || 0,
      },
    };
  }
}

window.LLMRouter = new LLMRouter();
export default window.LLMRouter;
