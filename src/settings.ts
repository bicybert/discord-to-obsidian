import { App, Notice, PluginSettingTab, SettingDefinitionAction, SettingDefinitionControl, SettingDefinitionGroup, SettingDefinitionItem, SettingDropdownControl, SettingFolderControl, SettingNumberControl, SettingTextControl, SettingToggleControl } from "obsidian";
import type DiscordToObsidianPlugin from "./main";

export interface ChannelSetting {
	name: string;
	enabled: boolean;
}

export interface DiscordSettings {
	token: string;
	guildId: string;
	/** guild id → name, populated by "Load server list" */
	guilds: Record<string, string>;
	outputFolder: string;
	attachmentsFolder: string;
	/** attachments go into a subfolder named after the channel they came from */
	organizeByChannel: boolean;
	/** attachments go into images/ or files/ subfolders depending on type */
	organizeByType: boolean;
	messageLimit: number;
	channels: Record<string, ChannelSetting>;
	/** channel id → newest message id already synced (for incremental syncs) */
	syncState: Record<string, string>;
}

export const DEFAULT_SETTINGS: DiscordSettings = {
	token: "",
	guildId: "",
	guilds: {},
	outputFolder: "Discord",
	attachmentsFolder: "Discord/attachments",
	organizeByChannel: true,
	organizeByType: true,
	messageLimit: 500,
	channels: {},
	syncState: {},
};

export class DiscordSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: DiscordToObsidianPlugin,
	) {
		super(app, plugin);
	}

	getControlValue(key: string): unknown {
		if (key.startsWith("channel:")) {
			const channelId = key.slice("channel:".length);
			return this.plugin.settings.channels[channelId]?.enabled ?? false;
		}
		return super.getControlValue(key);
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const settings = this.plugin.settings;
		if (key.startsWith("channel:")) {
			const channelId = key.slice("channel:".length);
			const channel = settings.channels[channelId];
			if (channel) {
				channel.enabled = Boolean(value);
			}
			await this.plugin.saveSettings();
			return;
		}
		if (key === "guildId") {
			settings.guildId = value as string;
			settings.channels = {};
			await this.plugin.saveSettings();
			await this.plugin.loadChannelList();
			this.update();
			return;
		}
		await super.setControlValue(key, value);
	}

	private channelToggle(channelId: string, channel: ChannelSetting): SettingDefinitionControl {
		return {
			name: `#${channel.name}`,
			control: {
				type: "toggle",
				key: `channel:${channelId}`,
				defaultValue: channel.enabled,
			},
		};
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const settings = this.plugin.settings;
		const guilds = Object.entries(settings.guilds);
		const channelEntries = Object.entries(settings.channels).sort((a, b) =>
			a[1].name.localeCompare(b[1].name),
		);

		const guildOptions: Record<string, string> = { "": "— pick a server —" };
		for (const [id, name] of guilds) {
			guildOptions[id] = name;
		}

		return [
			{
				type: "group",
				heading: "Connection",
				items: [
					{
						name: "Bot token",
						desc: "Discord bot token. Stored locally in this vault's data.json — never commit it.",
						control: {
							type: "text",
							key: "token",
							placeholder: "MTIzNDU2Nzg5...",
							defaultValue: "",
						} as SettingTextControl,
					},
					{
						name: "Invite bot",
						desc: "Open the Discord Developer Portal to invite the bot to your server.",
						action: () => {
							void this.plugin.inviteBot();
						},
					},
					{
						name: "Server",
						desc: "Load the servers the bot is in, then pick one — the channel list loads automatically.",
						control: {
							type: "dropdown",
							key: "guildId",
							options: guildOptions,
							defaultValue: "",
							disabled: guilds.length === 0,
						} as SettingDropdownControl,
					},
					{
						name: "Load server list",
						desc: "Fetch the servers the bot is in and auto-select one.",
						action: async () => {
							await this.plugin.loadServerList();
							this.update();
						},
					},
				],
			},
			{
				type: "group",
				heading: "Channels",
				desc:
					channelEntries.length > 0
						? "Toggle which channels of the selected server to sync."
						: "Pick a server above — its channels load here automatically.",
				visible: guilds.length > 0,
				items: [
					...(channelEntries.length > 0
						? [
								{
									name: "Select all",
									action: async () => {
										for (const [, channel] of channelEntries) {
											channel.enabled = true;
										}
										await this.plugin.saveSettings();
										this.update();
									},
								},
								{
									name: "Select none",
									action: async () => {
										for (const [, channel] of channelEntries) {
											channel.enabled = false;
										}
										await this.plugin.saveSettings();
										this.update();
									},
								},
						  ]
						: []),
					...channelEntries.map(([id, channel]) => this.channelToggle(id, channel)),
				],
			},
			{
				type: "group",
				heading: "Storage",
				items: [
					{
						name: "Output folder",
						desc: "Vault folder where channel notes are created.",
						control: {
							type: "folder",
							key: "outputFolder",
							placeholder: "Discord",
							defaultValue: "Discord",
						} as SettingFolderControl,
					},
					{
						name: "Attachments folder",
						desc: "Root vault folder where downloaded images and files are stored.",
						control: {
							type: "folder",
							key: "attachmentsFolder",
							placeholder: "Discord/attachments",
							defaultValue: "Discord/attachments",
						} as SettingFolderControl,
					},
					{
						name: "Organize attachments by channel",
						desc:
							"Store each channel's attachments in a subfolder named after the channel, e.g. Discord/attachments/general/...",
						control: {
							type: "toggle",
							key: "organizeByChannel",
							defaultValue: true,
						} as SettingToggleControl,
					},
					{
						name: "Separate images and files",
						desc:
							"Add an images/ or files/ subfolder depending on attachment type (images vs. PDFs and other files).",
						control: {
							type: "toggle",
							key: "organizeByType",
							defaultValue: true,
						} as SettingToggleControl,
					},
					{
						name: "Initial message limit",
						desc:
							"How many messages per channel to fetch on the very first sync. Later syncs only fetch new messages.",
						control: {
							type: "number",
							key: "messageLimit",
							placeholder: "500",
							defaultValue: 500,
						} as SettingNumberControl,
					},
				],
			},
			{
				type: "group",
				heading: "Maintenance",
				items: [
					{
						name: "Reset sync state",
						desc:
							"Forget which messages were already synced. The next sync re-pulls everything and overwrites the channel notes (attachments are kept).",
						action: async () => {
							await this.plugin.resetSyncState();
						},
					},
					{
						name: "Verify bot identity",
						desc:
							"Checks the token works AND that the bot can see this server. Shows the bot's Discord user ID so you can match it to the member list.",
						action: async () => {
							const result = await this.plugin.bootBot();
							if (result.ok) {
								new Notice(
									`Bot verified: ${result.who} (ID ${result.id}) — can access "${result.guild}"`,
								);
							} else {
								new Notice(`Boot failed — ${result.error}`);
							}
						},
					},
					{
						name: "Diagnose servers",
						desc:
							"Debug: fetches channels for every server in the list and reports which ones the bot can read.",
						action: async () => {
							await this.plugin.diagnoseServers();
						},
					},
					{
						name: "Send test message",
						desc:
							"Posts a hello message to your first enabled channel. Needs the Send Messages permission on the bot.",
						action: async () => {
							await this.plugin.sendTestMessage();
						},
					},
				],
			},
		];
	}
}
