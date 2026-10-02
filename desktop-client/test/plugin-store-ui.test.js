const assert = require("node:assert/strict");
const test = require("node:test");

// Issue #499: the store's list rows and details modal markup.
const { pluginRowsHtml, pluginDetailsHtml } = require("../renderer/plugin-store-ui");

test("every plugin row has a button that opens its details modal", () => {
  const html = pluginRowsHtml([
    { name: "a", installed: true },
    { name: "b", installed: false },
  ]);
  assert.match(html, /class="plugin-details-btn" data-plugin="a">Manage</);
  assert.match(html, /class="plugin-details-btn" data-plugin="b">Details</);
  assert.match(pluginRowsHtml([]), /No plugins available/);
});

test("details modal offers Install for an available plugin and Uninstall for an installed one", () => {
  const available = pluginDetailsHtml({ name: "b", installed: false, url: "https://github.com/x/y" });
  assert.match(available, /plugin-install-btn/);
  assert.doesNotMatch(available, /plugin-uninstall-btn/);

  const installed = pluginDetailsHtml({ name: "a", installed: true });
  assert.match(installed, /plugin-uninstall-btn/);
  assert.doesNotMatch(installed, /plugin-install-btn/);
  // Uses the app's existing modal class so it actually shows as an overlay.
  assert.match(installed, /id="pluginDetailsModal" class="modal show"/);
  assert.doesNotMatch(installed, /onclick=/);
});

test("plugin fields are escaped", () => {
  const html = pluginDetailsHtml({ name: "<img src=x>", description: "\"quoted\"" });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.match(html, /&quot;quoted&quot;/);
});
