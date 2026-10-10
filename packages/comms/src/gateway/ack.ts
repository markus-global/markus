/**
 * Acknowledgement normalisation — design §6.3, slice G7.
 *
 * Some platforms demand an ACK inside a hard window (Slack Socket Mode ~3 s,
 * Discord interactions 3 s, Feishu card callbacks 3 s). Two failures are easy to
 * write and hard to notice:
 *
 *  1. **Double-ACK.** A transport acks on receipt *and* arms a safety deadline →
 *     two ACKs for one event. Several platforms treat the second as a protocol
 *     error and drop the connection.
 *  2. **Never-ACK.** The handler is slow (an agent turn takes seconds) and the
 *     ACK rides on it → the platform times out, redelivers, and the user sees a
 *     duplicate answer.
 *
 * One handle per inbound event fixes both: it is **idempotent** (first `ack()`
 * wins, every later call is a no-op) and it can carry a **deadline** so "nobody
 * acked in time" still acks instead of dropping the event.
 */

export interface AckHandle {
  /** Send the platform ACK. Idempotent — only the first call has an effect. */
  ack(): void;
  /** Whether the ACK has been sent. */
  readonly acked: boolean;
}

/** An ACK the caller drives itself (no deadline). */
export function createAck(send: () => void): AckHandle {
  let acked = false;
  return {
    ack(): void {
      if (acked) return;
      acked = true;
      send();
    },
    get acked(): boolean {
      return acked;
    },
  };
}

/**
 * An ACK that fires itself if `deadlineMs` passes without a manual `ack()`.
 * Calling `ack()` first disarms the timer, so exactly one ACK is ever sent.
 *
 * A non-positive/`NaN` deadline means "no usable window" — the ACK is sent
 * immediately rather than left to time out.
 */
export function createDeadlineAck(deadlineMs: number, send: () => void): AckHandle {
  let acked = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const disarm = (): void => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };

  const handle: AckHandle = {
    ack(): void {
      if (acked) return;
      acked = true;
      disarm();
      send();
    },
    get acked(): boolean {
      return acked;
    },
  };

  if (Number.isFinite(deadlineMs) && deadlineMs > 0) {
    timer = setTimeout(() => handle.ack(), deadlineMs);
    // A safety net must never keep the process alive on its own.
    const unref = (timer as { unref?: () => void }).unref;
    if (typeof unref === 'function') unref.call(timer);
  } else {
    handle.ack();
  }

  return handle;
}
