import { App, Notice, Plugin, PluginSettingTab, Setting, normalizePath } from "obsidian";
import { fetchManaMemory } from "./mana-client.js";

interface ManaMemorySyncSettings {
  serverUrl: string;
  apiKey: string;
  notePath: string;
}

const DEFAULT_SETTINGS: ManaMemorySyncSettings = {
  serverUrl: "http://localhost:5005",
  apiKey: "",
  notePath: "Mana Memory.md",
};

export default class ManaMemorySyncPlugin extends Plugin {
  settings: ManaMemorySyncSettings = DEFAULT_SETTINGS;

  async onload() {
    await this.loadSettings();

    this.addRibbonIcon("brain-circuit", "Sync Mana memory", () => this.syncMemory());

    this.addCommand({
      id: "sync-mana-memory",
      name: "Sync Mana memory",
      callback: () => this.syncMemory(),
    });

    this.addSettingTab(new ManaMemorySyncSettingTab(this.app, this));
  }

  async syncMemory() {
    if (!this.settings.apiKey) {
      new Notice("Mana Memory Sync: set an API key in plugin settings first.");
      return;
    }
    try {
      const markdown = await fetchManaMemory(this.settings.serverUrl, this.settings.apiKey);
      const path = normalizePath(this.settings.notePath);
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing && "path" in existing) {
        await this.app.vault.modify(existing as any, markdown);
      } else {
        await this.app.vault.create(path, markdown);
      }
      new Notice(`Mana Memory Sync: updated ${path}`);
    } catch (err) {
      new Notice(`Mana Memory Sync failed: ${(err as Error).message}`);
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class ManaMemorySyncSettingTab extends PluginSettingTab {
  plugin: ManaMemorySyncPlugin;

  constructor(app: App, plugin: ManaMemorySyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Mana server URL")
      .setDesc("Base URL of your Mana node-bot server.")
      .addText((text) =>
        text
          .setPlaceholder("http://localhost:5005")
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value.trim() || DEFAULT_SETTINGS.serverUrl;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("API key")
      .setDesc("From node-bot/data/auth/SETUP.txt or the admin dashboard.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("mana API key")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Target note path")
      .setDesc("Vault-relative path to sync memory into. Overwritten on every sync.")
      .addText((text) =>
        text
          .setPlaceholder("Mana Memory.md")
          .setValue(this.plugin.settings.notePath)
          .onChange(async (value) => {
            this.plugin.settings.notePath = value.trim() || DEFAULT_SETTINGS.notePath;
            await this.plugin.saveSettings();
          })
      );
  }
}
