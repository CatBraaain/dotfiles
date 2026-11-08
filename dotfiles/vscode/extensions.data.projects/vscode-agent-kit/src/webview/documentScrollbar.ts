const MIN_THUMB_HEIGHT_PX = 24;
const SCROLL_IDLE_MS = 800;
const KEYBOARD_STEP_PX = 40;

export function initDocumentScrollbar(): () => void {
  const app = document.getElementById("app");
  const scrollingElement = document.scrollingElement;
  if (app === null || scrollingElement === null) {
    throw new Error("Sessions document scroll container is missing.");
  }

  const track = document.createElement("div");
  track.className = "session-scrollbar";
  track.tabIndex = 0;
  track.setAttribute("role", "scrollbar");
  track.setAttribute("aria-label", "Sessions scroll position");
  track.setAttribute("aria-controls", "app");
  track.setAttribute("aria-orientation", "vertical");
  track.setAttribute("aria-valuemin", "0");
  const thumb = document.createElement("div");
  thumb.className = "session-scrollbar-thumb";
  thumb.setAttribute("aria-hidden", "true");
  track.append(thumb);
  document.body.append(track);
  document.documentElement.classList.add("session-overlay-scrollbars");

  let frame = 0;
  let idleTimer = 0;
  let drag: { pointerId: number; grabFraction: number } | undefined;

  function metrics() {
    const trackHeight = document.documentElement.clientHeight;
    const scrollHeight = scrollingElement!.scrollHeight;
    const scrollRange = Math.max(0, scrollHeight - trackHeight);
    const thumbHeight = Math.min(
      trackHeight,
      Math.max(MIN_THUMB_HEIGHT_PX, (trackHeight * trackHeight) / scrollHeight),
    );
    return { scrollRange, thumbHeight, travel: trackHeight - thumbHeight };
  }

  function update() {
    frame = 0;
    const { scrollRange, thumbHeight, travel } = metrics();
    track.hidden = scrollRange === 0;
    track.setAttribute("aria-valuemax", String(scrollRange));
    const scrollTop = Math.max(0, Math.min(scrollRange, scrollingElement!.scrollTop));
    track.setAttribute("aria-valuenow", String(Math.round(scrollTop)));
    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translateY(${scrollRange === 0 ? 0 : (scrollTop / scrollRange) * travel}px)`;
    if (track.hidden) endDrag();
  }

  function scheduleUpdate() {
    if (frame === 0) frame = requestAnimationFrame(update);
  }

  function onScroll() {
    track.dataset.scrolling = "true";
    window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => {
      delete track.dataset.scrolling;
    }, SCROLL_IDLE_MS);
    scheduleUpdate();
  }

  function scrollToPointer(clientY: number, grabFraction: number) {
    const { scrollRange, thumbHeight, travel } = metrics();
    const thumbTop = clientY - track.getBoundingClientRect().top - thumbHeight * grabFraction;
    scrollingElement!.scrollTop = travel > 0 ? (thumbTop / travel) * scrollRange : 0;
    scheduleUpdate();
  }

  function onPointerDown(event: PointerEvent) {
    if (!event.isPrimary || event.button !== 0 || drag !== undefined) return;
    event.preventDefault();
    track.focus({ preventScroll: true });
    if (event.target === thumb) {
      const bounds = thumb.getBoundingClientRect();
      drag = {
        pointerId: event.pointerId,
        grabFraction: (event.clientY - bounds.top) / bounds.height,
      };
      track.dataset.dragging = "true";
      track.setPointerCapture(event.pointerId);
    } else {
      scrollToPointer(event.clientY, 0.5);
    }
  }

  function onPointerMove(event: PointerEvent) {
    if (drag?.pointerId === event.pointerId) scrollToPointer(event.clientY, drag.grabFraction);
  }

  function endDrag() {
    const pointerId = drag?.pointerId;
    drag = undefined;
    delete track.dataset.dragging;
    if (pointerId !== undefined && track.hasPointerCapture(pointerId)) {
      track.releasePointerCapture(pointerId);
    }
  }

  function onPointerEnd(event: PointerEvent) {
    if (event.pointerId === drag?.pointerId) endDrag();
  }

  function onKeyDown(event: KeyboardEvent) {
    const { scrollRange } = metrics();
    const pageStep = document.documentElement.clientHeight;
    const destinations: Record<string, number> = {
      ArrowUp: scrollingElement!.scrollTop - KEYBOARD_STEP_PX,
      ArrowDown: scrollingElement!.scrollTop + KEYBOARD_STEP_PX,
      PageUp: scrollingElement!.scrollTop - pageStep,
      PageDown: scrollingElement!.scrollTop + pageStep,
      Home: 0,
      End: scrollRange,
    };
    const destination = destinations[event.key];
    if (destination === undefined) return;
    event.preventDefault();
    scrollingElement!.scrollTop = destination;
    scheduleUpdate();
  }

  const resizeObserver = new ResizeObserver(scheduleUpdate);
  resizeObserver.observe(app);
  const mutationObserver = new MutationObserver(scheduleUpdate);
  mutationObserver.observe(app, {
    attributes: true,
    childList: true,
    subtree: true,
    characterData: true,
  });
  document.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", scheduleUpdate);
  window.addEventListener("blur", endDrag);
  track.addEventListener("pointerdown", onPointerDown);
  track.addEventListener("pointermove", onPointerMove);
  track.addEventListener("pointerup", onPointerEnd);
  track.addEventListener("pointercancel", onPointerEnd);
  track.addEventListener("lostpointercapture", onPointerEnd);
  track.addEventListener("keydown", onKeyDown);
  update();

  return () => {
    endDrag();
    cancelAnimationFrame(frame);
    window.clearTimeout(idleTimer);
    resizeObserver.disconnect();
    mutationObserver.disconnect();
    document.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", scheduleUpdate);
    window.removeEventListener("blur", endDrag);
    track.remove();
    document.documentElement.classList.remove("session-overlay-scrollbars");
  };
}
