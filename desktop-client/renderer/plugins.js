// Dual-tier plugin/add-on store UI + modal logic (plugins.js)
const TIER_STANDARD = 'standard';
const TIER_ADVANCED = 'advanced';

let currentModalState = {
  isOpen: false,
  tier: null,
  selectedPlugin: null,
};

function openPluginStore() {
  const modalEl = document.getElementById('pluginStoreModal');
  if (!modalEl) return;
  
  // Fetch plugins from backend via IPC
  window.electronAPI?.fetchPluginsStore().then((plugins) => {
    renderPluginList(plugins);
    
    currentModalState.isOpen = true;
    modalEl.classList.remove('hidden');
    
    // Focus first button in the modal for accessibility
    const firstButton = modalEl.querySelector('button, [role="button"]');
    if (firstButton) {
      setTimeout(() => firstButton.focus(), 100);
    }
  }).catch((err) => {
    console.error('Failed to fetch plugins:', err);
    showStoreError('Unable to load plugin store. Please check your connection.');
  });
}

function closePluginStore() {
  const modalEl = document.getElementById('pluginStoreModal');
  if (!modalEl) return;
  
  currentModalState.isOpen = false;
  currentModalState.selectedPlugin = null;
  modalEl.classList.add('hidden');
}

function renderPluginList(plugins) {
  const listContainer = document.getElementById('pluginStoreList');
  if (!listContainer || !Array.isArray(plugins)) return;
  
  // Clear existing content
  listContainer.innerHTML = '';
  
  // Group by tier
  const standardPlugins = plugins.filter(p => p.tier === TIER_STANDARD);
  const advancedPlugins = plugins.filter(p => p.tier === TIER_ADVANCED);
  
  if (standardPlugins.length > 0) {
    renderTierSection(listContainer, 'Standard Plugins', standardPlugins);
  }
  
  if (advancedPlugins.length > 0) {
    renderTierSection(listContainer, 'Advanced Plugins', advancedPlugins);
  }
}

function renderTierSection(container, title, plugins) {
  const sectionEl = document.createElement('div');
  sectionEl.className = 'plugin-tier-section';
  
  const headerEl = document.createElement('h3');
  headerEl.textContent = title;
  headerEl.className = 'plugin-tier-title';
  sectionEl.appendChild(headerEl);
  
  // Create filter buttons for this tier
  const filterContainer = document.createElement('div');
  filterContainer.className = 'tier-filter-buttons';
  
  const allBtn = createFilterButton(filterContainer, 'All', () => {
    renderPluginList(plugins);
  });
  const installedBtn = createFilterButton(filterContainer, 'Installed', () => {
    const installedIds = new Set();
    plugins.forEach(p => {
      if (p.installed) installedIds.add(p.id);
    });
    renderFilteredPlugins(listContainer.querySelector('.plugin-list'), plugins.filter(p => installedIds.has(p.id)));
  });
  
  filterContainer.appendChild(allBtn);
  filterContainer.appendChild(installedBtn);
  
  sectionEl.appendChild(filterContainer);
  
  // Plugin list container
  const listContainer = document.createElement('div');
  listContainer.className = 'plugin-list';
  listContainer.dataset.tier = title.toLowerCase().replace(/ /g, '-');
  
  plugins.forEach(plugin => {
    const itemEl = createPluginItem(plugin);
    itemEl.addEventListener('click', () => selectPlugin(plugin));
    listContainer.appendChild(itemEl);
  });
  
  sectionEl.appendChild(listContainer);
  container.appendChild(sectionEl);
}

function renderFilteredPlugins(container, plugins) {
  if (!container || !Array.isArray(plugins)) return;
  
  container.innerHTML = '';
  
  if (plugins.length === 0) {
    const emptyMsg = document.createElement('p');
    emptyMsg.className = 'plugin-list-empty';
    emptyMsg.textContent = 'No plugins found.';
    container.appendChild(emptyMsg);
    return;
  }
  
  plugins.forEach(plugin => {
    const itemEl = createPluginItem(plugin);
    itemEl.addEventListener('click', () => selectPlugin(plugin));
    container.appendChild(itemEl);
  });
}

function createFilterButton(parent, label, onClick) {
  const btn = document.createElement('button');
  btn.className = 'tier-filter-btn';
  btn.textContent = label;
  btn.dataset.filter = label.toLowerCase();
  
  parent.appendChild(btn);
  
  // Click handler
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const filterValue = btn.dataset.filter;
    
    // Update button states
    parent.querySelectorAll('.tier-filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    
    // Apply filter
    if (filterValue === 'all') {
      renderPluginList(plugins);
    } else if (filterValue === 'installed') {
      const installedIds = new Set();
      plugins.forEach(p => {
        if (p.installed) installedIds.add(p.id);
      });
      renderFilteredPlugins(container.querySelector('.plugin-list'), plugins.filter(p => installedIds.has(p.id)));
    } else {
      // Show all for other filters
      renderPluginList(plugins);
    }
  });
  
  return btn;
}

