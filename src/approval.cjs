// The human gate: a validated candidate becomes a confirmed record, or nothing.
//
// The candidate is saved as an *unconfirmed row in the same table*, marked by its own
// boolean. Whether a record has been approved is a property of the record, and keeping it a
// separate column makes "skip unapproved rows" one predicate that the reminder query and
// every listing apply — rather than a value buried in some other enum where it is possible
// to forget.
//
// Reject deletes the row. No rejected-history is kept, so resubmitting a rejected link runs
// the full call again; accepted as a simplification.

const { approvalCard, approvalButtons, parseEdit } = require('./core/card.cjs');

function createApproval({ store, telegram, zone, chatId }) {
  async function present(candidate) {
    const id = store.insertCandidate(candidate);
    await sendCard(id);
    return id;
  }

  async function sendCard(id) {
    const opportunity = store.getOpportunity(id);
    await telegram.sendMessage(chatId, approvalCard(opportunity, { zone }), {
      replyMarkup: approvalButtons(id),
    });
  }

  async function handleCallback({ action, opportunityId, chatId: from, messageId }) {
    const opportunity = store.getOpportunity(opportunityId);
    if (!opportunity) {
      await telegram.sendMessage(from ?? chatId, 'That record is already gone.');
      return;
    }
    if (opportunity.confirmed) {
      await telegram.sendMessage(from ?? chatId, `Already tracking: ${opportunity.title}`);
      return;
    }

    // Take the buttons off first, so a second press cannot act on a record that has just
    // been approved or deleted.
    if (messageId) await telegram.clearButtons(from ?? chatId, messageId);

    if (action === 'approve') {
      store.confirmOpportunity(opportunityId);
      await telegram.sendMessage(from ?? chatId, `Tracking: ${opportunity.title}`);
      return;
    }

    if (action === 'reject') {
      store.deleteOpportunity(opportunityId);
      await telegram.sendMessage(from ?? chatId, 'Discarded.');
      return;
    }

    await telegram.sendMessage(from ?? chatId, `I don't know how to ${action}.`);
  }

  // A correction, sent as `<id> <field> = <value>`. It names the row it applies to, so there
  // is no pending-edit state to keep and a restart between the card and the correction
  // loses nothing.
  async function handleText({ text }) {
    const edit = parseEdit(text, { zone });
    if (!edit) return false;

    const opportunity = store.getOpportunity(edit.opportunityId);
    if (!opportunity) {
      await telegram.sendMessage(chatId, `There is no record ${edit.opportunityId}.`);
      return true;
    }
    if (opportunity.confirmed) {
      await telegram.sendMessage(chatId, 'That record is already approved; edit it in the web view.');
      return true;
    }
    if (edit.error) {
      await telegram.sendMessage(chatId, edit.error);
      return true;
    }

    store.updateOpportunity(edit.opportunityId, edit.changes);
    await sendCard(edit.opportunityId);
    return true;
  }

  return { present, sendCard, handleCallback, handleText };
}

module.exports = { createApproval };
