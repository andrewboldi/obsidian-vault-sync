import { Notice, Plugin } from "obsidian";
import {
    DEFAULT_SETTINGS,
    VaultSyncSettingTab,
    type VaultSyncSettings,
} from "./settings";
import { seedFromGitHub } from "./seed";
import { pullFromGitHub } from "./pull";

export default class VaultSyncPlugin extends Plugin {
    settings!: VaultSyncSettings;

    async onload(): Promise<void> {
        await this.loadSettings();
        this.addSettingTab(new VaultSyncSettingTab(this.app, this));

        this.addCommand({
            id: "seed-from-github",
            name: "Seed from GitHub",
            callback: async () => {
                try {
                    await seedFromGitHub(this);
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    console.error("[Vault Sync] seed failed", e);
                    new Notice(`Vault Sync seed failed: ${msg}`, 10000);
                }
            },
        });

        this.addCommand({
            id: "pull-from-github",
            name: "Pull from GitHub",
            callback: async () => {
                try {
                    await pullFromGitHub(this);
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    console.error("[Vault Sync] pull failed", e);
                    new Notice(`Vault Sync pull failed: ${msg}`, 10000);
                }
            },
        });
    }

    async loadSettings(): Promise<void> {
        const data = (await this.loadData()) ?? {};
        this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }
}
