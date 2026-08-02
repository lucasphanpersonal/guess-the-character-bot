// /help had no test at all, and shipped broken: one field grew past Discord's 1024-character
// limit as features were appended to it, so the command threw for every user while the whole
// suite stayed green. It also went on describing `list:` and `everything:true` for a while
// after those options ceased to exist.
//
// Both failure modes are mechanical, so both are checked here.

const { assert } = require('./harness');
const fs = require('fs');
const path = require('path');

// Discord's embed limits.
const FIELD_VALUE = 1024;
const FIELD_NAME = 256;
const DESCRIPTION = 4096;
const TOTAL = 6000;
const FIELD_COUNT = 25;

async function renderHelp() {
  let payload;
  await require('../src/commands/help').execute({
    reply: async (p) => {
      payload = p;
    },
    options: {},
  });
  return payload.embeds[0].toJSON();
}

// Every command the bot actually registers, including subcommands, as "/lobby create" etc.
function registeredCommands() {
  const names = new Set();
  const dir = path.join(__dirname, '..', 'src', 'commands');
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const command = require(path.join(dir, entry.name));
    if (!command?.data) continue;
    const json = command.data.toJSON();
    names.add(`/${json.name}`);
    for (const option of json.options ?? []) {
      // type 1 is a subcommand.
      if (option.type === 1) names.add(`/${json.name} ${option.name}`);
    }
  }
  return names;
}

module.exports = {
  async 'every embed field fits inside Discord limits'() {
    const embed = await renderHelp();

    assert.ok(embed.fields.length <= FIELD_COUNT, `${embed.fields.length} fields`);
    assert.ok((embed.description ?? '').length <= DESCRIPTION, 'description fits');

    for (const field of embed.fields) {
      assert.ok(
        field.value.length <= FIELD_VALUE,
        `field "${field.name}" is ${field.value.length} characters, over the ${FIELD_VALUE} limit`
      );
      assert.ok(field.name.length <= FIELD_NAME, `field name "${field.name}" too long`);
    }

    const total =
      (embed.title ?? '').length +
      (embed.description ?? '').length +
      embed.fields.reduce((sum, f) => sum + f.name.length + f.value.length, 0);
    assert.ok(total <= TOTAL, `embed totals ${total} characters, over the ${TOTAL} limit`);
  },

  // Renaming a command used to leave /help quietly pointing at something that no longer
  // existed, which is worse than saying nothing.
  async 'every command /help names actually exists'() {
    const embed = await renderHelp();
    const registered = registeredCommands();
    const text = embed.fields.map((f) => `${f.name}\n${f.value}`).join('\n');

    // Matches `/lobby create` and `/pass` inside backticks, ignoring any option suffix.
    const mentioned = new Set();
    for (const [, name] of text.matchAll(/`(\/[a-z-]+(?: [a-z-]+)?)[^`]*`/g)) {
      mentioned.add(name.trim());
    }
    assert.ok(mentioned.size > 5, 'sanity: found command mentions to check');

    for (const name of mentioned) {
      const parent = name.split(' ')[0];
      assert.ok(
        registered.has(name) || registered.has(parent),
        `/help mentions ${name}, which is not a registered command`
      );
    }
  },
};
