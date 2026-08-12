// Curating by name rather than by hunting.
//
// Once the top N is on by default, what is left is exceptions: one show this server is sick
// of, one obscure favourite they want in. Finding either on the checkbox page means paging
// through hundreds of names; autocomplete finds it in three keystrokes. This is the command
// that makes /list select optional.

const { MessageFlags } = require('discord.js');
const {
  getListByName,
  toggleListEnabled,
  searchListNames,
  countDistinctCharacters,
} = require('../../../core/db/characterLists');
const { requireManageGuild } = require('../../util/permissions');

module.exports = {
  async execute(interaction) {
    if (!interaction.guildId) {
      return interaction.reply({ content: 'This command must be used in a server.', flags: MessageFlags.Ephemeral });
    }
    if (!(await requireManageGuild(interaction))) return;

    const name = interaction.options.getString('list').trim();
    const list = getListByName(interaction.guildId, name);
    if (!list) {
      return interaction.reply({
        content: `No list named **${name}**. Start typing for autocomplete suggestions.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const enabled = toggleListEnabled(list.id);
    const characters = countDistinctCharacters([list.id]);
    // Public, unlike the /list select page: this changes what everyone plays with, and one
    // line in the channel is how the rest of the server finds out.
    return interaction.reply(
      enabled
        ? `✅ **${list.name}** is now in the pool (${characters} characters).`
        : `⬜ **${list.name}** is out of the pool. Naming it directly with \`list:\` still works.`
    );
  },
  async autocomplete(interaction) {
    const query = interaction.options.getFocused();
    const names = searchListNames(interaction.guildId, query, 25);
    // The current state and the category both ride along in the label: the state so you can
    // see what a toggle will do before committing, and the category so picking one list out
    // of two thousand doesn't require remembering which shelf it lives on.
    const choices = names.map((n) => {
      const list = getListByName(interaction.guildId, n);
      const mark = list?.enabled === 1 ? '✅' : '⬜';
      const where = list?.category ? ` — ${list.category}` : '';
      const label = `${mark} ${n}${where}`;
      return { name: label.length > 100 ? `${label.slice(0, 99)}…` : label, value: n.slice(0, 100) };
    });
    return interaction.respond(choices);
  },
};