function createPluginItem(plugin) {
  const item = document.createElement('div');
  item.className = `plugin-item ${plugin.installed ? 'installed' : ''}`;
  
  const badgeEl = plugin.tier === TIER_ADVANCED 
    ? document.createElement('span') 
    : null;
  if (badgeEl) {
    badgeEl.className = 'tier-badge advanced';
    badgeEl.textContent = 'Advanced';
  }
  
  item.innerHTML = `
    <div class="plugin-icon">${getPluginIcon(plugin.type)}</div>
    <div class="plugin-info">
      <h4 class="plugin-name">${escapeHtml(plugin.name)}</h4>
      ${badgeEl ? `<span class="tier-badge advanced">${'Advanced'}</span>` : ''}
      <p class="plugin-desc">${truncateText(escapeHtml(plugin.description), 120)}</p>
    </div>
    <button class="install-btn" data-plugin-id="${plugin.id}">
      ${plugin.installed ? 'Uninstall' : 'Install'}
    </button>
  `;
  
  // Install/uninstall button handler
  const installBtn = item.querySelector('.install-btn');
  if (installBtn) {
    installBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      handlePluginAction(plugin);
    });
  }
  
  return item;
}

function getPluginIcon(type) {
  const icons = {
    'ai': '🧠',
    'research': '🔍',
    'voice': '🎤',
    'memory': '💾',
    'tools': '🛠️',
    'default': '⚙️'
  };
  return icons[type] || icons.default;
}

function selectPlugin(plugin) {
  currentModalState.selectedPlugin = plugin;
  
  // Show details view (could be a separate modal or inline expansion)
  const detailsContainer = document.getElementById('pluginDetails');
  if (!detailsContainer) return;
  
  detailsContainer.innerHTML = `
    <h2>${escapeHtml(plugin.name)}</h2>
    <p class="plugin-description">${escapeHtml(plugin.description)}</p>
    <div class="plugin-meta">
      <span><strong>Type:</strong> ${escapeHtml(plugin.type || 'General')}</span>
      <span><strong>Tier:</strong> ${plugin.tier}</span>
      <span><strong>Status:</strong> ${plugin.installed ? 'Installed' : 'Available'}</span>
    </div>
    <p class="plugin-requirements">${escapeHtml(plugin.requirements || 'No specific requirements.')}</p>
  `;
}

function handlePluginAction(plugin) {
  if (!currentModalState.selectedPlugin) return;
  
  const action = currentModalState.selectedPlugin.installed ? 'uninstall' : 'install';
  const pluginId = currentModalState.selectedPlugin.id;
  
  // Confirm uninstallation
  if (action === 'uninstall') {
    if (!confirm(`Uninstall "${currentModalState.selectedPlugin.name}"?`)) return;
  }
  
  // Call backend via IPC
  window.electronAPI?.managePlugin({ id: pluginId, action }).then((result) => {
    closePluginStore();
    
    // Refresh the list
    if (result.success) {
      showStoreSuccess(`Plugin ${action}ed successfully.`);
      
      // Re-fetch to get updated state
      window.electronAPI?.fetchPluginsStore().then((updatedPlugins) => {
        renderPluginList(updatedPlugins);
      }).catch(() => {
        showStoreError('Failed to refresh plugin list.');
      });
    } else {
      showStoreError(result.error || 'Operation failed. Please try again.');
    }
  }).catch((err) => {
    console.error('Plugin action error:', err);
    showStoreError('An unexpected error occurred while managing the plugin.');
  });
}

function showStoreSuccess(message) {
  const toast = document.getElementById('storeToast');
  if (!toast) return;
  
  toast.textContent = message;
  toast.className = 'store-toast success';
  setTimeout(() => {
    toast.classList.remove('success');
    toast.textContent = '';
  }, 3000);
}

function showStoreError(message) {
  const toast = document.getElementById('storeToast');
  if (!toast) return;
  
  toast.textContent = message;
  toast.className = 'store-toast error';
  setTimeout(() => {
    toast.classList.remove('error');
    toast.textContent = '';
  }, 5000);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function truncateText(text, maxLength) {
  if (!text || text.length <= maxLength) return text;
  return text.substring(0, maxLength).trim() + '...';
}

// Initialize: wire store open/close handlers
window.electronAPI?.onPluginStoreOpen(openPluginStore);
window.electronAPI?.onPluginStoreClose(closePluginStore);
