(function(root) {
function createChatHistory(context) {
function makeSessionId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    const bytes = window.crypto.getRandomValues(new Uint8Array(8));
    return `session-${Date.now()}-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  }

function ensureSessionId() {
    if (!context.currentSessionId) {
      context.currentSessionId = makeSessionId();
      localStorage.setItem(context.SESSION_STORAGE_KEY, context.currentSessionId);
    }
    return context.currentSessionId;
  }

function renderBubbleContent(div, text, artifact) {
    const displayText = artifact ? text.replace(artifact.matchedText, '').trim() : text;
    div.innerHTML = window.electronAPI.renderMarkdownToSafeHtml(displayText);

    if (artifact) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chat-artifact-open';
      button.textContent = `Open ${artifact.language} content in new window`;
      button.addEventListener('click', () => {
        const thread = context.sessionArtifacts.filter((a) => a.threadId === artifact.threadId);
        window.electronAPI.openArtifact({ thread, index: thread.indexOf(artifact) });
      });
      div.appendChild(button);
    }
  }

function appendMessage(role, text) {
    if (!context.messagesEl || !text) return null;
    const div = document.createElement('div');
    div.className = 'message ' + (role === 'user' ? 'system' : 'assistant');
    const rawArtifact = window.electronAPI.extractArtifact(text);
    let artifact = null;
    if (rawArtifact) {
      artifact = window.electronAPI.assignArtifactVersion(rawArtifact, context.sessionArtifacts);
      context.sessionArtifacts.push(artifact);
    }
    renderBubbleContent(div, text, artifact);
    context.messagesEl.appendChild(div);
    context.messagesEl.scrollTop = context.messagesEl.scrollHeight;
    return div;
  }

function prependTurns(turns) {
    if (!context.messagesEl || !turns || !turns.length) return;

    // Pass 1: extract raw artifacts for the whole page and thread them
    // against each other only (see this section's header comment).
    const rawByTurn = turns.map((turn) => ({
      user: turn.user ? window.electronAPI.extractArtifact(turn.user) : null,
      assistant: turn.assistant ? window.electronAPI.extractArtifact(turn.assistant) : null,
    }));
    const pageArtifacts = [];
    for (const raw of rawByTurn) {
      if (raw.user) {
        raw.userVersioned = window.electronAPI.assignArtifactVersion(raw.user, pageArtifacts);
        pageArtifacts.push(raw.userVersioned);
      }
      if (raw.assistant) {
        raw.assistantVersioned = window.electronAPI.assignArtifactVersion(raw.assistant, pageArtifacts);
        pageArtifacts.push(raw.assistantVersioned);
      }
    }
    context.sessionArtifacts = [...pageArtifacts, ...context.sessionArtifacts];

    // Pass 2: build the DOM using each turn's already-versioned artifact.
    const frag = document.createDocumentFragment();
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      const raw = rawByTurn[i];
      if (turn.user) {
        const u = document.createElement('div');
        u.className = 'message system';
        renderBubbleContent(u, turn.user, raw.userVersioned || null);
        frag.appendChild(u);
      }
      if (turn.assistant) {
        const a = document.createElement('div');
        a.className = 'message assistant';
        renderBubbleContent(a, turn.assistant, raw.assistantVersioned || null);
        frag.appendChild(a);
      }
    }
    const anchor = context.historyLoadingEl?.nextSibling || null;
    context.messagesEl.insertBefore(frag, anchor);
  }

function clearMessages() {
    context.messagesEl?.querySelectorAll('.message').forEach((el) => el.remove());
    context.nextBeforeCursor = null;
    context.hasMoreHistory = false;
    context.sessionArtifacts = [];
  }

async function fetchHistoryPage(sessionId, before) {
    const params = new URLSearchParams({ limit: '20' });
    if (before !== undefined && before !== null) params.set('before', String(before));
    const resp = await fetch(`${context.SESSIONS_API}/sessions/${encodeURIComponent(sessionId)}/turns?${params}`);
    if (!resp.ok) return null;
    return resp.json();
  }

async function loadInitialHistory(sessionId) {
    const page = await fetchHistoryPage(sessionId);
    if (!page) return;
    prependTurns(page.turns);
    context.hasMoreHistory = page.hasMore;
    context.nextBeforeCursor = page.nextBefore;
    context.messagesEl.scrollTop = context.messagesEl.scrollHeight;
  }

async function loadOlderMessages() {
    if (context.loadingHistory || !context.hasMoreHistory || !context.currentSessionId || !context.messagesEl) return;
    context.loadingHistory = true;
    if (context.historyLoadingEl) context.historyLoadingEl.hidden = false;
    const previousScrollHeight = context.messagesEl.scrollHeight;
    try {
      const page = await fetchHistoryPage(context.currentSessionId, context.nextBeforeCursor);
      if (page) {
        prependTurns(page.turns);
        context.hasMoreHistory = page.hasMore;
        context.nextBeforeCursor = page.nextBefore;
        context.messagesEl.scrollTop = context.messagesEl.scrollHeight - previousScrollHeight + context.messagesEl.scrollTop;
      }
    } finally {
      context.loadingHistory = false;
      if (context.historyLoadingEl) context.historyLoadingEl.hidden = true;
    }
  }

async function switchToSession(sessionId) {
    context.currentSessionId = sessionId;
    localStorage.setItem(context.SESSION_STORAGE_KEY, sessionId);
    clearMessages();
    context.showView('home');
    await loadInitialHistory(sessionId);
    refreshSessionList();
  }

function startNewChat() {
    context.currentSessionId = makeSessionId();
    localStorage.setItem(context.SESSION_STORAGE_KEY, context.currentSessionId);
    clearMessages();
    if (context.messageInputEl) context.messageInputEl.value = '';
    context.showView('home');
  }

function formatSessionDate(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch (e) {
      return '';
    }
  }

function beginInlineRename(sessionId, currentName) {
    const item = context.sessionListEl?.querySelector(`[data-session-id="${context.CSS.escape(sessionId)}"]`);
    if (!item) return;
    const nameEl = item.querySelector('.session-name');
    const input = document.createElement('input');
    input.className = 'session-name-input';
    input.value = currentName || sessionId;
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    let settled = false;
    async function commit() {
      if (settled) return;
      settled = true;
      const newName = input.value.trim();
      if (newName && newName !== currentName) {
        try {
          await fetch(`${context.SESSIONS_API}/sessions/${encodeURIComponent(sessionId)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName }),
          });
        } catch (e) {
          console.warn('Failed to rename session:', e);
        }
      }
      refreshSessionList();
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        settled = true;
        refreshSessionList();
      }
    });
    input.addEventListener('blur', commit);
  }

