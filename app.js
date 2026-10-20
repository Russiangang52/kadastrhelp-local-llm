/**
 * KB-100 Кадастр.Помощник — основное приложение.
 *
 * Связывает UI с локальным ИИ через llm-router. Управляет вкладками,
 * состоянием карточки объекта, историей чата, поиском по нормативке.
 *
 * Все данные пользователя (история чата, карточка объекта, настройки)
 * сохраняются в localStorage. Внешние сетевые запросы отсутствуют.
 */

import router from './integration/llm-router.js';

window.kadastr = router;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Состояние приложения
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const state = {
  currentTab: 'chat',
  chatHistory: (localStorage.getItem('kadastr.settings') || '').includes('"saveHistory":true')
    ? JSON.parse(localStorage.getItem('kadastr.chat.history') || '[]') : [],
  objectCard: JSON.parse(localStorage.getItem('kadastr.object.card') || '{}'),
  settings: JSON.parse(localStorage.getItem('kadastr.settings') || '{"provider":"auto"}'),
  isProcessing: false,
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Инициализация
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function init() {
  // Загружаем чат из истории
  renderChatHistory();

  // Загружаем карточку объекта
  loadObjectCard();

  // Подключаем обработчики
  bindTabs();
  bindChat();
  bindTechplan();
  bindObjectCard();
  bindDocs();
  bindSettings();

  // Инициализируем ИИ-роутер
  router.onProgress = (r) => {
    const p = document.getElementById('status-provider');
    p.querySelector('.label').textContent = 'Загрузка модели ' + Math.round((r.progress || 0) * 100) + '%';
    p.className = 'status-pill warn';
  };
  await updateStatus();
  try {
    await router.init();
  } catch (e) {
    console.warn('Router init failed:', e);
  }
  await updateStatus();

  // Авто-обновление статуса раз в 30 секунд
  setInterval(updateStatus, 30000);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Статус-бар
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function updateStatus() {
  const providerEl = document.getElementById('status-provider');
  const kbEl = document.getElementById('status-kb');

  try {
    const status = await router.getStatus();
    const current = status.current;
    const providerLabel = {
      ollama: `Ollama · ${status.ollama.model || 'deepseek-r1'}`,
      webllm: `WebLLM · ${status.webllm.note}`,
      null: 'ИИ недоступен',
    };
    providerEl.querySelector('.label').textContent = providerLabel[current] || 'проверка…';
    providerEl.className = 'status-pill ' + (current ? 'ok' : 'err');

    if (status.kb.loaded) {
      kbEl.querySelector('.label').textContent =
        `База · ${status.kb.documents} док · ${status.kb.chunks} чанков`;
      kbEl.className = 'status-pill ok';
    } else {
      kbEl.querySelector('.label').textContent = 'База не загружена';
      kbEl.className = 'status-pill warn';
    }
  } catch (e) {
    providerEl.querySelector('.label').textContent = 'Ошибка инициализации';
    providerEl.className = 'status-pill err';
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Tabs
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function bindTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.onclick = () => {
      const tabId = tab.dataset.tab;
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('panel-' + tabId).classList.add('active');
      state.currentTab = tabId;
    };
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Chat
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function bindChat() {
  const input = document.getElementById('chat-input-field');
  const sendBtn = document.getElementById('btn-send');

  const send = () => {
    const text = input.value.trim();
    if (!text || state.isProcessing) return;
    input.value = '';
    askAI(text);
  };

  sendBtn.onclick = send;
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  // Пресеты
  document.querySelectorAll('.preset-btn').forEach((btn) => {
    btn.onclick = () => {
      input.value = btn.dataset.q;
      send();
    };
  });
}

async function askAI(question) {
  // Добавляем сообщение пользователя
  addMessage('user', question);
  state.chatHistory.push({ role: 'user', content: question, ts: Date.now() });
  saveChat();

  // Создаём плейсхолдер ответа
  const aiMsg = addMessage('ai', '');
  const aiContent = aiMsg.querySelector('.message-content');
  const aiText = aiMsg.querySelector('.message-text');
  aiText.innerHTML = '<span class="loading-text">модель думает</span>';
  state.isProcessing = true;
  document.getElementById('btn-send').disabled = true;

  const meta = document.getElementById('chat-meta');
  meta.textContent = '';

  // Контекст карточки объекта (если заполнена)
  const context = {
    objectCard: Object.keys(state.objectCard).length > 0 ? state.objectCard : null,
  };

  let reasoningEl = null;

  try {
    const response = await router.chat({
      userMessage: question,
      context,
      history: state.chatHistory.slice(-10),
      onToken: (token, isReasoning) => {
        if (isReasoning) {
          if (!reasoningEl) {
            reasoningEl = document.createElement('div');
            reasoningEl.className = 'message-reasoning';
            aiContent.insertBefore(reasoningEl, aiText);
          }
          reasoningEl.textContent += token;
          reasoningEl.scrollTop = reasoningEl.scrollHeight;
        } else {
          if (aiText.innerHTML.includes('loading-text')) {
            aiText.innerHTML = '';
          }
          aiText.innerHTML += escapeHtml(token).replace(/\n/g, '<br>');
        }
        scrollChatToBottom();
      },
    });

    // Заменяем HTML на финальный текст
    if (response.content) {
      aiText.innerHTML = formatMarkdown(response.content);
    } else {
      aiText.innerHTML = '<em>модель не дала ответа</em>';
    }

    // Метаинформация
    const metaParts = [];
    if (response.provider) metaParts.push('Провайдер: ' + response.provider);
    if (response.toolResults && response.toolResults.length > 0) {
      metaParts.push('Инструментов: ' + response.toolResults.length);
    }
    if (response.citations && response.citations.length > 0) {
      metaParts.push('Источников: ' + response.citations.length);
      // Добавляем источники под ответ
      const citEl = document.createElement('div');
      citEl.className = 'citations-list';
      citEl.style.marginTop = '8px';
      response.citations.forEach((c) => {
        citEl.innerHTML += `<div class="citation-item">
          <div class="citation-source">${c.docTitle} · ${c.location}</div>
          <div class="citation-text">${escapeHtml(c.text.slice(0, 200))}…</div>
        </div>`;
      });
      aiContent.appendChild(citEl);
    }
    meta.textContent = metaParts.join(' · ');

    // Сохраняем в историю
    state.chatHistory.push({
      role: 'assistant',
      content: response.content,
      reasoning: response.reasoning,
      ts: Date.now(),
      provider: response.provider,
    });
    saveChat();
  } catch (e) {
    aiText.innerHTML = `<span style="color:var(--error)">⚠ Ошибка:</span> ${escapeHtml(e.message)}`;
    if (e.code === 'NO_PROVIDER') {
      const hint = document.createElement('div');
      hint.style.marginTop = '8px';
      hint.style.fontSize = '12px';
      hint.style.color = 'var(--text-muted)';
      hint.innerHTML = '💡 Откройте <strong>Настройки</strong> (⚙) и загрузите модель. Нужен Chrome/Edge с WebGPU.';
      aiContent.appendChild(hint);
    }
  } finally {
    state.isProcessing = false;
    document.getElementById('btn-send').disabled = false;
    scrollChatToBottom();
  }
}

function addMessage(role, text) {
  const messages = document.getElementById('chat-messages');
  const msg = document.createElement('div');
  msg.className = 'message ' + (role === 'user' ? 'message-user' : 'message-ai');
  msg.innerHTML = `
    <div class="message-avatar">${role === 'user' ? 'Я' : 'КБ'}</div>
    <div class="message-content">
      <div class="message-text">${text ? formatMarkdown(text) : ''}</div>
    </div>
  `;
  messages.appendChild(msg);
  scrollChatToBottom();
  return msg;
}

function renderChatHistory() {
  const messages = document.getElementById('chat-messages');
  messages.innerHTML = '';
  if (state.chatHistory.length === 0) {
    addMessage('ai', 'Здравствуйте! Я — ваш кадастровый ассистент. Помогу с вопросами по ФЗ-218, ФЗ-221, приказу П/0082. Спросите меня о составе документов, требованиях к техплану или порядке кадастрового учёта.');
    return;
  }
  state.chatHistory.forEach((m) => {
    addMessage(m.role === 'user' ? 'user' : 'ai', m.content);
  });
}

function scrollChatToBottom() {
  const messages = document.getElementById('chat-messages');
  messages.scrollTop = messages.scrollHeight;
}

function saveChat() {
  // Сохраняем только последние 30 сообщений
  if (state.chatHistory.length > 30) {
    state.chatHistory = state.chatHistory.slice(-30);
  }
  if (state.settings.saveHistory) localStorage.setItem('kadastr.chat.history', JSON.stringify(state.chatHistory));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  TechPlan
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function bindTechplan() {
  const uploadZone = document.getElementById('upload-zone');
  const fileInput = document.getElementById('file-xml');
  const selectBtn = document.getElementById('btn-select-file');

  selectBtn.onclick = () => fileInput.click();
  uploadZone.onclick = () => fileInput.click();

  fileInput.onchange = (e) => {
    const file = e.target.files[0];
    if (file) handleTechplanFile(file);
  };

  // Drag & drop
  ['dragenter', 'dragover'].forEach((ev) => {
    uploadZone.addEventListener(ev, (e) => {
      e.preventDefault();
      uploadZone.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach((ev) => {
    uploadZone.addEventListener(ev, (e) => {
      e.preventDefault();
      uploadZone.classList.remove('dragover');
    });
  });
  uploadZone.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files[0];
    if (file && (file.name.endsWith('.xml') || file.type === 'text/xml')) {
      handleTechplanFile(file);
    } else {
      alert('Поддерживаются только XML файлы техпланов');
    }
  });
}

async function handleTechplanFile(file) {
  document.getElementById('upload-zone').style.display = 'none';
  const results = document.getElementById('techplan-results');
  results.style.display = 'block';

  document.getElementById('tp-filename').textContent = file.name;
  document.getElementById('tp-status').textContent = 'анализ…';
  document.getElementById('tp-status').className = 'badge';
  document.getElementById('tp-provider').textContent = '';

  // Показываем спиннер
  document.getElementById('tp-structural').innerHTML =
    '<div class="structural-item"><span class="value"><span class="loading-text">читаем файл</span></span></div>';
  document.getElementById('tp-remarks').innerHTML = '';
  document.getElementById('tp-ai-output').textContent = '';

  try {
    const xml = await file.text();
    const result = await router.analyzeTechPlan(xml, (token, isReasoning) => {
      const out = document.getElementById('tp-ai-output');
      if (isReasoning) {
        out.textContent += '[рассуждение] ' + token;
      } else {
        out.textContent += token;
      }
      out.scrollTop = out.scrollHeight;
    });

    // Структурная проверка
    renderStructural(result.structuralCheck);

    // Замечания
    renderRemarks(result.remarks);

    // AI-вывод
    document.getElementById('tp-ai-output').textContent = result.summary;

    // Статус
    const critical = result.remarks.filter((r) => r.severity === 'КРИТИЧНО').length;
    const statusEl = document.getElementById('tp-status');
    if (critical > 0) {
      statusEl.textContent = `${critical} критичных`;
      statusEl.className = 'badge err';
    } else if (result.remarks.length > 0) {
      statusEl.textContent = `${result.remarks.length} замечаний`;
      statusEl.className = 'badge warn';
    } else {
      statusEl.textContent = 'без замечаний';
      statusEl.className = 'badge ok';
    }
    document.getElementById('tp-provider').textContent = result.provider;

    // Источники
    if (result.citations && result.citations.length > 0) {
      document.getElementById('tp-citations-section').style.display = 'block';
      const cit = document.getElementById('tp-citations');
      cit.innerHTML = '';
      result.citations.forEach((c) => {
        const el = document.createElement('div');
        el.className = 'citation-item';
        el.innerHTML = `
          <div class="citation-source">${c.docTitle} · ${c.location}</div>
          <div class="citation-text">${escapeHtml(c.text.slice(0, 250))}…</div>
        `;
        cit.appendChild(el);
      });
    }
  } catch (e) {
    document.getElementById('tp-status').textContent = 'ошибка';
    document.getElementById('tp-status').className = 'badge err';
    document.getElementById('tp-ai-output').textContent =
      '⚠ ' + e.message;
  }
}

function renderStructural(check) {
  const grid = document.getElementById('tp-structural');
  grid.innerHTML = '';
  if (check.error) {
    grid.innerHTML = `<div class="structural-item missing">
      <span class="label">Ошибка</span>
      <span class="value">${escapeHtml(check.error)}</span>
    </div>`;
    return;
  }

  const fields = [
    { key: 'cadastralNumber', label: 'Кадастровый номер' },
    { key: 'objectType', label: 'Тип объекта' },
    { key: 'address', label: 'Адрес' },
    { key: 'area', label: 'Площадь' },
    { key: 'purpose', label: 'Назначение' },
    { key: 'cadastralEngineer', label: 'Кадастровый инженер' },
    { key: 'cadastralEngineerRegistration', label: 'Рег. № инженера' },
    { key: 'date', label: 'Дата техплана' },
    { key: 'attachments', label: 'Приложения' },
  ];

  fields.forEach((f) => {
    const value = check[f.key];
    const isMissing = check.missingFields && check.missingFields.some(
      (m) => m.toLowerCase().includes(f.label.toLowerCase().split(' ')[0])
    );
    const display = Array.isArray(value) ? value.join(', ') || '—' : (value || '—');
    const item = document.createElement('div');
    item.className = 'structural-item' + (!value || isMissing ? ' missing' : '');
    item.innerHTML = `
      <span class="label">${f.label}</span>
      <span class="value">${escapeHtml(display)}</span>
    `;
    grid.appendChild(item);
  });

  // Полнота
  const completeness = document.createElement('div');
  completeness.className = 'structural-item';
  completeness.innerHTML = `
    <span class="label">Полнота</span>
    <span class="value">${check.completeness === 'complete' ? '✓ Полный' : '⚠ ' + check.missingFields.length + ' отсутствует'}</span>
  `;
  grid.appendChild(completeness);
}

function renderRemarks(remarks) {
  const list = document.getElementById('tp-remarks');
  list.innerHTML = '';
  if (remarks.length === 0) {
    list.innerHTML = '<div class="remark-item info"><div class="remark-text">Замечаний не найдено. Рекомендуется ручная проверка.</div></div>';
    return;
  }
  remarks.forEach((r) => {
    const sev = r.severity.toLowerCase().includes('крит') ? 'critical' :
                r.severity.toLowerCase().includes('важ') ? 'important' : 'info';
    const item = document.createElement('div');
    item.className = 'remark-item ' + sev;
    item.innerHTML = `
      <div class="remark-header">
        <span class="remark-number">#${r.n}</span>
        <span class="remark-severity ${sev}">${r.severity}</span>
      </div>
      <div class="remark-text">${escapeHtml(r.text)}</div>
      ${r.reference ? `<div class="remark-ref">${escapeHtml(r.reference)}</div>` : ''}
    `;
    list.appendChild(item);
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Object card
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function bindObjectCard() {
  // Живая валидация кадастрового номера
  const cnInput = document.getElementById('obj-cadastral');
  cnInput.oninput = () => {
    const v = cnInput.value.trim();
    const hint = document.getElementById('cn-hint');
    if (!v) {
      hint.textContent = '';
      hint.className = 'field-hint';
      return;
    }
    const regex = /^(\d{2}):(\d{2}):(\d{6,7}):(\d{1,4})$/;
    if (v.match(regex)) {
      hint.textContent = '✓ Формат верный';
      hint.className = 'field-hint ok';
    } else {
      hint.textContent = '⚠ Формат: AA:BB:CCCCCC:NNN';
      hint.className = 'field-hint err';
    }
  };

  // Сохранение в state.objectCard по изменению полей
  document.querySelectorAll('[data-field]').forEach((el) => {
    el.oninput = () => {
      const field = el.dataset.field;
      state.objectCard[field] = el.value;
    };
  });

  document.getElementById('btn-save').onclick = () => {
    localStorage.setItem('kadastr.object.card', JSON.stringify(state.objectCard));
    showToast('Карточка сохранена в локальном хранилище');
  };

  document.getElementById('btn-export').onclick = () => {
    const blob = new Blob([JSON.stringify(state.objectCard, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `object-card-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Карточка экспортирована');
  };

  document.getElementById('btn-clear').onclick = () => {
    if (!confirm('Очистить карточку объекта?')) return;
    state.objectCard = {};
    localStorage.removeItem('kadastr.object.card');
    document.querySelectorAll('[data-field]').forEach((el) => { el.value = ''; });
    document.getElementById('cn-hint').textContent = '';
    document.getElementById('checklist-result').style.display = 'none';
    showToast('Карточка очищена');
  };

  document.getElementById('btn-checklist').onclick = async () => {
    if (state.isProcessing) return;
    state.isProcessing = true;
    const btn = document.getElementById('btn-checklist');
    btn.disabled = true;
    btn.textContent = 'Формирование…';

    const result = document.getElementById('checklist-result');
    const content = document.getElementById('checklist-content');
    result.style.display = 'block';
    content.innerHTML = '<span class="loading-text">модель формирует чек-лист</span>';

    try {
      const r = await router.generateDocumentChecklist(state.objectCard);
      content.innerHTML = '';
      if (r.checklist.length === 0) {
        content.innerHTML = '<p>' + escapeHtml(r.summary).replace(/\n/g, '<br>') + '</p>';
      } else {
        let lastGroup = '';
        r.checklist.forEach((item) => {
          if (item.group !== lastGroup) {
            const g = document.createElement('div');
            g.className = 'checklist-group-title';
            g.textContent = item.group;
            content.appendChild(g);
            lastGroup = item.group;
          }
          const it = document.createElement('div');
          it.className = 'checklist-item';
          it.textContent = item.text + (item.required ? ' (обязательно)' : ' (по ситуации)');
          content.appendChild(it);
        });
      }
    } catch (e) {
      content.innerHTML = `<p style="color:var(--error)">⚠ ${escapeHtml(e.message)}</p>`;
    } finally {
      state.isProcessing = false;
      btn.disabled = false;
      btn.textContent = 'Сформировать чек-лист документов';
    }
  };
}

function loadObjectCard() {
  document.querySelectorAll('[data-field]').forEach((el) => {
    const field = el.dataset.field;
    if (state.objectCard[field]) {
      el.value = state.objectCard[field];
    }
  });
  // Запустить валидацию КН, если есть
  if (state.objectCard.cadastralNumber) {
    document.getElementById('obj-cadastral').dispatchEvent(new Event('input'));
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Docs (search)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function bindDocs() {
  const input = document.getElementById('docs-search-input');
  const filter = document.getElementById('docs-filter');
  const btn = document.getElementById('btn-search-docs');

  const search = () => {
    const q = input.value.trim();
    if (!q) return;
    searchDocs(q, filter.value);
  };

  btn.onclick = search;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') search();
  };
}

async function searchDocs(query, docFilter) {
  const results = await router.kb.search(query, 10, { document: docFilter });
  const list = document.getElementById('docs-results');
  list.innerHTML = '';

  if (results.length === 0) {
    list.innerHTML = '<div class="doc-result"><div class="doc-text">Ничего не найдено. Попробуйте синонимы или измените запрос.</div></div>';
    return;
  }

  // Подсветка найденных слов
  const queryTokens = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);

  results.forEach((r) => {
    const el = document.createElement('div');
    el.className = 'doc-result';
    let text = r.text;
    queryTokens.forEach((t) => {
      const regex = new RegExp('(' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
      text = text.replace(regex, '<mark>$1</mark>');
    });
    el.innerHTML = `
      <div class="doc-header">
        <span class="doc-source">${r.docTitle}</span>
        <span class="doc-location">${r.location}</span>
      </div>
      <div class="doc-text">${text}</div>
    `;
    list.appendChild(el);
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Settings modal
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function bindSettings() {
  const modal = document.getElementById("modal-settings");
  document.getElementById("btn-settings").onclick = openSettings;
  document.getElementById("btn-close-modal").onclick = closeSettings;
  document.getElementById("btn-cancel-settings").onclick = closeSettings;
  document.getElementById("btn-save-settings").onclick = saveSettings;
  modal.onclick = (e) => { if (e.target === modal) closeSettings(); };
  document.getElementById("btn-load-model").onclick = async () => {
    router.setModel(document.getElementById("setting-model").value);
    try { await router.ensureLoaded(); showToast("Модель загружена"); } catch (e) { alert(e.message); }
    await updateStatus();
  };
  document.getElementById("btn-delete-model").onclick = async () => {
    if (!confirm("Удалить модель из кэша браузера? Для работы её придётся скачать заново.")) return;
    await router.deleteModel(); showToast("Модель удалена"); await updateStatus();
  };
  document.getElementById("btn-wipe").onclick = () => {
    if (!confirm("Стереть историю чата, карточку объекта и настройки на этом компьютере?")) return;
    Object.keys(localStorage).filter((k) => k.startsWith("kadastr.")).forEach((k) => localStorage.removeItem(k));
    location.reload();
  };
  document.getElementById("btn-clear-kb").onclick = clearKB;
  document.getElementById("btn-reload-kb").onclick = reloadKB;
}

async function openSettings() {
  document.getElementById("modal-settings").style.display = "flex";
  const st = await router.getStatus();
  document.getElementById("setting-model").value = router.model;
  document.getElementById("setting-save-history").checked = !!state.settings.saveHistory;
  document.getElementById("webgpu-note").textContent = st.webllm.webgpu
    ? "✓ WebGPU доступен" : "⚠ WebGPU недоступен: нужен Chrome/Edge 113+ и подходящая видеокарта";
  document.getElementById("kb-stats").textContent = st.kb.loaded
    ? `Документов: ${st.kb.documents}, фрагментов: ${st.kb.chunks}`
    : "База пуста: проверьте файлы data/fz-218.json, fz-221.json, p-0082.json";
}

function closeSettings() { document.getElementById("modal-settings").style.display = "none"; }

async function saveSettings() {
  router.setModel(document.getElementById("setting-model").value);
  state.settings = { provider: "webllm", saveHistory: document.getElementById("setting-save-history").checked };
  if (!state.settings.saveHistory) localStorage.removeItem("kadastr.chat.history");
  localStorage.setItem("kadastr.settings", JSON.stringify(state.settings));
  closeSettings();
  await updateStatus();
  showToast("Настройки сохранены. Модель загрузится при следующем запросе.");
}

async function clearKB() {
  if (!confirm('Очистить локальную базу знаний? Придётся перезагрузить страницу для восстановления.')) return;
  await router.kb.clear();
  showToast('База очищена');
  location.reload();
}

async function reloadKB() {
  if (!confirm('Перезагрузить базу знаний из файлов data/?')) return;
  await router.kb.clear();
  await router.kb.init();
  showToast('База перезагружена');
  await updateStatus();
  openSettings();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Utils
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatMarkdown(text) {
  if (!text) return '';
  let html = escapeHtml(text);
  // Жирный **text**
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Заголовки ## text
  html = html.replace(/^## (.+)$/gm, '<div style="font-weight:600;margin-top:8px">$1</div>');
  // Списки - text
  html = html.replace(/^- (.+)$/gm, '<div style="padding-left:16px">• $1</div>');
  // Переносы строк
  html = html.replace(/\n/g, '<br>');
  return html;
}

function showToast(message) {
  let toast = document.getElementById('app-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'app-toast';
    toast.style.cssText = `
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      background: var(--header-fill);
      color: white;
      padding: 12px 24px;
      border-radius: 6px;
      font-size: 13px;
      z-index: 2000;
      opacity: 0;
      transition: opacity 0.3s;
    `;
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.opacity = '1';
  setTimeout(() => { toast.style.opacity = '0'; }, 2500);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Start
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
