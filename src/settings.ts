import { App, PluginSettingTab, Setting } from "obsidian";
import type VaultSyncPlugin from "./main";

export interface VaultSyncSettings {
    pat: string;
    repoUrl: string;
    branch: string;
    lastCommitSha: string;
    fileShaMap: Record<string, string>;
    autoSyncIntervalMinutes: number; // 0 = disabled
    syncAfterEditSeconds: number; // 0 = disabled
    syncOnOpen: boolean;
}

export const DEFAULT_SETTINGS: VaultSyncSettings = {
    pat: "",
    repoUrl: "",
    branch: "main",
    lastCommitSha: "",
    fileShaMap: {},
    autoSyncIntervalMinutes: 0,
    syncAfterEditSeconds: 0,
    syncOnOpen: false,
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

        new Setting(containerEl)
            .setName("GitHub personal access token")
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
            .setDesc("For example, https://github.com/owner/repo")
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
            .setName("Auto-sync interval (minutes)")
            .setDesc(
                "Pull then push every N minutes. 0 disables. Recommended: 1-5."
            )
            .addText((text) =>
                text
                    .setPlaceholder("0")
                    .setValue(String(this.plugin.settings.autoSyncIntervalMinutes ?? 0))
                    .onChange(async (value) => {
                        const n = Math.max(0, Math.floor(Number(value) || 0));
                        this.plugin.settings.autoSyncIntervalMinutes = n;
                        await this.plugin.saveSettings();
                        this.plugin.scheduleAutoSync();
                    })
            );

        new Setting(containerEl)
            .setName("Sync after edits (seconds idle)")
            .setDesc(
                "Pull then push once you've stopped editing for N seconds. 0 disables. Recommended: 30-60."
            )
            .addText((text) =>
                text
                    .setPlaceholder("0")
                    .setValue(String(this.plugin.settings.syncAfterEditSeconds ?? 0))
                    .onChange(async (value) => {
                        const n = Math.max(0, Math.floor(Number(value) || 0));
                        this.plugin.settings.syncAfterEditSeconds = n;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Sync on open")
            .setDesc(
                "Pull then push when Obsidian starts and when it comes back to the foreground."
            )
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.syncOnOpen ?? false)
                    .onChange(async (value) => {
                        this.plugin.settings.syncOnOpen = value;
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
