/**
 * What a notification says.
 *
 * ADR-0017: **bot name and event type only.** No message content, no snippet, no
 * request text, unless the owner turned `preview` on for that device. A
 * notification is handed to Apple, Google or a browser vendor and drawn on a
 * lock screen, so the default is the least it can say and still be worth
 * tapping.
 *
 * The `data` bag is what a tap resolves against the gateway — never an
 * instruction. An approval carries its request id so the app can look it up, and
 * the app answers only if that request is still open and still says what the
 * notification said it did.
 */
import type { PushMessage } from './expo'
import type { InboundKind } from './inbound'
import type { PushType } from './registrations'

/** The notification category the app registers its Allow / Deny actions under. */
export const APPROVAL_CATEGORY = 'hermie.approval'

export interface NotifiableEvent {
  type: PushType
  /** The bot whose chat this is, as the roster spells it. */
  bot: string
  /** The bot's display name, when it has one. */
  botLabel?: string
  /** Canonical session id, so a tap lands on the right chat. */
  sessionId: string
  /**
   * Which kind of conversation that session is, for the app's tap routing.
   *
   * This daemon resumes a profile's CANONICAL Bot Chat and nothing else — see
   * `watcher.ts` — so every event it can report happened in one, and it says
   * so rather than leaving the field out. An absent field means "the notifier
   * did not say", which the app reads by comparing the id instead; saying the
   * true thing is cheaper than making it work that out.
   */
  sessionKind?: 'canonical' | 'branch' | 'other'
  /** `request` only: the server request's id, re-validated by the app before anything is answered. */
  requestId?: string
  /** `request` only: `approval`, `clarify`, … */
  requestMethod?: string
  /** `dm` — the sender; `cron` — the job. */
  name?: string
  /** True for anything raised inside a scheduled run, whatever its type. */
  cron?: boolean
  /**
   * Whether "this was a scheduled run" is a FACT or a guess.
   *
   * The plugin's word, and the app reads it off the payload under this name.
   * The three cron types say which switch a notification answers to; this says
   * whether the sentence is allowed to claim a scheduled run at all.
   *
   * A notifier recognises a cron run by whatever signal it has. Some are facts
   * — this daemon's are, because the two headers it matches are fixed text the
   * scheduler writes and the job name is the only variable in them. Some are
   * not: the plugin's last resort is the session's `platform` string, which is
   * free text, and a match on it is a guess.
   *
   * Absent means the notifier did not say, which is every payload sent before
   * the field existed and is read as the fact it was always treated as.
   * Explicit `false` is the one that changes the wording — see `summaryOf`.
   */
  cronCertain?: boolean
  /**
   * The scheduler's own id for the job, where the notifier has one.
   *
   * Carried and never PRINTED. It is an id, and a lock screen that says
   * `cron “8f3a-…” reported` has told the reader less than "a cron job
   * reported" would have. The name is what goes in the sentence, and where
   * there is no name there is no name.
   */
  jobId?: string
  /**
   * `cron` — the run failed rather than reported.
   *
   * Kept beside the three cron TYPES rather than replaced by them, because the
   * two say different things: the type is which switch this answers to, and
   * this is what the sentence on the lock screen has to say. A device that
   * asked only for the coarse `cron` still receives a failure, and it should
   * still be told it was one.
   */
  failed?: boolean
  /** The text, carried only to devices that asked for it. */
  preview?: string
  /**
   * Which gateway sent this, as `gatewayKeyOf` its origin.
   *
   * A device can be set up against several gateways, and a notification that
   * says only "researcher" leaves an app with two `researcher`s to guess. The
   * key is derived from the gateway's own address and is therefore something
   * two programs arrive at independently — see `./gateway-key.ts` for the
   * algorithm, for the second copy of it, and for why it is not a secret.
   *
   * **The gateway plugin sends the same field.** A payload without it is a
   * notifier that predates this, and the app reads it exactly as it always
   * did: open that chat on the gateway that is live.
   */
  gatewayKey?: string
}

/** A short, safe line. Long enough to be useful, short enough not to be a transcript. */
const PREVIEW_LIMIT = 120

export function trimPreview(text: string, limit = PREVIEW_LIMIT): string {
  const single = text.replace(/\s+/gu, ' ').trim()

  return single.length > limit ? `${single.slice(0, limit - 1)}…` : single
}