function renderSessionList(sessions) {
    if (!context.sessionListEl) return;
    context.sessionListEl.innerHTML = '';
    if (!sessions.length) {
      context.sessionListEl.innerHTML = '<p class="subtitle">No saved sessions yet -- start chatting to create one.</p>';
      return;
    }
    for (const session of sessions) {
      const item = document.createElement('div');
      item.className = 'session-item' + (session.sessionId === context.currentSessionId ? ' active' : '');
      item.dataset.sessionId = session.sessionId;

      const nameEl = document.createElement('div');
      nameEl.className = 'session-name';
      nameEl.textContent = session.name || session.sessionId;

      const metaEl = document.createElement('div');
      metaEl.className = 'session-meta';
      metaEl.textContent = formatSessionDate(session.updatedAt);

      const renameBtn = document.createElement('button');
      renameBtn.className = 'session-rename-btn';
      renameBtn.title = 'Rename';
      renameBtn.type = 'button';
      renameBtn.textContent = '✎';
      renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        beginInlineRename(session.sessionId, session.name);
      });

      item.appendChild(nameEl);
      item.appendChild(metaEl);
      item.appendChild(renameBtn);

      // Issue #362: was a plain div with only a click listener -- not in
      // the tab order and not activatable from the keyboard.
      item.tabIndex = 0;
      item.setAttribute('role', 'button');
      item.setAttribute('aria-label', `Session: ${session.name || session.sessionId}`);
      const activate = () => {
        if (session.sessionId !== context.currentSessionId) switchToSession(session.sessionId);
      };
      item.addEventListener('click', activate);
      item.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          activate();
        }
      });
      context.sessionListEl.appendChild(item);
    }
  }

async function refreshSessionList() {
    if (!context.sessionListEl) return;
    try {
      const resp = await fetch(`${context.SESSIONS_API}/sessions`);
      const j = await resp.json();
      renderSessionList(Array.isArray(j.sessions) ? j.sessions : []);
    } catch (e) {
      context.sessionListEl.innerHTML = `<p class="subtitle">Failed to load sessions: ${String(e.message || e)}</p>`;
    }
  }

  return { makeSessionId, ensureSessionId, renderBubbleContent, appendMessage, prependTurns, clearMessages, fetchHistoryPage, loadInitialHistory, loadOlderMessages, switchToSession, startNewChat, formatSessionDate, beginInlineRename, renderSessionList, refreshSessionList };
}

const api = { createChatHistory };
if (typeof module === 'object' && module.exports) module.exports = api;
else root.ManaChatHistory = api;
})(typeof window === 'undefined' ? globalThis : window);
