import { Notice, Plugin, TFile, type TAbstractFile } from "obsidian";
import {
    DEFAULT_SETTINGS,
    VaultSyncSettingTab,
    type VaultSyncSettings,
} from "./settings";
import { seedFromGitHub } from "./seed";
import { pullFromGitHub } from "./pull";
import { buildSkipFn, gitBlobSha, pushToGitHub } from "./push";

// Minimum gap between foreground-triggered syncs (window focus fires often on desktop).
const FOREGROUND_MIN_GAP_MS = 60 * 1000;

type VaultChange = "create" | "modify" | "delete" | "rename";

export default class VaultSyncPlugin extends Plugin {
    settings!: VaultSyncSettings;
    private autoSyncTimer: number | null = null;
    private autoSyncRunning = false;
    private editSyncTimer: number | null = null;
    private lastSyncStart = 0;
    private shouldSkip: (path: string) => boolean = () => false;
    private statusBar: HTMLElement | null = null;

    async onload(): Promise<void> {
        await this.loadSettings();
        this.addSettingTab(new VaultSyncSettingTab(this.app, this));

        this.statusBar = this.addStatusBarItem();
        this.updateStatusBar("idle");

        this.addRibbonIcon("refresh-cw", "Sync vault now", () => {
            void this.runWithErrorNotice("sync", () => this.runSync(false));
        });

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

        this.shouldSkip = buildSkipFn(this.app.vault.configDir);
        this.app.workspace.onLayoutReady(() => {
            // Registered after layout-ready: Obsidian fires "create" for every
            // file while the vault loads.
            this.registerEvent(this.app.vault.on("create", (f) => void this.onVaultChange("create", f)));
            this.registerEvent(this.app.vault.on("modify", (f) => void this.onVaultChange("modify", f)));
            this.registerEvent(this.app.vault.on("delete", (f) => void this.onVaultChange("delete", f)));
            this.registerEvent(
                this.app.vault.on("rename", (f, oldPath) => void this.onVaultChange("rename", f, oldPath))
            );
            if (this.settings.syncOnOpen) this.autoSync();
        });
        this.registerDomEvent(document, "visibilitychange", () => {
            if (document.visibilityState === "visible") this.onForeground();
        });
        this.registerDomEvent(window, "focus", () => this.onForeground());
    }

    private updateStatusBar(state: "idle" | "syncing" | "error", detail?: string): void {
        if (!this.statusBar) return;
        const sha = this.settings.lastCommitSha
            ? this.settings.lastCommitSha.slice(0, 7)
            : "(unseeded)";
        const icon = state === "syncing" ? "⟳" : state === "error" ? "⚠" : "✓";
        this.statusBar.setText(`${icon} Vault Sync ${sha}${detail ? ` — ${detail}` : ""}`);
    }

    onunload(): void {
        if (this.autoSyncTimer !== null) {
            window.clearInterval(this.autoSyncTimer);
            this.autoSyncTimer = null;
        }
        if (this.editSyncTimer !== null) {
            window.clearTimeout(this.editSyncTimer);
            this.editSyncTimer = null;
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
        this.lastSyncStart = Date.now();
        this.updateStatusBar("syncing");
        try {
            await pullFromGitHub(this, { silent });
            await pushToGitHub(this, { silent });
            this.updateStatusBar("idle");
        } catch (e) {
            this.updateStatusBar("error", e instanceof Error ? e.message.slice(0, 40) : "");
            throw e;
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
        this.autoSyncTimer = window.setInterval(() => this.autoSync(), ms);
    }

    /** Silent background sync; only errors surface. No-op until seeded. */
    private autoSync(): void {
        const { pat, repoUrl, lastCommitSha } = this.settings;
        if (!pat || !repoUrl || !lastCommitSha) return;
        this.runSync(true).catch((e) => {
            const msg = e instanceof Error ? e.message : String(e);
            console.error("[Vault Sync] auto-sync failed", e);
            new Notice(`Vault Sync auto-sync failed: ${msg}`, 10000);
        });
    }

    private onForeground(): void {
        if (!this.settings.syncOnOpen) return;
        if (Date.now() - this.lastSyncStart < FOREGROUND_MIN_GAP_MS) return;
        this.autoSync();
    }

    private async onVaultChange(kind: VaultChange, file: TAbstractFile, oldPath?: string): Promise<void> {
        if ((this.settings.syncAfterEditSeconds ?? 0) <= 0) return;
        if (await this.matchesSyncedState(kind, file, oldPath)) return;
        this.scheduleEditSync();
    }

    /**
     * True when a vault event doesn't need a sync: the path is excluded from
     * sync, or the change only reflects what fileShaMap already records
     * (typically pull writing or removing the file itself).
     */
    private async matchesSyncedState(kind: VaultChange, file: TAbstractFile, oldPath?: string): Promise<boolean> {
        if (kind === "rename") {
            return this.shouldSkip(file.path) && (!oldPath || this.shouldSkip(oldPath));
        }
        if (this.shouldSkip(file.path)) return true;
        // Push only tracks files: a new (empty) folder has nothing to sync,
        // and pull creates folders itself. Folder deletes still sync.
        if (!(file instanceof TFile)) return kind === "create";
        const known = this.settings.fileShaMap[file.path];
        if (kind === "delete") return known === undefined;
        try {
            const content = await this.app.vault.adapter.readBinary(file.path);
            return known === (await gitBlobSha(content));
        } catch {
            return false;
        }
    }

    /** (Re)start the idle timer; if a sync is mid-flight when it fires, wait for another idle period. */
    private scheduleEditSync(): void {
        if (this.editSyncTimer !== null) window.clearTimeout(this.editSyncTimer);
        this.editSyncTimer = window.setTimeout(() => {
            this.editSyncTimer = null;
            if (this.autoSyncRunning) {
                this.scheduleEditSync();
                return;
            }
            this.autoSync();
        }, this.settings.syncAfterEditSeconds * 1000);
    }

    async loadSettings(): Promise<void> {
        const data = (await this.loadData()) ?? {};
        this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }
}
