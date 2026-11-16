import { PassThrough, Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { render as inkRender } from "ink";
import type { ReactNode } from "react";
import { createStdin } from "../input/stdin.ts";

/** A terminal's input, as a stream tests write keys and mouse reports to. */
export const createTestInput = (isTTY = true) =>
  Object.assign(new PassThrough(), {
    isTTY,
    isRaw: false,
    setRawMode(mode: boolean) {
      this.isRaw = mode;
      return this;
    },
    ref() {
      return this;
    },
    unref() {
      return this;
    }
  });

const createOutput = ({ columns, rows }: { columns: number; rows: number }) => {
  const frames: string[] = [];
  const writes: string[] = [];
  return Object.assign(
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        const frame = chunk.toString();
        writes.push(frame);
        // Mouse and keyboard negotiation is output, not a frame; Ink also writes empty chunks.
        if (stripVTControlCharacters(frame)) frames.push(frame);
        callback();
      }
    }),
    { columns, rows, isTTY: true, frames, writes, lastFrame: () => frames.at(-1) }
  );
};

/** Quiet the output has to keep before the screen counts as idle. */
const IDLE_MS = 30;

const mounted = new Set<() => void>();

/** Unmounts everything {@link render} mounted. Call it after each test. */
export const cleanup = () => {
  for (const unmount of [...mounted]) unmount();
};

/** An SGR mouse report, from 0-based cells. */
export const mouse = (
  type: "down" | "up" | "move" | "drag" | "wheelUp" | "wheelDown",
  x: number,
  y: number,
  button: 0 | 1 | 2 = 0
) => {
  const code =
    type === "wheelUp"
      ? 64
      : type === "wheelDown"
        ? 65
        : type === "move"
          ? 35
          : type === "drag"
            ? 32 + button
            : button;
  return `\x1b[<${code};${x + 1};${y + 1}${type === "up" ? "m" : "M"}`;
};

/**
 * Renders a tree the way an app does — through {@link createStdin}, into a terminal of the size
 * given — and drives it: write keys and {@link mouse} reports to `stdin`, then `await idle()`.
 */
export const render = (tree: ReactNode, { columns = 100, rows = 24 } = {}) => {
  const stdin = createTestInput();
  const filtered = createStdin(stdin);
  const stdout = createOutput({ columns, rows });
  const stderr = createOutput({ columns, rows });
  const instance = inkRender(tree, {
    stdin: filtered as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false
  });
  const unmount = () => {
    mounted.delete(unmount);
    instance.unmount();
    instance.cleanup();
    filtered.destroy();
    stdin.destroy();
  };
  mounted.add(unmount);

  /**
   * Resolves once everything written to `stdin` has reached Ink and the renders it set off have
   * stopped. A pending Escape, and async work of the app's own, need an assertion on their result.
   */
  const idle = async () => {
    await instance.waitUntilRenderFlush();
    const pending = () => stdin.readableLength > 0 || filtered.writableLength > 0;
    for (;;) {
      while (pending()) await new Promise((resolve) => setImmediate(resolve));
      const writes = stdout.writes.length;
      await new Promise((resolve) => setTimeout(resolve, IDLE_MS));
      if (!pending() && stdout.writes.length === writes) {
        await instance.waitUntilRenderFlush();
        return;
      }
    }
  };

  /** Writes input and waits for the screen to settle. */
  const write = async (...chunks: string[]) => {
    for (const chunk of chunks) stdin.write(chunk);
    await idle();
  };

  return {
    ...instance,
    unmount,
    /** Unmounts the app and destroys its streams. */
    cleanup: unmount,
    idle,
    write,
    stdin,
    filtered,
    stdout,
    stderr,
    frames: stdout.frames,
    /** The last frame, without its escapes. */
    lastFrame: () => stripVTControlCharacters(stdout.lastFrame() ?? ""),
    /** The last frame as written, escapes and all. */
    lastRawFrame: () => stdout.lastFrame() ?? ""
  };
};
