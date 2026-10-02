// Plugin store markup (Settings > Plugins, issue #499): the list rows and
// the details modal. Pure string builders so they can be tested from Node;
// renderer.js owns fetching and wiring the buttons. Same dual-export IIFE
// pattern as reply-emotion.js.
(function () {

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// One row per plugin, installed or not. The button is the store's entry
// point: it opens the details modal, where install/uninstall happen.
function pluginRowsHtml(plugins) {
  if (!plugins.length) return '<p class="subtitle muted">No plugins available.</p>';
  return plugins.map((p) => `
    <div class="plugin-row" data-plugin="${esc(p.name)}">
      <div class="plugin-row-info">
        <strong>${esc(p.name)}</strong>
        <span>${esc(p.description || "Optional Mana capability")}</span>
      </div>
      <button class="plugin-details-btn" data-plugin="${esc(p.name)}">${p.installed ? "Manage" : "Details"}</button>
    </div>`).join("");
}

function pluginDetailsHtml(plugin) {
  const permissions = Array.isArray(plugin.permissions) && plugin.permissions.length
    ? `<h3>Permissions</h3><ul>${plugin.permissions.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>`
    : "";
  const action = plugin.installed
    ? '<button class="plugin-uninstall-btn">Uninstall</button>'
    : plugin.url
      ? '<button class="primary plugin-install-btn">Install</button>'
      : '<span class="subtitle">No install source.</span>';
  return `
    <div id="pluginDetailsModal" class="modal show" aria-hidden="false">
      <div class="modal-content" role="dialog" aria-modal="true" aria-label="${esc(plugin.name)}">
        <div class="modal-header">
          <h2>${esc(plugin.name)}</h2>
          <button class="close-btn" aria-label="Close">×</button>
        </div>
        <div class="modal-body">
          <p><strong>Version:</strong> ${esc(plugin.version || "N/A")}</p>
          <p><strong>Author:</strong> ${esc(plugin.author || "Unknown")}</p>
          <p>${esc(plugin.description || "No description available.")}</p>
          ${plugin.url ? `<p><a href="${esc(plugin.url)}" target="_blank" rel="noopener noreferrer">View on GitHub</a></p>` : ""}
          ${permissions}
          <p class="plugin-details-status subtitle"></p>
          ${action}
        </div>
      </div>
    </div>`;
}

const exportsObj = { pluginRowsHtml, pluginDetailsHtml };
if (typeof module !== "undefined" && module.exports) {
  module.exports = exportsObj;
}
if (typeof window !== "undefined") {
  window.ManaPluginStoreUi = exportsObj;
}

})();
