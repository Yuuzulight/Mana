(function(root) {
function createDesktopSettings(context) {
function setSelectedPresetId(presetId) {
    context.selectedPresetId = presetId || '';
    if (context.selectedPresetId) {
      localStorage.setItem(context.PRESET_STORAGE_KEY, context.selectedPresetId);
    } else {
      localStorage.removeItem(context.PRESET_STORAGE_KEY);
    }
    if (context.presetEditBtnEl) context.presetEditBtnEl.hidden = !context.selectedPresetId;
    if (context.presetDeleteBtnEl) context.presetDeleteBtnEl.hidden = !context.selectedPresetId;
  }

function renderPresetSelect(presets) {
    if (!context.presetSelectEl) return;
    context.presetSelectEl.innerHTML = '';
    const noneOption = document.createElement('option');
    noneOption.value = '';
    noneOption.textContent = 'None';
    context.presetSelectEl.appendChild(noneOption);
    for (const preset of presets) {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.name;
      context.presetSelectEl.appendChild(option);
    }
    const stillExists = presets.some((preset) => preset.id === context.selectedPresetId);
    context.presetSelectEl.value = stillExists ? context.selectedPresetId : '';
    setSelectedPresetId(context.presetSelectEl.value);
  }

async function refreshPresetList() {
    try {
      const resp = await fetch('http://127.0.0.1:5005/presets');
      if (!resp.ok) throw new Error(`Preset list returned ${resp.status}`);
      const result = await resp.json();
      context.latestPresets = result.presets || [];
      renderPresetSelect(context.latestPresets);
    } catch (e) {
      console.warn('Mana preset list failed:', e);
    }
  }

function closePresetEditor() {
    context.editingPresetId = null;
    if (context.presetEditorEl) context.presetEditorEl.hidden = true;
    if (context.presetNameInputEl) context.presetNameInputEl.value = '';
    if (context.presetInstructionsInputEl) context.presetInstructionsInputEl.value = '';
  }

function openPresetEditor(preset) {
    context.editingPresetId = preset ? preset.id : null;
    if (context.presetNameInputEl) context.presetNameInputEl.value = preset ? preset.name : '';
    if (context.presetInstructionsInputEl) context.presetInstructionsInputEl.value = preset ? preset.instructions : '';
    if (context.presetEditorEl) context.presetEditorEl.hidden = false;
    context.presetNameInputEl?.focus();
  }

function setSkillsStatus(message, isError) {
    if (!context.skillsStatusEl) return;
    if (!message) {
      context.skillsStatusEl.hidden = true;
      context.skillsStatusEl.textContent = '';
      return;
    }
    context.skillsStatusEl.hidden = false;
    context.skillsStatusEl.textContent = message;
    context.skillsStatusEl.classList.toggle('error', Boolean(isError));
  }

function setSelectedSkillName(name) {
    context.selectedSkillName = name || '';
    if (context.skillsEditBtnEl) context.skillsEditBtnEl.hidden = !context.selectedSkillName;
    if (context.skillsDeleteBtnEl) context.skillsDeleteBtnEl.hidden = !context.selectedSkillName;
  }

function renderSkillsSelect(skills) {
    if (!context.skillsSelectEl) return;
    context.skillsSelectEl.innerHTML = '';
    const noneOption = document.createElement('option');
    noneOption.value = '';
    noneOption.textContent = 'None';
    context.skillsSelectEl.appendChild(noneOption);
    for (const skill of skills) {
      const option = document.createElement('option');
      option.value = skill.name;
      // Flags a skill nobody's actually reached for again since it was
      // approved -- the useCount signal from skills-store.js -- so an
      // approved-but-never-mattered proposal is visible, not indistinguishable
      // from a genuinely useful one.
      option.textContent = skill.useCount ? skill.name : `${skill.name} (unused)`;
      context.skillsSelectEl.appendChild(option);
    }
    const stillExists = skills.some((skill) => skill.name === context.selectedSkillName);
    context.skillsSelectEl.value = stillExists ? context.selectedSkillName : '';
    setSelectedSkillName(context.skillsSelectEl.value);
  }

function renderPendingSkills(pending) {
    if (!context.skillsPendingEl || !context.skillsPendingListEl) return;
    const skillPending = pending.filter((p) => context.SKILL_WRITE_ACTION_TYPES.includes(p.actionType));
    context.skillsPendingEl.hidden = skillPending.length === 0;
    context.skillsPendingListEl.innerHTML = '';
    for (const item of skillPending) {
      const row = document.createElement('div');
      row.className = 'skills-pending-item';
      const summary = document.createElement('div');
      summary.className = 'skills-pending-item-summary';
      summary.textContent = item.summary || item.payload?.name || 'Pending skill';
      row.appendChild(summary);
      if (item.flags?.length) {
        const flags = document.createElement('div');
        flags.className = 'skills-pending-item-flags';
        flags.textContent = `Flagged: ${item.flags.join(', ')}`;
        row.appendChild(flags);
      }
      const actions = document.createElement('div');
      actions.className = 'skills-pending-item-actions';
      const approveBtn = document.createElement('button');
      approveBtn.textContent = 'Approve';
      approveBtn.addEventListener('click', () => decidePendingSkill(item.id, 'allow-once'));
      const denyBtn = document.createElement('button');
      denyBtn.textContent = 'Deny';
      denyBtn.addEventListener('click', () => decidePendingSkill(item.id, 'deny'));
      actions.appendChild(approveBtn);
      actions.appendChild(denyBtn);
      row.appendChild(actions);
      context.skillsPendingListEl.appendChild(row);
    }
  }

async function decidePendingSkill(requestId, decision) {
    try {
      await context.fetchJson(`${context.BACKEND_URL}/approvals/${requestId}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      setSkillsStatus(decision === 'deny' ? 'Skill proposal denied.' : 'Skill approved.');
      await refreshSkillsList();
    } catch (e) {
      setSkillsStatus(`Failed to ${decision === 'deny' ? 'deny' : 'approve'}: ${e.message}`, true);
    }
  }

async function refreshPendingSkills() {
    if (!context.skillsPendingEl) return;
    try {
      const result = await context.fetchJson(`${context.BACKEND_URL}/approvals/pending`);
      renderPendingSkills(result.pending || []);
    } catch (e) {
      console.warn('Mana pending skills list failed:', e);
    }
  }

async function refreshSkillsList() {
    if (!context.skillsSelectEl) return;
    try {
      const result = await context.fetchJson(`${context.BACKEND_URL}/skills`);
      context.latestSkills = result.skills || [];
      renderSkillsSelect(context.latestSkills);
    } catch (e) {
      setSkillsStatus(`Failed to load skills: ${e.message}`, true);
    }
    await refreshPendingSkills();
  }

function closeSkillEditor() {
    context.editingSkillName = null;
    if (context.skillsEditorEl) context.skillsEditorEl.hidden = true;
    if (context.skillNameInputEl) {
      context.skillNameInputEl.value = '';
      context.skillNameInputEl.disabled = false;
    }
    if (context.skillDescriptionInputEl) context.skillDescriptionInputEl.value = '';
    if (context.skillBodyInputEl) context.skillBodyInputEl.value = '';
  }

function openSkillEditor(skill) {
    context.editingSkillName = skill ? skill.name : null;
    if (context.skillNameInputEl) {
      context.skillNameInputEl.value = skill ? skill.name : '';
      // Renaming isn't supported by skills-store.js's updateSkill -- keep
      // the name field locked once a skill already exists.
      context.skillNameInputEl.disabled = Boolean(skill);
    }
    if (context.skillDescriptionInputEl) context.skillDescriptionInputEl.value = skill ? skill.description : '';
    if (context.skillBodyInputEl) context.skillBodyInputEl.value = skill ? skill.body : '';
    if (context.skillsEditorEl) context.skillsEditorEl.hidden = false;
    (context.skillNameInputEl?.disabled ? context.skillDescriptionInputEl : context.skillNameInputEl)?.focus();
  }

function renderMemoryFactsList(query = '') {
    if (!context.memoryFactsListEl) return;
    const normalizedQuery = query.trim().toLowerCase();
    const facts = context.latestMemoryFacts.filter(
      (fact) =>
        !normalizedQuery ||
        fact.key.toLowerCase().includes(normalizedQuery) ||
        (fact.text || '').toLowerCase().includes(normalizedQuery),
    );
    if (facts.length === 0) {
      context.memoryFactsListEl.innerHTML = `<p class="subtitle">${
        context.latestMemoryFacts.length ? `No facts match "${context.escapeHtml(query)}".` : 'No remembered facts yet.'
      }</p>`;
      return;
    }
    context.memoryFactsListEl.innerHTML = facts
      .map(
        (fact) => `
          <div class="plugin-row">
            <div class="plugin-row-info">
              <strong>${context.escapeHtml(fact.key)}</strong>
              <span>${context.escapeHtml(fact.text)}</span>
              ${fact.unverifiedSource ? '<span class="memory-fact-flag">Unverified source</span>' : ''}
            </div>
            ${
              fact.status === 'active'
                ? `<button class="memory-archive-btn" data-fact-key="${context.escapeHtml(fact.key)}" title="Archive">Archive</button>`
                : `<span class="subtitle">${context.escapeHtml(fact.status)}</span>`
            }
          </div>`,
      )
      .join('');
  }

async function loadMemoryFacts() {
    if (!context.memoryFactsListEl) return;
    try {
      const j = await context.fetchJson(`${context.BACKEND_URL}/admin/memory/facts`);
      context.latestMemoryFacts = j.facts || [];
      renderMemoryFactsList(context.memorySearchInputEl?.value || '');
    } catch (e) {
      context.memoryFactsListEl.innerHTML = `<p class="subtitle">Failed to load memory: ${context.escapeHtml(e.message)}</p>`;
    }
  }

function formatModelBytes(n) {
    if (!Number.isFinite(n)) return '';
    const gb = n / (1024 ** 3);
    if (gb >= 1) return `${gb.toFixed(1)} GB`;
    return `${(n / (1024 ** 2)).toFixed(0)} MB`;
  }

function renderModelScanList(containerEl, scanResult, onPick) {
    const models = scanResult.found || [];
    if (!models.length) {
      containerEl.innerHTML = `<p class="subtitle">No .gguf files found${scanResult.truncated ? ' (scan stopped early -- try Browse instead for a specific file).' : '.'}</p>`;
    } else {
      containerEl.innerHTML = models.map((m, i) => `
        <div class="model-scan-item" data-scan-index="${i}">
          <div class="model-scan-item-info">
            <strong>${context.escapeHtml(m.name)}</strong>
            <span>${context.escapeHtml(m.path)}</span>
          </div>
          <span class="model-scan-item-size">${context.escapeHtml(formatModelBytes(m.sizeBytes))}</span>
        </div>`).join('');
      containerEl.querySelectorAll('[data-scan-index]').forEach((row) => {
        row.addEventListener('click', () => onPick(models[Number(row.dataset.scanIndex)].path));
      });
    }
    containerEl.hidden = false;
  }

async function selectModelPath(modelPath) {
    return context.fetchJson(`${context.BACKEND_URL}/models/path`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelPath }),
    });
  }

async function loadModelSettings() {
    if (!context.modelCurrentEl) return;
    try {
      const status = await context.fetchJson(`${context.BACKEND_URL}/models/status`);
      if (status.selectedModelPath) {
        context.modelCurrentEl.textContent = `Using: ${context.basename(status.selectedModelPath)}`;
      } else {
        const active = status.profiles ? status.profiles[status.activeProfile] : null;
        context.modelCurrentEl.textContent = active && active.available
          ? `Auto-detected: ${context.basename(active.selectedModel)} (${active.label})`
          : 'No local model detected yet.';
      }
      if (context.modelClearBtnEl) context.modelClearBtnEl.hidden = !status.selectedModelPath;
    } catch (e) {
      context.modelCurrentEl.textContent = `Failed to load model status: ${e.message}`;
    }
  }

async function loadBrainProviderPresets() {
    if (!context.brainProviderSelectEl) return;
    try {
      context.brainProviderPresets = await context.fetchJson(`${context.BACKEND_URL}/models/brain-providers`);
      context.brainProviderSelectEl.innerHTML = '';
      for (const preset of context.brainProviderPresets) {
        const option = document.createElement('option');
        option.value = preset.id;
        option.textContent = preset.label;
        context.brainProviderSelectEl.appendChild(option);
      }
    } catch (e) {
      console.warn('Mana brain provider presets failed:', e);
    }
  }

async function loadBrainAndVisionSettings() {
    try {
      const status = await context.fetchJson(`${context.BACKEND_URL}/models/status`);
      const brain = status.brain || { type: 'local', baseUrl: '', model: '' };
      const isEditing = [context.brainBaseUrlEl, context.brainModelEl, context.brainApiKeyEl].includes(document.activeElement);
      if (!isEditing) {
        if (context.useRemoteAiToggleEl) context.useRemoteAiToggleEl.checked = brain.type === 'openai_compatible';
        if (context.brainProviderFieldsEl) context.brainProviderFieldsEl.hidden = brain.type !== 'openai_compatible';
        if (context.brainProviderSelectEl) {
          const matched = context.brainProviderPresets.find((p) => p.baseUrl === brain.baseUrl);
          context.brainProviderSelectEl.value = matched ? matched.id : 'custom';
        }
        if (context.brainBaseUrlEl) context.brainBaseUrlEl.value = brain.baseUrl || '';
        if (context.brainModelEl) context.brainModelEl.value = brain.model || '';
        if (context.brainApiKeyEl) context.brainApiKeyEl.placeholder = brain.hasApiKey ? '(key saved -- leave blank to keep it)' : 'leave blank for local servers';
      }
      const vision = status.vision || { modelPath: '', mmprojPath: '' };
      if (context.visionModelPathEl) context.visionModelPathEl.value = vision.modelPath || '';
      if (context.visionMmprojPathEl) context.visionMmprojPathEl.value = vision.mmprojPath || '';
    } catch (e) {
      console.warn('Mana brain/vision status failed:', e);
    }
  }

function toggleBrainProviderFields() {
    if (context.brainProviderFieldsEl) context.brainProviderFieldsEl.hidden = !context.useRemoteAiToggleEl?.checked;
  }

async function browseAndSetVisionField(fieldName) {
    if (!window.electronAPI?.browseModelFile) return;
    try {
      const picked = await window.electronAPI.browseModelFile();
      if (picked.canceled) return;
      await context.fetchJson(`${context.BACKEND_URL}/models/vision-path`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [fieldName]: picked.filePath }),
      });
      await loadBrainAndVisionSettings();
    } catch (e) {
      if (context.visionModelStatusEl) context.visionModelStatusEl.textContent = `Failed: ${e.message}`;
    }
  }

  return { setSelectedPresetId, renderPresetSelect, refreshPresetList, closePresetEditor, openPresetEditor, setSkillsStatus, setSelectedSkillName, renderSkillsSelect, renderPendingSkills, decidePendingSkill, refreshPendingSkills, refreshSkillsList, closeSkillEditor, openSkillEditor, renderMemoryFactsList, loadMemoryFacts, formatModelBytes, renderModelScanList, selectModelPath, loadModelSettings, loadBrainProviderPresets, loadBrainAndVisionSettings, toggleBrainProviderFields, browseAndSetVisionField };
}

const api = { createDesktopSettings };
if (typeof module === 'object' && module.exports) module.exports = api;
else root.ManaDesktopSettings = api;
})(typeof window === 'undefined' ? globalThis : window);
