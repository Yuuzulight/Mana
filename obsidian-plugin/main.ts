import { App, Notice, Plugin, PluginSettingTab, Setting, normalizePath } from "obsidian";
import { fetchManaMemory, fetchManaMemoryNotes } from "./mana-client.js";

interface ManaMemorySyncSettings {
  serverUrl: string;
  apiKey: string;
  notePath: string;
  notesFolder: string;
}

const DEFAULT_SETTINGS: ManaMemorySyncSettings = {
  serverUrl: "http://localhost:5005",
  apiKey: "",
  notePath: "Mana Memory.md",
  notesFolder: "Mana",
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
      await this.writeNote(this.settings.notePath, markdown);

      const notes = await fetchManaMemoryNotes(this.settings.serverUrl, this.settings.apiKey);
      const folder = normalizePath(this.settings.notesFolder);
      if (notes.length && !this.app.vault.getAbstractFileByPath(folder)) {
        await this.app.vault.createFolder(folder);
      }
      for (const note of notes) {
        await this.writeNote(`${folder}/${note.slug}.md`, note.body);
      }

      new Notice(
        `Mana Memory Sync: updated ${this.settings.notePath}` +
          (notes.length ? ` and ${notes.length} note${notes.length === 1 ? "" : "s"} in ${folder}/` : "")
      );
    } catch (err) {
      new Notice(`Mana Memory Sync failed: ${(err as Error).message}`);
    }
  }

  async writeNote(rawPath: string, content: string) {
    const path = normalizePath(rawPath);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing && "path" in existing) {
      await this.app.vault.modify(existing as any, content);
    } else {
      await this.app.vault.create(path, content);
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
      .setDesc("Vault-relative path for the single-file memory summary. Overwritten on every sync.")
      .addText((text) =>
        text
          .setPlaceholder("Mana Memory.md")
          .setValue(this.plugin.settings.notePath)
          .onChange(async (value) => {
            this.plugin.settings.notePath = value.trim() || DEFAULT_SETTINGS.notePath;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Notes folder")
      .setDesc(
        "Vault-relative folder for one linked note per cross-session entity/fact/connection " +
          "(Obsidian's graph view clusters them). Existing notes here are overwritten; notes " +
          "for entities Mana no longer tracks are not deleted automatically."
      )
      .addText((text) =>
        text
          .setPlaceholder("Mana")
          .setValue(this.plugin.settings.notesFolder)
          .onChange(async (value) => {
            this.plugin.settings.notesFolder = value.trim() || DEFAULT_SETTINGS.notesFolder;
            await this.plugin.saveSettings();
          })
      );
  }
}
