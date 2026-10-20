/**
 * Kadastr Tools — function calling инструменты для ИИ-ассистента.
 *
 * Модель может вызывать эти функции во время ответа. Каждый инструмент —
 * это точное действие (как у живого инженера): проверить формат КН,
 * найти статью в законе, сформулировать замечание по шаблону.
 *
 * KB-100 / Кадастр.Помощник
 */

import { KnowledgeBase } from './knowledge-base.js';

const kb = new KnowledgeBase();

const TOOLS = {
  /**
   * Проверка формата кадастрового номера (20-значный формат Росреестра).
   */
  validate_cadastral_number: {
    description:
      'Проверяет формат кадастрового номера. Формат: AA:BB:CCCCCC:NNN, где AA — субъект РФ, BB — муниципалитет, CCCCCC — квартал, NNN — номер объекта.',
    parameters: {
      type: 'object',
      properties: {
        number: { type: 'string', description: 'Кадастровый номер для проверки' },
      },
      required: ['number'],
    },
    handler: ({ number }) => {
      const cleaned = (number || '').trim().replace(/\s/g, '');
      const regex = /^(\d{2}):(\d{2}):(\d{6,7}):(\d{1,4})$/;
      const m = cleaned.match(regex);
      if (!m) {
        return {
          valid: false,
          error: 'Неверный формат. Ожидается AA:BB:CCCCCC:NNN (например: 77:01:0001001:123)',
          input: number,
        };
      }
      const [_, region, district, quarter, object] = m;
      const regions = {
        '77': 'г. Москва',
        '50': 'Московская область',
        '78': 'г. Санкт-Петербург',
        '47': 'Ленинградская область',
        // ... остальные регионы РФ
      };
      return {
        valid: true,
        parsed: { region, district, quarter, object },
        regionTitle: regions[region] || `субъект РФ ${region}`,
      };
    },
  },

  /**
   * Поиск по нормативной базе (ФЗ-218, ФЗ-221, П/0082).
   */
  search_legal_reference: {
    description:
      'Ищет в базе нормативных документов (ФЗ-218, ФЗ-221, приказ П/0082) фрагменты по теме. Возвращает список релевантных пунктов с цитатами.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Поисковый запрос (например, «состав технического плана»)' },
        document: {
          type: 'string',
          enum: ['fz-218', 'fz-221', 'p-0082', 'all'],
          description: 'Фильтр по документу',
        },
        limit: { type: 'number', description: 'Лимит результатов (по умолчанию 5)' },
      },
      required: ['query'],
    },
    handler: async ({ query, document = 'all', limit = 5 }) => {
      await kb.init();
      const results = await kb.search(query, limit, { document });
      return { results, total: results.length };
    },
  },

  /**
   * Парсинг XML техплана — структурная проверка без ИИ.
   */
  parse_techplan_xml: {
    description:
      'Парсит XML технического плана и возвращает структурированное представление: кадастровый номер, тип объекта, характеристики, приложения.',
    parameters: {
      type: 'object',
      properties: {
        xml: { type: 'string', description: 'Содержимое XML техплана' },
      },
      required: ['xml'],
    },
    handler: ({ xml }) => parseTechPlanXML(xml),
  },

  /**
   * Генерация шаблона замечания по типу.
   */
  generate_remark_template: {
    description:
      'Возвращает шаблон формулировки замечания по заданному типу (например, «отсутствует чертёж», «несоответствие площади»).',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: [
            'missing_drawing',
            'area_mismatch',
            'address_error',
            'missing_document',
            'invalid_cadastral_number',
            'coordinate_error',
            'wrong_purpose',
            'general',
          ],
          description: 'Тип замечания',
        },
      },
      required: ['type'],
    },
    handler: ({ type }) => {
      const templates = {
        missing_drawing:
          'Отсутствует графическая часть технического плана (чертёж контура объекта). ' +
          'Согласно п. 16 П/0082, чертёж обязателен. Приложите графический файл в формате PDF.',
        area_mismatch:
          'Площадь объекта в разделе «Характеристики» (XXX кв. м) не соответствует площади, ' +
          'указанной в чертеже (YYY кв. м). Устраните несоответствие (п. 21 П/0082).',
        address_error:
          'Адрес объекта указан не в соответствии с ФИАС. Проверьте структуру адреса и ' +
          'идентификатор ФИАС (п. 13 П/0082, ч. 2 ст. 8 ФЗ-218).',
        missing_document:
          'В составе приложений отсутствует [НАЗВАНИЕ_ДОКУМЕНТА]. Документ обязателен ' +
          'для кадастрового учёта данного типа объекта (см. п. 20 П/0082).',
        invalid_cadastral_number:
          'Кадастровый номер не соответствует формату AA:BB:CCCCCC:NNN. ' +
          'Проверьте номер в выписке ЕГРН (приказ Росреестра № П/0392 от 24.11.2021).',
        coordinate_error:
          'Координаты характерных точек контура указаны с превышением точности. ' +
          'Для земельных участков точность должна соответствовать п. 6 Требований к точности (приказ Минэка № П/0272).',
        wrong_purpose:
          'Вид (назначение) объекта указан с нарушением классификатора (приказ Росреестра № П/0112). ' +
          'Укажите вид в соответствии с актуальным классификатором.',
        general:
          'Выявлено несоответствие требованиям П/0082. Уточните раздел и пункт приказа, ' +
          'устраните несоответствие, приложите обоснование.',
      };
      return { template: templates[type] || templates.general };
    },
  },

  /**
   * Подсказка по составу документов для типа объекта.
   */
  get_required_documents: {
    description:
      'Возвращает список обязательных документов для кадастрового учёта объекта заданного типа.',
    parameters: {
      type: 'object',
      properties: {
        objectType: {
          type: 'string',
          enum: ['land_plot', 'building', 'premise', 'construction', 'unfinished'],
          description: 'Тип объекта',
        },
        action: {
          type: 'string',
          enum: ['create', 'modify', 'remove'],
          description: 'Вид кадастрового действия',
        },
      },
      required: ['objectType', 'action'],
    },
    handler: ({ objectType, action }) => getRequiredDocs(objectType, action),
  },
};

