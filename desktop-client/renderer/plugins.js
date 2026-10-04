(function(root) {
function createPluginsUI(context) {
async function loadPlugins() {
    if (!context.pluginsListEl) return;
    try {
      const j = await context.fetchJson(`${context.BACKEND_URL}/plugins/store`);

      // Render two sections: Plugins (tier: "plugin") and Add-Ons (tier: "addon").
      // Plugins lists installed and available ones alike (#499); each row's
      // button opens the details modal, where install/uninstall happen.
      const addonRows = [];
      for (const a of j.addons || []) {
        // Add-Ons require explicit consent on first load — check via API or assume not consented
        const isConsented = await context.fetchJson(`${context.BACKEND_URL}/addons/consent/${context.escapeHtml(a.name)}`);

        addonRows.push(
          `<div class="plugin-row" data-plugin="${context.escapeHtml(a.name)}">
            <div class="plugin-row-info">
              <strong>${context.escapeHtml(a.name)}</strong>
              <span>${context.escapeHtml(a.description || 'Full-scale Mana feature')}</span>
            </div>
            ${isConsented.consented ?
              '<button class="plugin-switch on" data-plugin-key="' + context.escapeHtml(a.name) + '" aria-pressed="true" title="Enabled"></button>' :
              '<button class="plugin-switch disabled" data-plugin-key="' + context.escapeHtml(a.name) + '" aria-pressed="false" title="Requires consent">⚙️</button>'}
          </div>`
        );
      }

      // Build the popup menu with two distinct sections
      const html = [
        '<h4 class="section-title">🔌 Plugins</h4>',
        window.ManaPluginStoreUi.pluginRowsHtml(j.plugins || []),
        '',
        '<h4 class="section-title">⚡ Add-Ons</h4>',
        addonRows.length ? addonRows.join('') : '<p class="subtitle muted">No add-ons available.</p>'
      ].join('\n');

      context.pluginsListEl.innerHTML = html;
    } catch (e) {
      context.pluginsListEl.innerHTML = `<p class="subtitle">Failed to load plugins: ${context.escapeHtml(e.message)}</p>`;
    }
  }

async function showPluginDetails(pluginName) {
    let data;
    try {
      const j = await context.fetchJson(`${context.BACKEND_URL}/plugins/store`);
      data = (j.all || []).find((p) => p.name === pluginName);
    } catch (e) {
      setPluginsStatus(`Failed to load plugin details: ${e.message}`, true);
      return;
    }
    if (!data) return;

    hidePluginDetails();
    document.body.insertAdjacentHTML('beforeend', window.ManaPluginStoreUi.pluginDetailsHtml(data));
    const modal = document.getElementById('pluginDetailsModal');
    const statusEl = modal.querySelector('.plugin-details-status');
    modal.querySelector('.close-btn').addEventListener('click', hidePluginDetails);
    modal.querySelector('.close-btn').focus();

    modal.querySelector('.plugin-install-btn')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      statusEl.textContent = 'Installing...';
      await installPlugin('github', data.url);
      showPluginDetails(pluginName);
    });

    modal.querySelector('.plugin-uninstall-btn')?.addEventListener('click', async (e) => {
      if (!window.confirm(`Uninstall plugin "${pluginName}"?`)) return;
      e.target.disabled = true;
      try {
        await context.fetchJson(`${context.BACKEND_URL}/plugins/store/uninstall`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: pluginName }),
        });
        hidePluginDetails();
        setPluginsStatus(`Uninstalled plugin: ${pluginName}`);
        loadPlugins();
      } catch (err) {
        statusEl.textContent = `Uninstall failed: ${err.message}`;
        e.target.disabled = false;
      }
    });
  }

function hidePluginDetails() {
    document.getElementById('pluginDetailsModal')?.remove();
  }

async function installPlugin(sourceType, urlOrPath) {
    if (!context.pluginsListEl) return;

    try {
      const result = await context.fetchJson(`${context.BACKEND_URL}/plugins/store/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceType, urlOrPath }),
      });

      if (result.success) {
        setPluginsStatus(`Successfully installed plugin: ${context.escapeHtml(result.name)}!`);

        // Refresh the list after install
        setTimeout(loadPlugins, 500);
      } else if (result.skipped) {
        setPluginsStatus(`Plugin ${context.escapeHtml(result.name)} was already installed.`, false);
      } else {
        throw new Error(result.error || 'Install failed');
      }
    } catch (e) {
      setPluginsStatus(`Failed to install plugin: ${context.escapeHtml(e.message)}`, true);
    }
  }

function setPluginsStatus(message, isError = false) {
    if (!context.pluginsListEl.parentElement) return;

    const container = document.createElement('div');
    container.className = `status-message ${isError ? 'error' : 'success'}`;
    container.textContent = message;

    // Insert before the plugins list
    const firstChild = context.pluginsListEl.parentElement.firstChild;
    if (firstChild && firstChild !== context.pluginsListEl) {
      context.pluginsListEl.parentElement.insertBefore(container, firstChild);
    } else {
      context.pluginsListEl.parentElement.appendChild(container);
    }

    // Auto-remove after 5 seconds
    setTimeout(() => container.remove(), 5000);
  }

  return { loadPlugins, showPluginDetails, hidePluginDetails, installPlugin, setPluginsStatus };
}

const api = { createPluginsUI };
if (typeof module === 'object' && module.exports) module.exports = api;
else root.ManaPlugins = api;
})(typeof window === 'undefined' ? globalThis : window);
