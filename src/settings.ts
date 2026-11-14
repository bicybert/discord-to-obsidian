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
			.setDesc("Where downloaded images and files are stored.")
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
