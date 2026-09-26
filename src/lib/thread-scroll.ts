// src/lib/thread-scroll.ts
//
// Scroll-to-bottom behaviour for the Conversations thread, as a small
// DOM-independent state machine (unit-tested in thread-scroll.test.ts) plus the
// React glue in use-thread-scroll.ts.
//
// The scroll owner in inbox.tsx is the `.conversation-thread-body` element
// (`min-h-0 flex-1 overflow-y-auto`, a flex child of `.conversation-thread-pane`
// which is `flex min-h-0 flex-col`) — NOT the window and not an element inside
// the messages. So every scroll operation targets that element.
//
// Behaviour:
//   - opening or switching a conversation: jump to the latest message and start
//     "following"
//   - while following, any growth of the content (new message, late layout,
//     the sent message appearing) or shrink of the viewport (composer growing)
//     keeps the view pinned to the bottom
//   - if the reader scrolls away from the bottom, following stops: incoming
//     messages never yank them down. Scrolling back to the bottom (within
//     NEAR_BOTTOM_PX) resumes following
//   - sending a message re-enables following
//
// Scrolling is instant (`behavior: "auto"`) on purpose: a smooth animation emits
// intermediate scroll events that look like the user scrolling away and would
// cancel following mid-animation.

export const NEAR_BOTTOM_PX = 96;

export type ScrollElLike = {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
  scrollTo(options: { top: number; behavior?: "auto" | "instant" | "smooth" }): void;
};

export function isNearBottom(el: Pick<ScrollElLike, "scrollHeight" | "scrollTop" | "clientHeight">, threshold = NEAR_BOTTOM_PX): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

export type ThreadScroller = {
  /** The scroll container mounted (or unmounted, with null). May happen after setConversation. */
  attach(el: ScrollElLike | null): void;
  /** A conversation was opened or switched: start at the latest message and follow. */
  setConversation(key: string | undefined): void;
  /** Content height or viewport height changed (ResizeObserver / message list change). */
  contentChanged(): void;
  /** The container's own `scroll` event. */
  userScrolled(): void;
  /** The user just sent a message: follow it to the bottom. */
  followNext(): void;
  isFollowing(): boolean;
};

export function createThreadScroller(opts: { threshold?: number } = {}): ThreadScroller {
  const threshold = opts.threshold ?? NEAR_BOTTOM_PX;
  let el: ScrollElLike | null = null;
  let key: string | undefined;
  let following = true;
  let pendingInitialJump = false;
  let lastJumpTop: number | null = null;

  const jump = () => {
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
    lastJumpTop = el.scrollTop;
  };

  return {
    attach(next) {
      el = next;
      lastJumpTop = null;
      if (el && pendingInitialJump) {
        pendingInitialJump = false;
        jump();
      }
    },
    setConversation(nextKey) {
      if (nextKey === key) return;
      key = nextKey;
      following = true;
      if (!el) {
        pendingInitialJump = true; // container not mounted yet: jump as soon as it is
        return;
      }
      jump();
    },
    contentChanged() {
      if (following) jump();
    },
    userScrolled() {
      if (!el) return;
      // Our own jump fires a scroll event too; it must not be read as the user
      // moving away (content may have grown between the jump and the event).
      if (lastJumpTop !== null && Math.abs(el.scrollTop - lastJumpTop) < 2) return;
      following = isNearBottom(el, threshold);
    },
    followNext() {
      following = true;
      jump();
    },
    isFollowing: () => following,
  };
}