function getRequiredDocs(objectType, action) {
  const base = {
    land_plot: [
      'Технический план (XML + графическая часть)',
      'Правоустанавливающий документ на участок',
      'Кадастровый паспорт (при изменении)',
      'Межевой план (если ранее границы не установлены)',
      'Копия документа о категории земель и виде разрешённого использования',
    ],
    building: [
      'Технический план здания (XML + графическая часть)',
      'Правоустанавливающий документ на земельный участок',
      'Разрешение на ввод в эксплуатацию (для ОКС)',
      'Проектная документация (для линейных объектов)',
      'Копия акта о результатах кадастровых работ',
    ],
    premise: [
      'Технический план помещения (XML + графическая часть)',
      'Правоустанавливающий документ на помещение',
      'Поэтажный план здания',
      'Документ о разделе/объединении (если применимо)',
    ],
    construction: [
      'Технический план сооружения (XML + графическая часть)',
      'Правоустанавливающий документ на ЗУ',
      'Проектная документация',
      'Разрешение на ввод в эксплуатацию (если применимо)',
    ],
    unfinished: [
      'Технический план объекта незавершённого строительства',
      'Правоустанавливающий документ на ЗУ',
      'Проектная документация',
      'Документ, подтверждающий степень готовности',
    ],
  };
  return {
    documents: base[objectType] || [],
    note: action === 'modify'
      ? 'При изменении дополнительно приложите документы, обосновывающие изменения.'
      : action === 'remove'
      ? 'При снятии с учёта приложите акт обследования (для ОКС) или акт согласования границ (для ЗУ).'
      : 'Документы подаются в электронной форме через Госуслуги или ПГУ Росреестра.',
  };
}

/**
 * Структурный парсинг XML техплана (без ИИ, для базовой проверки).
 */
function parseTechPlanXML(xml) {
  if (!xml || xml.trim().length === 0) {
    return { error: 'Пустой XML' };
  }
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');

    // Проверка на ошибки парсинга
    const parseError = doc.querySelector('parsererror');
    if (parseError) {
      return { error: 'XML невалиден: ' + parseError.textContent.slice(0, 200) };
    }

    // Извлекаем основные узлы техплана (схема П/0082)
    const extract = (xpath) => {
      const node = doc.evaluate(xpath, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return node?.singleNodeValue?.textContent?.trim() || null;
    };

    const extractAll = (xpath) => {
      const iter = doc.evaluate(xpath, doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const arr = [];
      for (let i = 0; i < iter.snapshotLength; i++) {
        arr.push(iter.snapshotItem(i).textContent.trim());
      }
      return arr;
    };

    const result = {
      valid: true,
      cadastralNumber: extract('//CadastralNumber/text()') || extract('//cadastralNumber/text()'),
      objectType: extract('//ObjectType/text()') || extract('//objectType/text()'),
      address: extract('//Address/text()') || extract('//Note/text()'),
      area: extract('//Area/text()') || extract('//area/text()'),
      purpose: extract('//Purpose/text()') || extract('//purpose/text()'),
      cadastralEngineer: extract('//CadastralEngineer/Surname/text()') + ' ' +
                         extract('//CadastralEngineer/First/text()'),
      cadastralEngineerRegistration: extract('//CadastralEngineer/NRegistration/text()'),
      date: extract('//Date1/text()'),
      attachments: extractAll('//AppliedFile/Name/text()'),
      appliedFiles: extractAll('//AppliedFile/@Name'),
    };

    // Проверки полноты
    const missing = [];
    if (!result.cadastralNumber) missing.push('Кадастровый номер');
    if (!result.objectType) missing.push('Тип объекта');
    if (!result.address) missing.push('Адрес');
    if (!result.area) missing.push('Площадь');
    if (!result.cadastralEngineer || result.cadastralEngineer.trim() === 'undefined')
      missing.push('ФИО кадастрового инженера');
    if (!result.cadastralEngineerRegistration) missing.push('Регистрационный номер инженера');
    if (!result.date) missing.push('Дата техплана');
    if (!result.attachments || result.attachments.length === 0)
      missing.push('Приложения (графическая часть)');

    result.missingFields = missing;
    result.completeness = missing.length === 0 ? 'complete' : 'incomplete';
    return result;
  } catch (e) {
    return { error: 'Ошибка парсинга: ' + e.message };
  }
}

/**
 * Класс инструментов — отдаёт схему для function calling и исполняет вызовы.
 */
export class KadastrTools {
  getSchema() {
    return Object.entries(TOOLS).map(([name, def]) => ({
      type: 'function',
      function: {
        name,
        description: def.description,
        parameters: def.parameters,
      },
    }));
  }

  async execute(name, args) {
    const tool = TOOLS[name];
    if (!tool) {
      return { error: `Неизвестный инструмент: ${name}` };
    }
    try {
      return await tool.handler(args);
    } catch (e) {
      return { error: e.message, tool: name, args };
    }
  }
}
