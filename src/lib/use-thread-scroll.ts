// React glue for src/lib/thread-scroll.ts. Callback refs (not useRef) so the
// scroller attaches whenever the scroll container actually mounts — in
// inbox.tsx the thread body only exists once `active && contact` resolve, which
// can be AFTER the conversation id first changes (e.g. returning to
// Conversations). A plain ref + effect keyed on the id missed exactly that case.

import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { createThreadScroller } from "@/lib/thread-scroll";

export function useThreadScroll(conversationKey: string | undefined) {
  const scroller = useMemo(() => createThreadScroller(), []);
  const observerRef = useRef<ResizeObserver | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLElement | null>(null);
  const onScrollRef = useRef(() => scroller.userScrolled());

  const observe = useCallback(() => {
    observerRef.current?.disconnect();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => scroller.contentChanged());
    observerRef.current = ro;
    if (containerRef.current) ro.observe(containerRef.current); // viewport shrinks when the composer grows
    if (contentRef.current) ro.observe(contentRef.current); // messages appear / lay out late
  }, [scroller]);

  const setContainer = useCallback(
    (el: HTMLElement | null) => {
      containerRef.current?.removeEventListener("scroll", onScrollRef.current);
      containerRef.current = el;
      if (el) el.addEventListener("scroll", onScrollRef.current, { passive: true });
      scroller.attach(el);
      observe();
    },
    [scroller, observe],
  );
  const setContent = useCallback(
    (el: HTMLElement | null) => {
      contentRef.current = el;
      observe();
    },
    [observe],
  );

  useLayoutEffect(() => {
    scroller.setConversation(conversationKey);
  }, [scroller, conversationKey]);

  useLayoutEffect(
    () => () => {
      observerRef.current?.disconnect();
    },
    [],
  );

  return { containerRef: setContainer, contentRef: setContent, followBottom: scroller.followNext };
}