const titleOf = (event: NotifiableEvent): string => event.botLabel || event.bot

/** The line a device that asked for no preview sees. */
function summaryOf(event: NotifiableEvent): string {
  switch (event.type) {
    case 'message':
      return 'sent you a message'

    case 'dm':
      return event.name ? `heard from ${event.name}` : 'heard from another bot'

    case 'cron':
    case 'cron_done':
    case 'cron_failed':
      /*
        A GUESSED cron is worded as what it certainly is: a bot wrote something.

        Saying "cron “Morning digest” failed" when the only evidence was a
        free-text platform string is a notification telling the reader a thing
        nobody knows — and the reader has no way to tell that sentence from one
        backed by the scheduler's own header. An ordinary message notification
        is the weaker claim and it is true either way: something arrived in that
        chat, which is exactly what a tap will show.
      */
      if (event.cronCertain === false) {
        return summaryOf({ ...event, type: 'message' })
      }

      if (event.failed || event.type === 'cron_failed') {
        return event.name ? `cron “${event.name}” failed` : 'a cron run failed'
      }

      return event.name ? `cron “${event.name}” reported` : 'a cron job reported'

    case 'request':
      return event.requestMethod === 'clarify' ? 'has a question for you' : 'is waiting for your approval'
  }
}

/**
 * Build the notification for one event, at one device's preview setting.
 *
 * `preview` is deliberately a parameter rather than a property of the event: the
 * same event goes to a phone that wants the text and a watch that does not, and
 * the decision belongs to the registration, not to what happened.
 */
export function pushMessageFor(event: NotifiableEvent, preview: boolean): PushMessage {
  const summary = summaryOf(event)
  const body = preview && event.preview ? trimPreview(event.preview) : summary

  return {
    title: titleOf(event),
    body,
    data: {
      bot: event.bot,
      type: event.type,
      /*
        Both spellings. `session` is what this daemon has always written and
        what a build of the app older than the plugin reads; `sessionId` is the
        plugin's, and therefore the one the app now reads first. Writing one of
        them would break a pairing that works today in whichever direction was
        chosen, and the field is a short string.
      */
      session: event.sessionId,
      sessionId: event.sessionId,
      ...(event.sessionKind ? { sessionKind: event.sessionKind } : {}),
      /*
        The plugin's three cron fields, under the plugin's own names, so the app
        reads one shape whichever notifier sent it. Omitted rather than written
        empty or false, because a reader of a payload checks for absence — and
        `cronCertain: false` has to mean "this is a guess" rather than "nobody
        filled this in".
      */
      ...(event.cron ? { cron: true } : {}),
      ...(typeof event.cronCertain === 'boolean' ? { cronCertain: event.cronCertain } : {}),
      ...(event.jobId ? { jobId: event.jobId } : {}),
      ...(event.requestId ? { request: event.requestId } : {}),
      ...(event.requestMethod ? { method: event.requestMethod } : {}),
      // Omitted rather than empty, so a reader checks for absence rather than
      // for a falsy value it would then have to decide about.
      ...(event.gatewayKey ? { gatewayKey: event.gatewayKey } : {})
    },
    // Only an approval has anything to act on from the notification itself, and
    // even then the action is a hint: the app re-reads the open requests first.
    ...(event.type === 'request' && event.requestMethod === 'approval' ? { categoryId: APPROVAL_CATEGORY } : {})
  }
}

/** The event type a turn's inbound row implies. */
export function typeForInbound(kind: InboundKind): PushType {
  return kind === 'cron' ? 'cron' : kind === 'dm' ? 'dm' : 'message'
}

/**
 * The type a FINISHED turn answers to, which for a scheduled run is finer.
 *
 * A cron turn ending is two facts at once — the routine reported, and the run
 * ended this way — and the payload names the finer of the two so that a device
 * which asked only about failures can be told about a failure and about
 * nothing else. The coarse `cron` switch still reaches the same notification;
 * `registrationsForAny` is where the two audiences are joined, and it is there
 * rather than here because this function is about naming the fact, not about
 * who hears it.
 */
export function typeForTurn(kind: InboundKind, failed: boolean): PushType {
  if (kind !== 'cron') {
    return typeForInbound(kind)
  }

  return failed ? 'cron_failed' : 'cron_done'
}
