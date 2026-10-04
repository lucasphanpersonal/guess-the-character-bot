// Argument handling shared by the content scripts (seeding, image fills, backfills).
//
// These scripts used to take a Discord guild id first, because every list was filed under one
// server. They now work on the SHARED compendium, which every scope sees (src/compendium). An old
// invocation still passes that id, and reading it as anything else would be worse than useless --
// seed-pokemon-list.js would take it for the list name -- so a leading all-digits argument (the
// shape of a Discord snowflake) is dropped with a note instead.

function dropLegacyGuildArg(args) {
  if (args.length && /^\d{15,}$/.test(args[0])) {
    console.warn(
      `Note: ignoring "${args[0]}". Content scripts no longer take a Discord server id; ` +
        'they work on the shared compendium every server and the web app see.'
    );
    return args.slice(1);
  }
  return args;
}

/** The script's arguments, minus `node script.js` and any legacy guild id. */
const scriptArgs = () => dropLegacyGuildArg(process.argv.slice(2));

module.exports = { dropLegacyGuildArg, scriptArgs };
