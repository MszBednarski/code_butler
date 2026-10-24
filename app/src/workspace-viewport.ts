// Safari pans the visual viewport when the keyboard opens. Keep the workspace
// within that visible area and leave scrolling to its individual panels.
export function attachWorkspaceViewport() {
  const root = document.documentElement;
  const viewport = window.visualViewport;
  let frame = 0;
  function update() {
    frame = 0;
    if (viewport && viewport.scale > 1.01) return;
    root.style.setProperty(
      "--app-height",
      `${viewport?.height || innerHeight}px`,
    );
    root.style.setProperty(
      "--viewport-top",
      `${Math.max(0, viewport?.offsetTop || 0)}px`,
    );
    const editing = document.activeElement?.matches(
      "textarea, input, [contenteditable=true]",
    );
    root.classList.toggle(
      "keyboard-open",
      Boolean(
        (editing || root.classList.contains("keyboard-open")) &&
          innerHeight - (viewport?.height || innerHeight) > 100,
      ),
    );
  }
  function schedule() {
    if (!frame) frame = requestAnimationFrame(update);
  }
  root.classList.add("workspace-open");
  update();
  viewport?.addEventListener("resize", schedule);
  viewport?.addEventListener("scroll", schedule);
  window.addEventListener("resize", schedule);
  document.addEventListener("focusin", schedule);
  document.addEventListener("focusout", schedule);
  return () => {
    cancelAnimationFrame(frame);
    viewport?.removeEventListener("resize", schedule);
    viewport?.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", schedule);
    document.removeEventListener("focusin", schedule);
    document.removeEventListener("focusout", schedule);
    root.classList.remove("workspace-open", "keyboard-open");
    root.style.removeProperty("--app-height");
    root.style.removeProperty("--viewport-top");
  };
}
