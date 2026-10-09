const form = document.getElementById('connect');
const status = document.getElementById('status');
const stop = document.getElementById('disconnect');

async function refresh() {
  const result = await chrome.runtime.sendMessage({ type: 'status' });
  status.textContent = result.connected ? 'Connected to Mana' : 'Disconnected';
  stop.hidden = !result.connected;
  form.hidden = result.connected;
}

async function perform(message) {
  for (const button of document.querySelectorAll('button')) button.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage(message);
    if (result.error) throw new Error(result.error);
    await refresh();
  } catch (error) { status.textContent = error.message; }
  finally { for (const button of document.querySelectorAll('button')) button.disabled = false; }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  void perform({ type: 'connect', code: document.getElementById('code').value.trim(), tabIds: [...document.querySelectorAll('input[name="tab"]:checked')].map(input => Number(input.value)) });
});
stop.addEventListener('click', () => { void perform({ type: 'disconnect' }); });

void (async () => {
  const container = document.getElementById('tabs');
  for (const tab of await chrome.tabs.query({})) {
    if (!/^https?:\/\//i.test(tab.url || '')) continue;
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox'; input.name = 'tab'; input.value = String(tab.id); input.checked = Boolean(tab.active);
    label.append(input, document.createTextNode(` ${tab.title || tab.url}`));
    container.append(label);
  }
  await refresh();
})().catch(error => { status.textContent = error.message; });
