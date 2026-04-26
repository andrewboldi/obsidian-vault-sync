import { Notice, Plugin } from "obsidian";
import {
    DEFAULT_SETTINGS,
    VaultSyncSettingTab,
    type VaultSyncSettings,
} from "./settings";
import { seedFromGitHub } from "./seed";
import { pullFromGitHub } from "./pull";
import { pushToGitHub } from "./push";

export default class VaultSyncPlugin extends Plugin {
    settings!: VaultSyncSettings;
    private autoSyncTimer: number | null = null;
    private autoSyncRunning = false;

    async onload(): Promise<void> {
        await this.loadSettings();
        this.addSettingTab(new VaultSyncSettingTab(this.app, this));

        this.addCommand({
            id: "seed-from-github",
            name: "Seed from GitHub",
            callback: () => this.runWithErrorNotice("seed", () => seedFromGitHub(this)),
        });

        this.addCommand({
            id: "pull-from-github",
            name: "Pull from GitHub",
            callback: () => this.runWithErrorNotice("pull", () => pullFromGitHub(this)),
        });

        this.addCommand({
            id: "push-to-github",
            name: "Push to GitHub",
            callback: () => this.runWithErrorNotice("push", () => pushToGitHub(this)),
        });

        this.addCommand({
            id: "sync-now",
            name: "Sync now (pull then push)",
            callback: () => this.runWithErrorNotice("sync", () => this.runSync(false)),
        });

        this.scheduleAutoSync();
    }

    onunload(): void {
        if (this.autoSyncTimer !== null) {
            window.clearInterval(this.autoSyncTimer);
            this.autoSyncTimer = null;
        }
    }

    private async runWithErrorNotice(label: string, fn: () => Promise<void>): Promise<void> {
        try {
            await fn();
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`[Vault Sync] ${label} failed`, e);
            new Notice(`Vault Sync ${label} failed: ${msg}`, 10000);
        }
    }

    /** Pull then push. silent=true → no success notices, only errors. */
    async runSync(silent: boolean): Promise<void> {
        if (this.autoSyncRunning) return;
        this.autoSyncRunning = true;
        try {
            await pullFromGitHub(this, { silent });
            await pushToGitHub(this, { silent });
        } finally {
            this.autoSyncRunning = false;
        }
    }

    /** Restart the auto-sync interval based on current setting. */
    scheduleAutoSync(): void {
        if (this.autoSyncTimer !== null) {
            window.clearInterval(this.autoSyncTimer);
            this.autoSyncTimer = null;
        }
        const minutes = this.settings.autoSyncIntervalMinutes ?? 0;
        if (minutes <= 0) return;
        const ms = minutes * 60 * 1000;
        this.autoSyncTimer = window.setInterval(() => {
            this.runSync(true).catch((e) => {
                const msg = e instanceof Error ? e.message : String(e);
                console.error("[Vault Sync] auto-sync failed", e);
                new Notice(`Vault Sync auto-sync failed: ${msg}`, 10000);
            });
        }, ms);
    }

    async loadSettings(): Promise<void> {
        const data = (await this.loadData()) ?? {};
        this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }
}
