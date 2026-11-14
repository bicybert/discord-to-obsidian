import { requestUrl } from "obsidian";

const API_BASE = "https://discord.com/api/v10";
const PAGE_SIZE = 100;
const MAX_RETRIES = 3;

export interface DiscordUser {
	id: string;
	username: string;
	bot?: boolean;
}

export interface DiscordAttachment {
	id: string;
	filename: string;
	url: string;
	size: number;
	content_type?: string;
}

export interface DiscordEmbed {
	title?: string;
	url?: string;
	description?: string;
}

export interface DiscordMessage {
	id: string;
	content: string;
	timestamp: string;
	author: DiscordUser;
	attachments: DiscordAttachment[];
	embeds?: DiscordEmbed[];
	referenced_message?: DiscordMessage | null;
}

export interface DiscordChannel {
	id: string;
	name: string;
	type: number;
	position?: number;
}

export interface DiscordGuild {
	id: string;
	name: string;
}

export class DiscordApiError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Snowflakes are 64-bit ints, so they must be compared numerically, not lexically. */
export function compareSnowflakes(a: string, b: string): number {
	return a === b ? 0 : BigInt(a) < BigInt(b) ? -1 : 1;
}

export class DiscordClient {
	constructor(private token: string) {}

	private async request(
		path: string,
		opts: { method?: string; body?: unknown } = {},
	): Promise<any> {
		let delay = 1000;
		for (let attempt = 0; ; attempt++) {
			let res;
			try {
				res = await requestUrl({
					url: `${API_BASE}${path}`,
					method: opts.method ?? "GET",
					headers: { Authorization: `Bot ${this.token}` },
					body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
					contentType: opts.body !== undefined ? "application/json" : undefined,
					throw: false,
				});
			} catch (e) {
				// Network-level failure (never reached Discord) — show it distinctly.
				console.error(`[discord-to-obsidian] network failure on GET ${path}`, e);
				throw new DiscordApiError(0, `Network error reaching Discord: ${e.message}`);
			}
		if (res.status >= 200 && res.status < 300) {
			return res.json;
		}
		if (res.status === 429 && attempt < MAX_RETRIES) {
			const body = res.json ?? {};
			const retryAfter =
				typeof body.retry_after === "number" ? body.retry_after * 1000 : delay;
			await sleep(Math.max(retryAfter, 500) + 250);
			delay *= 2;
			continue;
		}
		if (res.status >= 500 && attempt < MAX_RETRIES) {
			// Discord sometimes 502/503s transiently — retry with backoff.
			await sleep(delay);
			delay *= 2;
			continue;
		}
		const detail = res.json?.message ?? res.text ?? "unknown error";
		console.error(
			`[discord-to-obsidian] ${res.status} on GET ${path}\nresponse body: ${res.text}`,
		);
		throw new DiscordApiError(res.status, `Discord API ${res.status}: ${detail}`);
		}
	}

	async getGuild(guildId: string): Promise<DiscordGuild> {
		return this.request(`/guilds/${guildId}`);
	}

	/** Who is this token? Returns the bot's username + id. */
	async getMe(): Promise<DiscordUser> {
		return this.request("/users/@me");
	}

	/** Post a message to a channel (needs the Send Messages permission). */
	async sendMessage(channelId: string, content: string): Promise<DiscordMessage> {
		return this.request(`/channels/${channelId}/messages`, {
			method: "POST",
			body: { content },
		});
	}

	async listTextChannels(guildId: string): Promise<DiscordChannel[]> {
		const channels: DiscordChannel[] = await this.request(`/guilds/${guildId}/channels`);
		return channels
			.filter((c) => c.type === 0) // GUILD_TEXT only
			.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
	}

	/**
	 * Fetch messages for a channel, returned oldest → newest.
	 *
	 * Without `afterId` this pulls the newest `maxMessages` messages (backwards
	 * pagination from the latest message). With `afterId` it resumes from that
	 * message forward, so a channel only fetches what arrived since last sync.
	 */
	async fetchMessages(
		channelId: string,
		opts: { afterId?: string | null; maxMessages?: number },
	): Promise<DiscordMessage[]> {
		const max = opts.maxMessages ?? Number.MAX_SAFE_INTEGER;
		const collected: DiscordMessage[] = [];
		let cursor = opts.afterId ?? undefined;
		const goingForward = Boolean(opts.afterId);

		while (collected.length < max) {
			const q = new URLSearchParams({ limit: String(PAGE_SIZE) });
			if (goingForward && cursor) q.set("after", cursor);
			if (!goingForward && cursor) q.set("before", cursor);

			const page: DiscordMessage[] = await this.request(
				`/channels/${channelId}/messages?${q.toString()}`,
			);
			if (page.length === 0) break;
			collected.push(...page);

			if (goingForward) {
				cursor = page.reduce(
					(newest, m) => (compareSnowflakes(m.id, newest) > 0 ? m.id : newest),
					cursor as string,
				);
			} else {
				cursor = page.reduce(
					(oldest, m) => (compareSnowflakes(m.id, oldest) < 0 ? m.id : oldest),
					cursor ?? page[0].id,
				);
			}
			if (page.length < PAGE_SIZE) break;
		}

		collected.sort((a, b) => compareSnowflakes(a.id, b.id));
		return collected.slice(0, max);
	}
}
