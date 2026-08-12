// The "🚫 Never deal this show" button on the confirmation DM.
//
// It exists because the moment somebody is staring at a character they don't recognise is
// the only moment they will ever want to curate -- so the button both drops the list and
// rerolls, rather than leaving the curating for later (which nobody does).

const { assert, createRecorder, createFakeClient, createButtonInteraction } = require('./harness');
const engine = require('../src/discord/game/engine');
const confirmPhase = require('../src/discord/game/confirmPhase');
const Lobby = require('../src/core/game/Lobby');
const GameManager = require('../src/core/game/GameManager');
const lists = require('../src/core/db/characterLists');
const db = require('../src/core/db/connection');

let counter = 0;

// Two lists so dropping one still leaves something to reroll into.
async function startedGame({ maxRerolls = 2, secondList = true, p2Freeform = false, canManageGuild = true } = {}) {
  const n = ++counter;
  const guildId = `drop-guild-${n}`;
  const channelId = `drop-chan-${n}`;
  db.prepare('DELETE FROM character_lists WHERE guild_id = ?').run(guildId);

  const obscure = lists.createList(guildId, 'Obscure Show', 'tester', 'Anime', { enabled: true });
  for (const name of ['Nobody One', 'Nobody Two']) lists.addCharacter(obscure, name, 'tester');

  const listIds = [obscure];
  let known = null;
  if (secondList) {
    known = lists.createList(guildId, 'Known Show', 'tester', 'Anime', { enabled: true });
    for (const name of ['Famous One', 'Famous Two']) lists.addCharacter(known, name, 'tester');
    listIds.push(known);
  }

  const recorder = createRecorder();
  const client = createFakeClient(recorder);
  if (canManageGuild) {
    client.guilds.fetch = async () => ({
      members: {
        fetch: async (id) => (id === 'p1' ? { permissions: { has: () => true } } : null),
      },
    });
  }
  const lobby = new Lobby({
    guildId,
    channelId,
    hostId: 'p1',
    listIds,
    listNames: ['Obscure Show', 'Known Show'],
    turnSeconds: 90,
    maxRerolls,
    difficulty: 'everything',
  });
  lobby.addPlayer('p1');
  lobby.addPlayer('p2');
  GameManager.createLobby(channelId, lobby);

  // p2's head is the obscure character, so p1 (who sees it) is the one who reacts to it.
  // Hand-picked-with-no-match (/lobby set-characters, or the board modal) lands here too --
  // it's a row shaped exactly like this, with id and list_id both null.
  const obscureRow = p2Freeform ? lists.freeformCharacter('Made-Up Guy') : lists.drawablePool([obscure], 'everything')[0];
  const knownRow = secondList ? lists.drawablePool([known], 'everything')[0] : obscureRow;
  await engine.startGame(client, lobby, [knownRow, obscureRow]);

  return { lobby, client, recorder, channelId, guildId, obscure, known };
}

const press = ({ client, recorder, channelId, userId, action }) =>
  confirmPhase.handleConfirmationButton(
    createButtonInteraction({ client, userId, customId: `${action}:${channelId}`, recorder })
  );

