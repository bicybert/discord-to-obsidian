import { Notice, Plugin, requestUrl, TFile, normalizePath } from "obsidian";
import { DiscordApiError, DiscordClient, DiscordMessage } from "./discord";
import { renderBody, renderNoteHeader, sanitizeFilename } from "./renderer";
import { DEFAULT_SETTINGS, DiscordSettingTab, DiscordSettings } from "./settings";

/** Human-readable hints for common Discord API auth/access errors. */
function describeApiError(e: unknown): string {
	if (e instanceof DiscordApiError) {
		if (e.status === 401) {
			return "Invalid bot token — check it in the plugin settings.";
		}
		if (e.status === 403) {
			return "The bot can't access this server. Make sure it's been invited (OAuth2 → URL Generator, scope 'bot', permissions: View Channels + Read Message History) and the Server ID is correct.";
		}
		if (e.status === 404) {
			return "Server not found — the Server ID is probably wrong.";
		}
		return e.message;
	}
	return String(e);
}

/** Hard cap so a long-overdue incremental sync can't run forever. */
const MAX_MESSAGES_PER_SYNC = 10000;

export default class DiscordToObsidianPlugin extends Plugin {
	settings: DiscordSettings;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.addSettingTab(new DiscordSettingTab(this.app, this));
		this.addRibbonIcon("messages-square", "Sync Discord channels", () => this.syncAll());
		this.addCommand({
			id: "sync-discord-channels",
			name: "Sync selected Discord channels",
			callback: () => this.syncAll(),
		});
	}

	onunload(): void {}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async loadChannelList(): Promise<void> {
		if (!this.settings.token || !this.settings.guildId) {
			new Notice("Set your bot token and server ID first.");
			return;
		}
		try {
			const client = new DiscordClient(this.settings.token);
			const channels = await client.listTextChannels(this.settings.guildId);
			const next: DiscordSettings["channels"] = {};
			for (const channel of channels) {
				next[channel.id] = {
					name: channel.name,
					enabled: this.settings.channels[channel.id]?.enabled ?? false,
				};
			}
			this.settings.channels = next;
			await this.saveSettings();
			new Notice(`Found ${channels.length} text channels.`);
		} catch (e) {
			new Notice(`Could not load channels: ${describeApiError(e)}`);
		}
	}

	/** Clear the per-channel resume points so the next sync does a full re-pull and rewrites the notes. */
	async resetSyncState(): Promise<void> {
		this.settings.syncState = {};
		await this.saveSettings();
		new Notice("Sync state cleared. The next sync will re-pull and rewrite the channel notes.");
	}

	async syncAll(): Promise<void> {
		if (!this.settings.token || !this.settings.guildId) {
			new Notice("Configure your Discord token and server ID in the plugin settings first.");
			return;
		}
		const selected = Object.entries(this.settings.channels).filter(([, c]) => c.enabled);
		if (selected.length === 0) {
			new Notice("No channels selected. Pick some in the plugin settings.");
			return;
		}

		const client = new DiscordClient(this.settings.token);
		const channelNames = new Map<string, string>(
			Object.entries(this.settings.channels).map(([id, c]) => [id, c.name]),
		);

		let guildName = "unknown";
		try {
			guildName = (await client.getGuild(this.settings.guildId)).name;
		} catch {
			// frontmatter-only; don't block the sync over it
		}

		let done = 0;
		let totalNew = 0;
		for (const [channelId, meta] of selected) {
			done++;
			new Notice(`Syncing #${meta.name} (${done}/${selected.length})...`);
			try {
				const count = await this.syncChannel(client, channelId, meta.name, guildName, channelNames);
				totalNew += count;
				if (count > 0) new Notice(`#${meta.name}: saved ${count} new message(s).`);
			} catch (e) {
				new Notice(`Failed to sync #${meta.name}: ${describeApiError(e)}`);
			}
		}
		await this.saveSettings();
		new Notice(`Discord sync finished — ${totalNew} new message(s) across ${selected.length} channel(s).`);
	}

	private async syncChannel(
		client: DiscordClient,
		channelId: string,
		channelName: string,
		guildName: string,
		channelNames: Map<string, string>,
	): Promise<number> {
		const afterId = this.settings.syncState[channelId] ?? null;
		const messages = await client.fetchMessages(channelId, {
			afterId,
			maxMessages: afterId ? MAX_MESSAGES_PER_SYNC : this.settings.messageLimit,
		});
		if (messages.length === 0) return 0;

		// Authors we've seen, so @mentions render as @username.
		const userNames = new Map<string, string>();
		for (const m of messages) userNames.set(m.author.id, m.author.username);

		// Download attachments — CDN links expire, so they must be saved locally.
		// Layout: <attachmentsFolder>[/<channelName>][/<images|files>]/<id>-<filename>
		const baseDir = this.settings.organizeByChannel
			? `${this.settings.attachmentsFolder}/${sanitizeFilename(channelName)}`
			: this.settings.attachmentsFolder;
		const imagesDir = this.settings.organizeByType ? `${baseDir}/images` : baseDir;
		const filesDir = this.settings.organizeByType ? `${baseDir}/files` : baseDir;
		await this.ensureFolder(imagesDir);
		await this.ensureFolder(filesDir);

		const attachmentPaths = new Map<string, string>();
		for (const message of messages) {
			for (const att of message.attachments) {
				const dir = att.content_type?.startsWith("image/") ? imagesDir : filesDir;
				const path = normalizePath(`${dir}/${att.id}-${sanitizeFilename(att.filename)}`);
				if (!this.app.vault.getAbstractFileByPath(path)) {
					const res = await requestUrl(att.url);
					await this.app.vault.createBinary(path, res.arrayBuffer);
				}
				attachmentPaths.set(att.id, path);
			}
		}

		await this.ensureFolder(this.settings.outputFolder);
		const notePath = normalizePath(
			`${this.settings.outputFolder}/${sanitizeFilename(channelName)}.md`,
		);
		const body = renderBody(messages, userNames, channelNames, attachmentPaths);
		const header = renderNoteHeader(channelName, guildName, channelId);
		const existing = this.app.vault.getAbstractFileByPath(notePath);

		if (afterId === null) {
			// Full re-sync: rewrite the whole note (fresh content, no duplicates).
			if (existing instanceof TFile) {
				await this.app.vault.modify(existing, header + body);
			} else {
				await this.app.vault.create(notePath, header + body);
			}
		} else if (existing instanceof TFile) {
			// Incremental sync: append chronologically at the end of the note.
			await this.app.vault.append(existing, "\n\n" + body);
		} else {
			// State existed but the note is gone — rebuild it from this point forward.
			await this.app.vault.create(notePath, header + body);
		}

		// Snowflake of the newest message becomes the resume point.
		this.settings.syncState[channelId] = messages[messages.length - 1].id;
		// Persist immediately so a crash mid-sync can't cause duplicate appends.
		await this.saveSettings();
		return messages.length;
	}

	private async ensureFolder(path: string): Promise<void> {
		const normalized = normalizePath(path);
		if (!normalized || normalized === "/") return;
		let current = "";
		for (const part of normalized.split("/").filter(Boolean)) {
			current = current ? `${current}/${part}` : part;
			if (!this.app.vault.getAbstractFileByPath(current)) {
				await this.app.vault.createFolder(current);
			}
		}
	}
}
