import type { Instance } from "ink";

const BEGIN_SYNC = "\x1b[?2026h";
const END_SYNC = "\x1b[?2026l";
const HOME_AND_ERASE = "\x1b[H\x1b[2J";
/** The longest a repaint holds the screen back, should its frame never come. */
const SYNC_TIMEOUT = 250;

export type RepaintStdout = Pick<NodeJS.WriteStream, "write" | "prependListener" | "off">;

/**
 * Repaints the alternate screen from its top-left corner whenever the terminal resizes, rather
 * than letting Ink diff the next frame against the one it last drew.
 *
 * Ink draws each frame by moving the cursor relative to where the last one left it and rewriting
 * only the rows that changed, which takes the screen to hold that last frame, row for row. A
 * resize breaks that. A terminal that loses rows scrolls the frame up to keep the cursor on screen
 * and does not scroll it back when it gains them; one that reflows rewraps it; and a frame drawn
 * before the app heard of the new size lands at the old one. Nor does the app hear of every size:
 * resizes that come faster than it reads them arrive as one, the last, so a drag that shrank the
 * window and grew it back may report only the growth, or nothing at all. Every case leaves rows
 * that the next diff skips as unchanged, which stay where the terminal moved them: gaps, and
 * stale copies of the frame.
 *
 * So after a resize nothing on screen is trusted. The frame Ink remembers is forgotten, the screen
 * is erased from the corner the frame starts at, and the next frame is drawn whole. On the
 * alternate screen that costs one frame, as nothing scrolls back; the erase opens a synchronized
 * update that the frame closes, so the terminal shows the two at once. Every other frame is still
 * a diff.
 *
 * Ink hears of a size change from stdout's `resize`, after which it draws a frame, so the repaint
 * runs ahead of it. A resize the app never saw a new size for still raises `SIGWINCH`, and that
 * one draws the frame itself with `rerender`. Returns a function that stops repainting.
 */
export const repaintOnResize = ({
  instance,
  stdout,
  rerender
}: {
  instance: Pick<Instance, "clear">;
  stdout: RepaintStdout;
  /** Draws the frame again where the size did not change, so Ink has no `resize` to draw it on. */
  rerender: () => void;
}) => {
  let sync: ReturnType<typeof setTimeout> | undefined;
  let repainted = false;
  let signalled = false;

  const endSync = () => {
    if (sync === undefined) return;
    clearTimeout(sync);
    sync = undefined;
    stdout.write(END_SYNC);
  };

  const repaint = () => {
    stdout.write(BEGIN_SYNC);
    instance.clear();
    stdout.write(HOME_AND_ERASE);
    // The frame ends the update itself; this only lets the screen go should it never come.
    clearTimeout(sync);
    sync = setTimeout(endSync, SYNC_TIMEOUT);
    sync.unref?.();
  };

  const onResize = () => {
    repaint();
    // Node emits `resize` from its own `SIGWINCH` handler, ahead of or behind the one below. The
    // flag tells that one the repaint is done, and is let go of only after it has looked.
    repainted = true;
    setTimeout(() => {
      repainted = false;
    }, 0);
  };

  const onSignal = () => {
    if (signalled) return;
    signalled = true;
    setImmediate(() => {
      signalled = false;
      if (repainted) return;
      repaint();
      rerender();
    });
  };

  stdout.prependListener("resize", onResize);
  // Windows has no such signal; its resizes all come as `resize`.
  const signals = process.platform !== "win32";
  if (signals) process.on("SIGWINCH", onSignal);

  return () => {
    stdout.off("resize", onResize);
    if (signals) process.off("SIGWINCH", onSignal);
    endSync();
  };
};
