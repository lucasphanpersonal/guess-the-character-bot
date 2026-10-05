// The fake interactions keep Discord's acknowledgement rules (test/harness.js strictAcks), so a
// handler that replies twice, or follows up before replying, fails here instead of in Discord.

const { assert, createRecorder, createFakeClient, createButtonInteraction, createSlashInteraction } = require('./harness');

const make = (factory) => {
  const recorder = createRecorder();
  return factory({ client: createFakeClient(recorder), userId: 'u', customId: 'x:y', recorder, guildId: 'g', channelId: 'c' });
};

module.exports = {
  async 'a second acknowledgement throws, as it does in Discord'() {
    for (const factory of [createButtonInteraction, createSlashInteraction]) {
      const i = make(factory);
      await i.reply({ content: 'one' });
      await assert.rejects(() => i.reply({ content: 'two' }), /AlreadyReplied/);
    }
    const b = make(createButtonInteraction);
    await b.deferUpdate();
    await assert.rejects(() => b.update({ content: 'late' }), /AlreadyReplied/);
  },

  async 'a follow-up before any acknowledgement throws'() {
    const i = make(createButtonInteraction);
    await assert.rejects(() => i.followUp({ content: 'too early' }), /NotReplied/);
    await i.deferUpdate();
    await i.followUp({ content: 'fine now' });
    assert.equal(i.deferred, true);
  },
};
