import { App, PluginSettingTab, Setting } from "obsidian";
import type VaultSyncPlugin from "./main";

export interface VaultSyncSettings {
    pat: string;
    repoUrl: string;
    branch: string;
    lastCommitSha: string;
    fileShaMap: Record<string, string>;
}

export const DEFAULT_SETTINGS: VaultSyncSettings = {
    pat: "",
    repoUrl: "",
    branch: "main",
    lastCommitSha: "",
    fileShaMap: {},
};

export class VaultSyncSettingTab extends PluginSettingTab {
    plugin: VaultSyncPlugin;

    constructor(app: App, plugin: VaultSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl("h2", { text: "Vault Sync (REST)" });

        new Setting(containerEl)
            .setName("GitHub Personal Access Token")
            .setDesc(
                "Fine-grained or classic PAT with repo (contents: read/write) scope on the target repo."
            )
            .addText((text) => {
                text.inputEl.type = "password";
                text.setPlaceholder("ghp_…")
                    .setValue(this.plugin.settings.pat)
                    .onChange(async (value) => {
                        this.plugin.settings.pat = value.trim();
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName("Repository URL")
            .setDesc("e.g. https://github.com/owner/repo")
            .addText((text) =>
                text
                    .setPlaceholder("https://github.com/owner/repo")
                    .setValue(this.plugin.settings.repoUrl)
                    .onChange(async (value) => {
                        this.plugin.settings.repoUrl = value.trim();
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Branch")
            .setDesc("Branch to sync (default: main)")
            .addText((text) =>
                text
                    .setPlaceholder("main")
                    .setValue(this.plugin.settings.branch)
                    .onChange(async (value) => {
                        this.plugin.settings.branch = value.trim() || "main";
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Last commit SHA")
            .setDesc(
                "Set after a successful seed/pull. Read-only — used as the local sync base."
            )
            .addText((text) => {
                text.setValue(this.plugin.settings.lastCommitSha || "(none)")
                    .setDisabled(true);
            });
    }
}
