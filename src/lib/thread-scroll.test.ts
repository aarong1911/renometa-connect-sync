// src/lib/thread-scroll.test.ts
//
// Run:  node --test src/lib/thread-scroll.test.ts
// Exercises the production scroll state machine (src/lib/thread-scroll.ts — the
// same module use-thread-scroll.ts drives from the real scroll container and a
// ResizeObserver) against a fake scroll element that behaves like a browser:
// scrollTop is clamped to [0, scrollHeight - clientHeight].

import assert from "node:assert/strict";
import test from "node:test";
import { NEAR_BOTTOM_PX, createThreadScroller, isNearBottom } from "./thread-scroll.ts";

class FakeScrollEl {
  scrollTop = 0;
  scrollHeight: number;
  clientHeight: number;
  scrollTo({ top }: { top: number }) {
    this.scrollTop = Math.max(0, Math.min(top, this.scrollHeight - this.clientHeight));
  }
  constructor(scrollHeight: number, clientHeight: number) {
    this.scrollHeight = scrollHeight;
    this.clientHeight = clientHeight;
  }
  get atBottom() {
    return this.scrollHeight - this.scrollTop - this.clientHeight === 0;
  }
  /** Content grows (a message renders); the browser does NOT move scrollTop by itself. */
  grow(by: number) {
    this.scrollHeight += by;
  }
  /** The user drags the scrollbar / wheels; the browser then fires a scroll event. */
  userScrollTo(top: number) {
    this.scrollTop = Math.max(0, Math.min(top, this.scrollHeight - this.clientHeight));
  }
}

test("25. opening a thread scrolls to the latest message", () => {
  const el = new FakeScrollEl(3000, 600);
  const s = createThreadScroller();
  s.attach(el);
  s.setConversation("gm-contact-1");
  assert.equal(el.atBottom, true);
});

test("25b. the container mounting AFTER the conversation id changed still ends at the bottom (return-to-Conversations case)", () => {
  const s = createThreadScroller();
  s.setConversation("gm-contact-1"); // active resolved, but the thread body div is not mounted yet
  const el = new FakeScrollEl(4000, 600);
  s.attach(el); // now it mounts
  assert.equal(el.atBottom, true);
});

test("25c. content that lays out late (empty at open, messages arrive, images/fonts settle) is followed to the bottom", () => {
  const el = new FakeScrollEl(0, 600);
  const s = createThreadScroller();
  s.attach(el);
  s.setConversation("c1"); // nothing rendered yet
  el.grow(2400); // messages render
  s.contentChanged();
  assert.equal(el.atBottom, true);
  el.grow(300); // a late image / web font changes the height
  s.contentChanged();
  assert.equal(el.atBottom, true);
});

test("26. switching conversations jumps to the latest message of the new thread, even if the previous one was scrolled up", () => {
  const el = new FakeScrollEl(3000, 600);
  const s = createThreadScroller();
  s.attach(el);
  s.setConversation("a");
  el.userScrollTo(200);
  s.userScrolled();
  assert.equal(s.isFollowing(), false);
  el.scrollHeight = 5000; // the other thread's messages
  el.scrollTop = 0;
  s.setConversation("b");
  assert.equal(el.atBottom, true);
  assert.equal(s.isFollowing(), true);
  s.setConversation("b"); // same key again is a no-op
  assert.equal(s.isFollowing(), true);
});

test("27. sending follows the bottom even when the user had scrolled up", () => {
  const el = new FakeScrollEl(3000, 600);
  const s = createThreadScroller();
  s.attach(el);
  s.setConversation("a");
  el.userScrollTo(100);
  s.userScrolled();
  assert.equal(s.isFollowing(), false);
  s.followNext(); // handleSend
  el.grow(120); // the sent email appears
  s.contentChanged();
  assert.equal(el.atBottom, true);
});

test("28. an incoming message follows the bottom while the reader is near it", () => {
  const el = new FakeScrollEl(3000, 600);
  const s = createThreadScroller();
  s.attach(el);
  s.setConversation("a");
  el.userScrollTo(el.scrollHeight - el.clientHeight - (NEAR_BOTTOM_PX - 10)); // slightly above the bottom, within the threshold
  s.userScrolled();
  assert.equal(s.isFollowing(), true);
  el.grow(200); // a new inbound reply renders
  s.contentChanged();
  assert.equal(el.atBottom, true);
});

test("29. an incoming message does NOT yank a reader who scrolled up; scrolling back down resumes following", () => {
  const el = new FakeScrollEl(3000, 600);
  const s = createThreadScroller();
  s.attach(el);
  s.setConversation("a");
  el.userScrollTo(500);
  s.userScrolled();
  const before = el.scrollTop;
  el.grow(200);
  s.contentChanged();
  assert.equal(el.scrollTop, before, "position untouched");
  assert.equal(el.atBottom, false);

  el.userScrollTo(el.scrollHeight); // reader goes back to the bottom
  s.userScrolled();
  assert.equal(s.isFollowing(), true);
  el.grow(100);
  s.contentChanged();
  assert.equal(el.atBottom, true);
});

test("29b. the scroll event caused by our own jump is not mistaken for the user scrolling away", () => {
  const el = new FakeScrollEl(3000, 600);
  const s = createThreadScroller();
  s.attach(el);
  s.setConversation("a"); // jump -> the browser fires a scroll event
  el.grow(500); // content grew between the jump and the event being handled
  s.userScrolled();
  assert.equal(s.isFollowing(), true);
});

test("29c. the viewport shrinking (composer grows) keeps a following thread pinned to the bottom", () => {
  const el = new FakeScrollEl(3000, 600);
  const s = createThreadScroller();
  s.attach(el);
  s.setConversation("a");
  el.clientHeight = 450;
  s.contentChanged();
  assert.equal(el.atBottom, true);
});

test("isNearBottom threshold", () => {
  assert.equal(isNearBottom({ scrollHeight: 1000, scrollTop: 400, clientHeight: 500 }), false);
  assert.equal(isNearBottom({ scrollHeight: 1000, scrollTop: 450, clientHeight: 500 }), true);
});
