import type { DiscordMessage } from "./discord";

export function sanitizeFilename(name: string): string {
	return (
		name
			.replace(/[\\/:*?"<>|#^[\]]/g, "-")
			.replace(/\s+/g, " ")
			.trim() || "unnamed"
	);
}

export function formatTimestamp(iso: string): string {
	const d = new Date(iso);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Turn Discord's mention/emoji markup into readable text. */
function replaceMentions(
	content: string,
	userNames: Map<string, string>,
	channelNames: Map<string, string>,
): string {
	return content
		.replace(/<@!?(\d+)>/g, (_, id: string) =>
			userNames.get(id) ? `@${userNames.get(id)}` : "@user",
		)
		.replace(/<#(\d+)>/g, (_, id: string) =>
			channelNames.get(id) ? `#${channelNames.get(id)}` : "#channel",
		)
		.replace(/<a?:(\w+):\d+>/g, (_, name: string) => `:${name}:`);
}

export function renderMessageBlock(
	message: DiscordMessage,
	userNames: Map<string, string>,
	channelNames: Map<string, string>,
	attachmentPaths: Map<string, string>,
): string {
	const parts: string[] = [];
	const author = message.author.username + (message.author.bot ? " [bot]" : "");
	parts.push(`## ${author} — ${formatTimestamp(message.timestamp)}`);

	if (message.referenced_message) {
		const refAuthor = message.referenced_message.author?.username ?? "unknown";
		const refContent = replaceMentions(
			message.referenced_message.content ?? "",
			userNames,
			channelNames,
		)
			.split("\n")
			.slice(0, 3)
			.map((line) => `> ${line}`)
			.join("\n");
		parts.push(`> ↩ **replying to ${refAuthor}:**\n${refContent}`);
	}

	const content = replaceMentions(message.content, userNames, channelNames).trim();
	if (content) {
		parts.push(content);
	}

	for (const att of message.attachments) {
		const path = attachmentPaths.get(att.id);
		// Locally downloaded attachments are embedded; anything left links to the CDN.
		parts.push(path ? `![[${path}]]` : att.url);
	}

	for (const embed of message.embeds ?? []) {
		const lines: string[] = [];
		if (embed.title) {
			lines.push(embed.url ? `> [**${embed.title}**](${embed.url})` : `> **${embed.title}**`);
		}
		if (embed.description) {
			for (const line of embed.description.split("\n").slice(0, 6)) {
				lines.push(`> ${line}`);
			}
		}
		if (lines.length) parts.push(lines.join("\n"));
	}

	return parts.join("\n");
}

export function renderNoteHeader(channelName: string, guildName: string, channelId: string): string {
	const escape = (s: string) => s.replace(/"/g, '\\"');
	return [
		"---",
		`channel: "${escape(channelName)}"`,
		`channel-id: "${channelId}"`,
		`server: "${escape(guildName)}"`,
		`synced: ${new Date().toISOString()}`,
		"---",
		"",
	].join("\n");
}

export function renderBody(
	messages: DiscordMessage[],
	userNames: Map<string, string>,
	channelNames: Map<string, string>,
	attachmentPaths: Map<string, string>,
): string {
	return messages
		.map((m) => renderMessageBlock(m, userNames, channelNames, attachmentPaths))
		.join("\n\n");
}