module.exports = {
  async 'the confirmation DM offers the drop button alongside Reroll'() {
    const { recorder, channelId } = await startedGame();
    const dm = recorder.sent.find((m) => m.target === 'dm:p1');
    const ids = dm.payload.components[0].toJSON().components.map((c) => c.custom_id);
    
    // Extract gameInstanceId from the customId format (last segment after ':')
    const gameInstanceId = ids[0].split(':')[2];
    
    assert.deepEqual(ids, [
      `confirm:${channelId}:${gameInstanceId}`,
      `reroll:${channelId}:${gameInstanceId}`,
      `droplist:${channelId}:${gameInstanceId}`,
      `image:${channelId}:${gameInstanceId}`,
    ]);
    GameManager.endLobby(channelId);
  },

  async 'dropping switches the list off server-wide and rerolls in one press'() {
    const { lobby, client, recorder, channelId, guildId, obscure } = await startedGame();
    const before = lobby.game.headByPlayer.p2.name;

    await press({ client, recorder, channelId, userId: 'p1', action: 'droplist' });

    assert.equal(
      lists.getListsByIds([obscure])[0].enabled,
      0,
      'the list is out of the pool for future lobbies'
    );
    assert.notEqual(lobby.game.headByPlayer.p2.name, before, 'and the character was rerolled');
    assert.match(lobby.game.headByPlayer.p2.name, /^Famous/, 'replacement came from the other list');
    assert.match(recorder.allText(), /Obscure Show\*\* is out of the pool/);
    assert.match(recorder.allText(), /list toggle/, 'says how to undo it');

    // Naming it directly still works, same as any disabled list.
    assert.ok(lists.getListByName(guildId, 'Obscure Show'));
    GameManager.endLobby(channelId);
  },

  async 'dropping costs a reroll, because it is one'() {
    const { lobby, client, recorder, channelId } = await startedGame({ maxRerolls: 2 });
    await press({ client, recorder, channelId, userId: 'p1', action: 'droplist' });
    assert.equal(lobby.game.confirmState.p1.rerollsLeft, 1);
    GameManager.endLobby(channelId);
  },

  async 'dropping the only list is refused rather than emptying the lobby'() {
    const { lobby, client, recorder, channelId, obscure } = await startedGame({ secondList: false });
    await press({ client, recorder, channelId, userId: 'p1', action: 'droplist' });

    assert.equal(lists.getListsByIds([obscure])[0].enabled, 1, 'nothing was switched off');
    assert.match(recorder.allText(), /would leave nothing else to deal from/);
    assert.equal(lobby.game.confirmState.p1.rerollsLeft, 2, 'and it cost nothing');
    GameManager.endLobby(channelId);
  },

  async 'a player out of rerolls cannot drop either'() {
    const { lobby, client, recorder, channelId, obscure } = await startedGame({ maxRerolls: 0 });
    await press({ client, recorder, channelId, userId: 'p1', action: 'droplist' });

    assert.equal(lists.getListsByIds([obscure])[0].enabled, 1);
    assert.match(recorder.allText(), /out of rerolls/);
    GameManager.endLobby(channelId);
  },

  async 'a player without Manage Server cannot drop a shared list'() {
    const { lobby, client, recorder, channelId, obscure } = await startedGame({ canManageGuild: false });
    const before = lobby.game.headByPlayer.p2.name;

    await press({ client, recorder, channelId, userId: 'p1', action: 'droplist' });

    assert.equal(lists.getListsByIds([obscure])[0].enabled, 1);
    assert.equal(lobby.game.headByPlayer.p2.name, before);
    assert.match(recorder.allText(), /Manage Server permission/);
    GameManager.endLobby(channelId);
  },

  async 'the drop is recorded as a reroll, so it feeds the retirement threshold too'() {
    const { lobby, client, recorder, channelId } = await startedGame();
    const rejected = lobby.game.headByPlayer.p2;
    await press({ client, recorder, channelId, userId: 'p1', action: 'droplist' });
    assert.equal(lists.countRerollers(rejected.id), 1);
    GameManager.endLobby(channelId);
  },

  async 'in audience-vote mode there is nothing to drop'() {
    const { lobby, client, recorder, channelId, obscure } = await startedGame();
    lobby.game.rerollAllowed = false;
    await press({ client, recorder, channelId, userId: 'p1', action: 'droplist' });
    assert.equal(lists.getListsByIds([obscure])[0].enabled, 1);
    assert.match(recorder.allText(), /audience picked this character/);
    GameManager.endLobby(channelId);
  },

  // A hand-picked name with no match in any list -- /lobby set-characters or the board modal,
  // taken literally -- carries no list to drop, so the button offering to isn't shown at all.
  async 'a hand-picked freeform character has no drop button to offer'() {
    const { recorder, channelId } = await startedGame({ p2Freeform: true });
    const dm = recorder.sent.find((m) => m.target === 'dm:p1');
    const ids = dm.payload.components[0].toJSON().components.map((c) => c.custom_id);
    
    // Extract gameInstanceId from the customId format (last segment after ':')
    const gameInstanceId = ids[0].split(':')[2];
    
    assert.deepEqual(ids, [
      `confirm:${channelId}:${gameInstanceId}`,
      `reroll:${channelId}:${gameInstanceId}`,
    ]);
    GameManager.endLobby(channelId);
  },

  // Reroll doesn't route through droplist's list lookup, so a freeform character rerolls
  // exactly like any other -- it just leaves nothing to record the reroll against.
  async 'rerolling away from a freeform character works normally'() {
    const { lobby, client, recorder, channelId } = await startedGame({ p2Freeform: true });
    assert.equal(lobby.game.headByPlayer.p2.name, 'Made-Up Guy');

    await press({ client, recorder, channelId, userId: 'p1', action: 'reroll' });

    assert.notEqual(lobby.game.headByPlayer.p2.name, 'Made-Up Guy');
    assert.match(lobby.game.headByPlayer.p2.name, /^(Nobody|Famous)/, 'replacement drawn from the lobby lists');
    GameManager.endLobby(channelId);
  },

  // Belt and suspenders: even if droplist is somehow reached on a freeform character (the
  // button is hidden, but nothing stops a stale interaction), it refuses cleanly instead of
  // crashing on a null list id.
  async 'pressing drop anyway on a freeform character is refused, not a crash'() {
    const { lobby, client, recorder, channelId } = await startedGame({ p2Freeform: true });
    await press({ client, recorder, channelId, userId: 'p1', action: 'droplist' });
    assert.equal(lobby.game.headByPlayer.p2.name, 'Made-Up Guy', 'nothing changed');
    assert.match(recorder.allText(), /Couldn't tell which list this character came from/);
    GameManager.endLobby(channelId);
  },
};
