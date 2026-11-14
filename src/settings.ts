import { App, PluginSettingTab, Setting } from "obsidian";
import type DiscordToObsidianPlugin from "./main";

export interface ChannelSetting {
	name: string;
	enabled: boolean;
}

export interface DiscordSettings {
	token: string;
	guildId: string;
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

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Discord to Obsidian" });

		new Setting(containerEl)
			.setName("Bot token")
			.setDesc("Discord bot token. Stored locally in this vault's data.json — never commit it.")
			.addText((text) => {
				text
					.setPlaceholder("MTIzNDU2Nzg5...")
					.setValue(this.plugin.settings.token)
					.onChange(async (value) => {
						this.plugin.settings.token = value.trim();
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "password";
			});

		new Setting(containerEl)
			.setName("Server (guild) ID")
			.setDesc(
				"Enable Developer Mode in Discord (Settings → Advanced), then right-click your server → Copy Server ID.",
			)
			.addText((text) =>
				text
					.setPlaceholder("123456789012345678")
					.setValue(this.plugin.settings.guildId)
					.onChange(async (value) => {
						this.plugin.settings.guildId = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Output folder")
			.setDesc("Vault folder where channel notes are created.")
			.addText((text) =>
				text
					.setPlaceholder("Discord")
					.setValue(this.plugin.settings.outputFolder)
					.onChange(async (value) => {
						this.plugin.settings.outputFolder = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Attachments folder")
			.setDesc("Root vault folder where downloaded images and files are stored.")
			.addText((text) =>
				text
					.setPlaceholder("Discord/attachments")
					.setValue(this.plugin.settings.attachmentsFolder)
					.onChange(async (value) => {
						this.plugin.settings.attachmentsFolder = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Organize attachments by channel")
			.setDesc(
				"Store each channel's attachments in a subfolder named after the channel, e.g. Discord/attachments/general/...",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.organizeByChannel)
					.onChange(async (value) => {
						this.plugin.settings.organizeByChannel = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Separate images and files")
			.setDesc(
				"Add an images/ or files/ subfolder depending on attachment type (images vs. PDFs and other files).",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.organizeByType)
					.onChange(async (value) => {
						this.plugin.settings.organizeByType = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Initial message limit")
			.setDesc("How many messages per channel to fetch on the very first sync. Later syncs only fetch new messages.")
			.addText((text) =>
				text
					.setPlaceholder("500")
					.setValue(String(this.plugin.settings.messageLimit))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						this.plugin.settings.messageLimit = Number.isNaN(parsed) ? 500 : parsed;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Reset sync state")
			.setDesc(
				"Forget which messages were already synced. The next sync re-pulls everything and overwrites the channel notes (attachments are kept).",
			)
			.addButton((button) =>
				button
					.setButtonText("Reset")
					.setWarning()
					.onClick(async () => {
						await this.plugin.resetSyncState();
					}),
			);

		new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Debug: runs the channel-list request directly and shows Discord's raw HTTP status and response.")
			.addButton((button) =>
				button.setButtonText("Test").onClick(async () => {
					await this.plugin.testConnection();
				}),
			);

		new Setting(containerEl)
			.setName("Channels")
			.setDesc("Load the text channels for this server, then toggle which ones to sync.")
			.addButton((button) =>
				button
					.setButtonText("Load channel list")
					.setCta()
					.onClick(async () => {
						await this.plugin.loadChannelList();
						this.display();
					}),
			);

		const entries = Object.entries(this.plugin.settings.channels).sort((a, b) =>
			a[1].name.localeCompare(b[1].name),
		);
		for (const [id, channel] of entries) {
			new Setting(containerEl).setName(`#${channel.name}`).addToggle((toggle) =>
				toggle.setValue(channel.enabled).onChange(async (value) => {
					channel.enabled = value;
					await this.plugin.saveSettings();
				}),
			);
		}
	}
}
