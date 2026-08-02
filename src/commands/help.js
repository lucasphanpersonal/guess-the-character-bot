const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder().setName('help').setDescription('How to set up and play Guess the Character'),
  async execute(interaction) {
    const embed = new EmbedBuilder()
      .setTitle('🎮 Guess the Character')
      .setDescription(
        'Two players are each secretly assigned a character only the *other* player (and ' +
          "spectators) can see. Ask yes/no questions out loud in voice to figure out who you " +
          'are, then guess. The bot only tracks turns, timers, and guesses -- all the Q&A ' +
          'happens live in voice chat. If both players share a voice channel, the bot joins in ' +
          'and plays sound effects for the countdown, correct/wrong guesses, and the final win.'
      )
      .addFields(
        {
          name: '1️⃣ Build a character list (one-time setup)',
          value:
            '`/list create` -- start a new list, tagged with a category (e.g. "Anime", "Video Games")\n' +
            '`/list add` -- add a character, optionally with an `image` URL\n' +
            '`/list image` -- attach/update an image on an existing character\n' +
            '`/list remove` -- remove one\n' +
            '`/list show` -- see all lists grouped by category, or one list\'s characters\n' +
            '`/list toggle <list>` -- **switch one list in or out** of what this server plays ' +
            'with. Autocomplete shows ✅/⬜ so you can see what a toggle will do\n' +
            '`/list select top:<n>` -- enable the N best-known lists in every category (or one, ' +
            'with `category:`)\n' +
            '`/list select` -- the full checkbox page, for browsing and bulk changes. Pooled ' +
            'draws only ever use enabled lists, which is how obscure shows stay out of the deal',
        },
        {
          name: '2️⃣ Start a game',
          value:
            '`/lobby create list:<name>` -- open a lobby (comma-separate several list names to ' +
            'draw from a combined pool; optionally set `turn-seconds` and `max-rerolls`, ' +
            '`-1` = unlimited)\n' +
            '`/lobby create category:<name>` -- draw from every **enabled** list in a category ' +
            'at once, e.g. `category:Video Games` for any video game character\n' +
            '`/lobby create everything:true` -- pool **every list in the server**, all ' +
            'categories at once\n' +
            'Or `random:true` to let the bot roll a random category -- 🎲 category roulette\n' +
            'That posts the **lobby board**, which updates itself as people join. Everything ' +
            'else here is a button on it:\n' +
            '**Join** / **Leave** -- two people need to join (the host doesn\'t have to be one ' +
            'of them)\n' +
            '**Spectate** -- opt in to a DM revealing both characters\n' +
            '**Start game** -- host only, stays disabled until 2 players have joined\n' +
            '**⚙️ Settings** / **🗳️ Audience vote** / **🎚️ Difficulty** -- host only: change ' +
            'turn length, rerolls, the vote tuning and how obscure a character can be dealt, ' +
            'without recreating the lobby (locked once the game starts)\n' +
            'The matching `/lobby join`, `/lobby leave`, `/lobby spectate` and `/lobby start` commands ' +
            'still work and keep the board in sync.\n' +
            '`/lobby set-characters` -- host only, optional, no button: assign each player\'s hidden ' +
            "character yourself instead of leaving it random (reply is only visible to you, so " +
            "it won't spoil anything)",
        },
        {
          name: '🗳️ Audience vote mode',
          value:
            'Add `audience-vote:true` to `/lobby create`, or hit the **🗳️ Audience vote** ' +
            'toggle on the lobby board, and the **audience** picks both ' +
            'characters instead of the bot. A vote board appears with a **Vote** button — ' +
            'clicking it gives you a private ballot of candidates for each player. The two ' +
            "players can't vote and never see the options. Tune it with `vote-options` " +
            '(candidates per player) and `vote-seconds`; the host can close voting early.',
        },
        {
          name: '🔍 Confirm your character',
          value:
            "Once the game starts, you'll get a DM showing a character with **Good to go** / " +
            "**Reroll** buttons. If you (or you think the wearer) won't recognize it, reroll " +
            "(however many the host allowed) -- the game waits until both players confirm before " +
            'turn 1 begins.\n' +
            '🚫 **Never deal this show** drops that list from the server for good *and* rerolls, ' +
            "in one press. And once 3 different people have rerolled the same character, the bot " +
            'stops dealing them -- the pool learns from what you reject.',
        },
        {
          name: '3️⃣ On your turn',
          value:
            'A **turn board** appears with a live countdown, your guesses so far, and two ' +
            'rows of buttons -- one per player:\n' +
            '⚖️ **The other player judges.** They can see your character, so when you call a ' +
            'name out loud they hit **✅ They got it** or **❌ Nope**. That is the main way a ' +
            'turn resolves -- you never stop talking to log a guess, and the ❌ button keeps ' +
            'a running count.\n' +
            '⏭️ **Pass** is your only button -- there is no guess box, because the judge ' +
            'already decides whether you got it.\n' +
            "Guessing wrong doesn't end your turn, so guess early and often. Only **Pass**, or " +
            "running out of time, actually hands it over (once time's up the board goes amber " +
            'for one truly last guess).',
        },
        {
          name: '🏆 Winning',
          value:
            'First correct guess wins the game -- unless it was the player who went first that ' +
            "round, in which case the other player gets one rebuttal turn before it's final " +
            '(correct on rebuttal = tie, wrong = the first player wins).',
        },
        {
          name: '✍️ What counts as a correct guess',
          value:
            'Whatever the other player accepts. They can see your character, so they rule on ' +
            'it -- no spelling rules, no typo tolerance, no arguing with a bot about whether ' +
            '"Shikamaru" should have counted.',
        },
        {
          name: '🛠️ Anytime',
          value:
            '`/lobby status` -- whose turn it is and time left\n' +
            '`/lobby end` -- host or admin can cancel a stuck game\n' +
            '`/rematch` -- replay with the same two players (order swapped) once a game finishes\n' +
            '`/leaderboard [player]` -- server win/loss standings, or one player\'s record\n' +
            'The end-of-game reveal also has **Rematch** and **Leaderboard** buttons.',
        }
      );

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
