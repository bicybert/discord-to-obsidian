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
		if (e.status === 0) {
			return "Could not reach Discord at all — check your internet connection.";
		}
		if (e.status >= 500) {
			return `Discord is having server problems (${e.status}). Try again in a moment.`;
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
		this.addCommand({
			id: "boot-discord-bot",
			name: "Verify Discord bot identity",
			callback: () => this.bootBot(),
		});
	}

	onunload(): void {}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** Fetch every server the bot is in, so the user can pick one from a dropdown. */
	async loadServerList(): Promise<void> {
		if (!this.settings.token) {
			new Notice("Set your bot token first.");
			return;
		}
		try {
			const client = new DiscordClient(this.settings.token);
			const guilds = await client.listGuilds();
			const next: Record<string, string> = {};
			for (const guild of guilds) {
				next[guild.id] = guild.name;
			}
			this.settings.guilds = next;
			await this.saveSettings();
			new Notice(
				guilds.length > 0
					? `Found ${guilds.length} server(s) — pick one from the dropdown.`
					: "The bot isn't in any server yet. Invite it with the OAuth2 URL first.",
			);
		} catch (e) {
			new Notice(`Could not load servers: ${describeApiError(e)}`);
		}
	}

	async loadChannelList(): Promise<void> {
		if (!this.settings.token || !this.settings.guildId) {
			new Notice("Set your bot token and pick a server first.");
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

	/** Debug: run the exact channel-list request and show the raw status + response body. */
	async testConnection(): Promise<void> {
		const { token, guildId } = this.settings;
		if (!token || !guildId) {
			new Notice("Set the bot token and server ID first.");
			return;
		}
		try {
			const res = await requestUrl({
				url: `https://discord.com/api/v10/guilds/${guildId}/channels`,
				method: "GET",
				headers: { Authorization: `Bot ${token}` },
				throw: false,
			});
			console.log(`[discord-to-obsidian] test connection: HTTP ${res.status}\n${res.text}`);
			new Notice(
				`GET /guilds/${guildId}/channels\n` +
					`HTTP ${res.status}\n\n` +
					`token in use starts: "${token.slice(0, 6)}…" (${token.length} chars)\n\n` +
					`${res.text.slice(0, 300)}`,
				20000,
			);
		} catch (e) {
			new Notice(`Request failed before any response: ${e.message}`, 15000);
		}
	}

	/**
	 * Boot step: verify the token works (bot identity) and that the bot can
	 * actually see the configured server (guild access). Returns a result
	 * object rather than throwing so callers can branch on it.
	 */
	async bootBot(): Promise<{ ok: boolean; who?: string; guild?: string; error?: string }> {
		const { token, guildId } = this.settings;
		if (!token || !guildId) {
			return { ok: false, error: "Set your bot token and server ID first." };
		}
		try {
			const client = new DiscordClient(token);
			const me = await client.getMe();
			const who = me.bot ? `${me.username} (bot)` : `${me.username} (user)`;
			const guild = (await client.getGuild(guildId)).name;
			return { ok: true, who, guild };
		} catch (e) {
			return { ok: false, error: describeApiError(e) };
		}
	}

	/** Debug: fetch channels for every known server and report pass/fail per server, with IDs and raw response bodies. */
	async diagnoseServers(): Promise<void> {
		const guilds = Object.entries(this.settings.guilds);
		if (guilds.length === 0) {
			new Notice("Load the server list first.");
			return;
		}
		const client = new DiscordClient(this.settings.token);
		const lines: string[] = [];
		for (const [id, name] of guilds) {
			try {
				const channels = await client.listTextChannels(id);
				lines.push(`✅ ${name} (${id}): OK, ${channels.length} text channels`);
			} catch (e) {
				const apiErr = e instanceof DiscordApiError ? e : null;
				const body = apiErr?.body ? `\n    ↳ body: ${apiErr.body.slice(0, 150)}` : "";
				lines.push(
					`❌ ${name} (${id}): ${apiErr ? `HTTP ${apiErr.status}` : e.message}${body}`,
				);
			}
		}
		new Notice(lines.join("\n"), 25000);
	}

	/** Prove the bot can act in the server: post a test message to the first enabled channel. */
	async sendTestMessage(): Promise<void> {
		const boot = await this.bootBot();
		if (!boot.ok) {
			new Notice(`Boot failed — ${boot.error}`);
			return;
		}
		const firstEnabled = Object.entries(this.settings.channels).find(([, c]) => c.enabled);
		if (!firstEnabled) {
			new Notice("Enable at least one channel first — the test message will be posted there.");
			return;
		}
		const [channelId, meta] = firstEnabled;
		try {
			const client = new DiscordClient(this.settings.token);
			await client.sendMessage(
				channelId,
				`✅ Discord to Obsidian test message — ${new Date().toLocaleString()}`,
			);
			new Notice(`Test message posted to #${meta.name}. The bot is fully operational.`);
		} catch (e) {
			new Notice(`Failed to post test message: ${describeApiError(e)}`);
		}
	}

	async syncAll(): Promise<void> {
		if (!this.settings.token || !this.settings.guildId) {
			new Notice("Configure your Discord token and server ID in the plugin settings first.");
			return;
		}
		const boot = await this.bootBot();
		if (!boot.ok) {
			new Notice(`Sync aborted — ${boot.error}`);
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
					try {
						const res = await requestUrl(att.url);
						await this.app.vault.createBinary(path, res.arrayBuffer);
						attachmentPaths.set(att.id, path);
					} catch (e) {
						// CDN link failed — leave the map unset so the renderer falls
						// back to a plain live link instead of a broken ![[url]] embed.
						console.error(`[discord-to-obsidian] failed to download attachment ${att.id}`, e);
					}
				} else {
					attachmentPaths.set(att.id, path);
				}
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
