// FruitsHub Discord Bot Slash Command: /reset-hwid
// Compatible with Discord.js v14
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("reset-hwid")
        .setDescription("Reset the hardware ID (HWID) lock for your FruitsHub key")
        .addStringOption(option =>
            option.setName("key")
                .setDescription("Your FruitsHub key (starts with FH-)")
                .setRequired(true)
        ),

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const rawKey = interaction.options.getString("key").trim();
        const serverUrl = process.env.FRUITSHUB_SERVER_URL || "https://fruitshub.onrender.com";

        try {
            const response = await fetch(`${serverUrl}/api/hwid/request-reset`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ key: rawKey })
            });

            const data = await response.json();

            if (!response.ok || !data.success) {
                const errorMsg = data.error || "Failed to process HWID reset request.";
                const errEmbed = new EmbedBuilder()
                    .setTitle("❌ HWID Reset Failed")
                    .setDescription(errorMsg)
                    .setColor(0xEF4444)
                    .setFooter({ text: "FruitsHub Key Management" })
                    .setTimestamp();

                return interaction.editReply({ embeds: [errEmbed] });
            }

            // Success: Checkpoint needed
            const embed = new EmbedBuilder()
                .setTitle("🔄 FruitsHub HWID Unlock")
                .setDescription(
                    `Key: \`${rawKey}\`\n\n` +
                    `To unlock your HWID lock and bind this key to your new device, click the button below and complete a quick checkpoint.\n\n` +
                    `Once completed, your key will be **unlocked immediately** and ready to use in Roblox.`
                )
                .setColor(0x38BDF8)
                .setFooter({ text: "FruitsHub Automated Gateway • Instant 24/7" })
                .setTimestamp();

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setLabel("Unlock HWID via Checkpoint (30s) ↗")
                    .setStyle(ButtonStyle.Link)
                    .setURL(data.checkpointUrl)
            );

            return interaction.editReply({ embeds: [embed], components: [row] });

        } catch (err) {
            console.error("[-] Discord /reset-hwid command error:", err);
            return interaction.editReply({
                content: "❌ An internal network error occurred connecting to the FruitsHub gateway. Please try again shortly."
            });
        }
    }
};
