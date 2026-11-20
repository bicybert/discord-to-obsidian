import { Notice, Plugin, requestUrl, TFile, normalizePath } from "obsidian";
import { DiscordApiError, DiscordClient } from "./discord";
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
		this.addCommand({
			id: "invite-discord-bot",
			name: "Invite bot to a server",
			callback: () => this.inviteBot(),
		});
	}

	onunload(): void {}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<DiscordSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** Fetch every server the bot is in, auto-pick one if the configured ID is
	 * stale/missing, and load its channels right away. */
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

			if (guilds.length === 0) {
				new Notice("The bot isn't in any server yet. Invite it with the OAuth2 URL first.");
				return;
			}

			// The configured server is gone (bot removed) or was mistyped —
			// auto-pick the first one and load its channels immediately.
			if (!this.settings.guildId || !next[this.settings.guildId]) {
				const first = guilds[0];
				this.settings.guildId = first.id;
				this.settings.channels = {};
				await this.saveSettings();
				new Notice(`Picked "${next[first.id]}" — loading channels…`);
				await this.loadChannelList();
			} else {
				new Notice(`Found ${guilds.length} server(s) — channels will load when you pick one.`);
			}
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

	/**
	 * Boot step: verify the token works (bot identity) and that the bot can
	 * actually see the configured server (guild access). Returns a result
	 * object rather than throwing so callers can branch on it.
	 */
	async bootBot(): Promise<{ ok: boolean; who?: string; id?: string; guild?: string; error?: string; servers?: string[] }> {
		const { token, guildId } = this.settings;
		if (!token || !guildId) {
			return { ok: false, error: "Set your bot token and server ID first." };
		}
		const client = new DiscordClient(token);
		try {
			const me = await client.getMe();
			const who = me.bot ? `${me.username} (bot)` : `${me.username} (user)`;
			const guild = (await client.getGuild(guildId)).name;
			return { ok: true, who, id: me.id, guild };
		} catch (e) {
			// If the configured server is inaccessible, list the ones the bot
			// CAN see — that's the most useful thing to show the user.
			let servers: string[] = [];
			try {
				const guilds = await client.listGuilds();
				servers = guilds.map((g) => `${g.name} (${g.id})`);
			} catch {
				/* ignore — the original error is what matters */
			}
			const base = describeApiError(e);
			return {
				ok: false,
				error: servers.length
					? `${base}\n\nThe bot is in: ${servers.join(", ")}. Pick one of these as the Server ID.`
					: base,
				servers,
			};
		}
	}

/** Open the Discord Developer Portal so the user can re-invite the bot. */
		inviteBot(): void {
			const { token } = this.settings;
			if (!token) {
				new Notice("Set your bot token first.");
				return;
			}
			const portalUrl = "https://discord.com/developers/applications";
			new Notice(
				"Open the Developer Portal, copy your bot's Application ID, and invite it:\n\n" +
				`1. Go to ${portalUrl}\n` +
				"2. Click your application → OAuth2 → URL Generator\n" +
				"3. Check the 'bot' scope, grant View Channels + Read Message History\n" +
				"4. Open the URL and invite the bot to your server\n\n" +
				'Then come back and click "Load server list".',
				30000,
			);
		}

	/** Debug: fetch channels for every known server, write a copyable report file, and summarize in a Notice. */
	async diagnoseServers(): Promise<void> {
		const guilds = Object.entries(this.settings.guilds);
		if (guilds.length === 0) {
			new Notice("Load the server list first.");
			return;
		}
		const client = new DiscordClient(this.settings.token);
		const lines: string[] = [
			`# Discord Channel Sync — diagnosis`,
			`run at: ${new Date().toISOString()}`,
			`token in use starts: "${this.settings.token.slice(0, 6)}…" (${this.settings.token.length} chars)`,
			"",
		];
		for (const [id, name] of guilds) {
			try {
				const channels = await client.listTextChannels(id);
				lines.push(`- ✅ ${name} (${id}): OK, ${channels.length} text channels`);
			} catch (e) {
				const apiErr = e instanceof DiscordApiError ? e : null;
				const status = apiErr ? `HTTP ${apiErr.status}` : "network error";
				const body =
					apiErr?.body ?? (e as { message?: string }).message ?? "unknown error";
				lines.push(
					`- ❌ ${name} (${id}): ${status}`,
					`    - raw body: ${body.slice(0, 300)}`,
				);
			}
		}

		const report = lines.join("\n");
		const reportPath = "Discord debug report.md";
		const existing = this.app.vault.getAbstractFileByPath(reportPath);
		if (existing instanceof TFile) {
			await this.app.vault.process(existing, () => report);
		} else {
			await this.app.vault.create(reportPath, report);
		}
		new Notice("Diagnosis written to 'Discord debug report.md' in your vault root — open and paste it back.", 10000);
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
				`✅ Discord Channel Sync test message — ${new Date().toLocaleString()}`,
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
						console.error(`[discord-channel-sync] failed to download attachment ${att.id}`, e);
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
				await this.app.vault.process(existing, () => header + body);
			} else {
				await this.app.vault.create(notePath, header + body);
			}
		} else if (existing instanceof TFile) {
			// Incremental sync: append chronologically at the end of the note.
			await this.app.vault.process(existing, (data) => data + "\n\n" + body);
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
