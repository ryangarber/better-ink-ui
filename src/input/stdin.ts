import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { parseMouse } from "./mouse.ts";

const ESC = "\x1b";
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;
const PASTE_ENDINGS = [PASTE_END, "\xc2\x9b201~", "\x9b201~"];
const ESCAPE_DELAY = 20;
const MAX_SEQUENCE = 1024;

/** Byte length of a UTF-8 code point (invalid leading bytes stand alone). */
const utf8Length = (byte: number) =>
  byte >= 0xc2 && byte <= 0xdf
    ? 2
    : byte >= 0xe0 && byte <= 0xef
      ? 3
      : byte >= 0xf0 && byte <= 0xf4
        ? 4
        : 1;

/** An invalid UTF-8 lead must not swallow the escape/control byte after it. */
const utf8Size = (bytes: string, index: number) => {
  const length = utf8Length(bytes.charCodeAt(index));
  for (let i = 1; i < length && index + i < bytes.length; i++) {
    const byte = bytes.charCodeAt(index + i);
    if (byte < 0x80 || byte > 0xbf) return 1;
  }
  return length;
};

/**
 * Only terminal framing belongs here; Ink still parses keys and bracketed paste.
 * Latin-1 strings preserve incoming bytes one-for-one until framing is done.
 */
const createParser = (text: (value: string) => void, mouse: (value: string) => void) => {
  let pending = "";
  let paste = false;
  let discardSequence = false;
  let control: "osc" | "string" | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  const drain = () => {
    while (pending) {
      if (paste) {
        // Walk code points so a UTF-8 continuation byte is never a C1 marker.
        let end = 0;
        let closed = false;
        for (; end < pending.length; ) {
          const rest = pending.slice(end);
          const marker = PASTE_ENDINGS.find((ending) => rest.startsWith(ending));
          if (marker) {
            text(pending.slice(0, end) + PASTE_END);
            pending = pending.slice(end + marker.length);
            paste = false;
            closed = true;
            break;
          }
          if (PASTE_ENDINGS.some((ending) => ending.startsWith(rest))) break;
          const length = utf8Size(pending, end);
          if (end + length > pending.length) break;
          end += length;
        }
        if (closed) continue;
        text(pending.slice(0, end));
        pending = pending.slice(end);
        return;
      }

      if (discardSequence) {
        let end = 0;
        while (end < pending.length && pending.charAt(end) >= " " && pending.charAt(end) <= "?")
          end++;
        if (end === pending.length) {
          pending = "";
          return;
        }
        const final = pending.charAt(end) >= "@" && pending.charAt(end) <= "~";
        pending = pending.slice(end + (final ? 1 : 0));
        discardSequence = false;
        continue;
      }

      if (control) {
        // OSC may end in BEL; all control strings may end in ST. CAN/SUB
        // abort a response. Discard payload incrementally, not into a buffer.
        let end = -1;
        let length = 1;
        let i = 0;
        for (; i < pending.length; ) {
          const char = pending.charAt(i);
          if (
            (control === "osc" && char === "\x07") ||
            char === "\x9c" ||
            char === "\x18" ||
            char === "\x1a"
          ) {
            end = i;
            break;
          }
          if (
            (char === ESC && pending.charAt(i + 1) === "\\") ||
            (char === "\xc2" && pending.charAt(i + 1) === "\x9c")
          ) {
            end = i;
            length = 2;
            break;
          }
          const size = utf8Size(pending, i);
          if (i + size > pending.length || (char === ESC && i + 1 === pending.length)) break;
          i += size;
        }
        if (end < 0) {
          pending = pending.slice(i);
          return;
        }
        pending = pending.slice(end + length);
        control = null;
        continue;
      }

      // Frame bytes before decoding: legacy X10 coordinates are arbitrary
      // bytes, while UTF-8 continuation bytes must stay inside their glyph.
      if (pending.charAt(0) === "\xc2" && pending.length === 1) return;
      let c1 = pending.charCodeAt(0);
      if (c1 === 0xc2 && pending.charCodeAt(1) >= 0x80 && pending.charCodeAt(1) <= 0x9f) {
        pending = pending.slice(1);
        c1 = pending.charCodeAt(0);
      }
      if ([0x90, 0x98, 0x9b, 0x9d, 0x9e, 0x9f, 0x8f].includes(c1)) {
        pending = ESC + String.fromCharCode(c1 - 0x40) + pending.slice(1);
      }
      if (pending.charAt(0) !== ESC) {
        if (c1 >= 0x80 && c1 <= 0x9f) {
          pending = pending.slice(1);
          continue;
        }
        let end = 0;
        while (end < pending.length) {
          const byte = pending.charCodeAt(end);
          if (byte === 0x1b || (byte >= 0x80 && byte <= 0x9f)) break;
          const length = utf8Size(pending, end);
          if (end + length > pending.length) break;
          if (
            byte === 0xc2 &&
            pending.charCodeAt(end + 1) >= 0x80 &&
            pending.charCodeAt(end + 1) <= 0x9f
          )
            break;
          end += length;
        }
        if (!end) return;
        // Ink splits these into separate key events. Deliver each separately
        // too, so React can commit a deletion before the next repeated one.
        // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal control keys
        for (const part of pending.slice(0, end).split(/([\x03\x08\x7f])/)) {
          if (part) text(part);
        }
        pending = pending.slice(end);
        continue;
      }
      if (pending.length === 1 || pending === ESC + ESC) return;

      const prefix = pending.charAt(1) === ESC ? 2 : 1;
      const type = pending.charAt(prefix);
      if (["]", "P", "_", "^", "X"].includes(type)) {
        control = type === "]" ? "osc" : "string";
        pending = pending.slice(prefix + 1);
        continue;
      }
      if (type === "[" || type === "O") {
        let end = prefix + 1;
        for (; end < pending.length; end++) {
          const char = pending.charAt(end);
          // Linux function keys and rxvt shifted editing keys predate CSI.
          if (type === "[" && end === prefix + 1 && char === "[") continue;
          if (
            type === "[" &&
            end === prefix + 2 &&
            char === "$" &&
            "235678".includes(pending.charAt(prefix + 1))
          )
            break;
          if (char >= "@" && char <= "~") break;
          if (char < " " || char > "?") break;
        }
        if (
          end > MAX_SEQUENCE ||
          (type === "O" && !/^[\d;]*$/.test(pending.slice(prefix + 1, end)))
        ) {
          pending = pending.slice(prefix + 1);
          discardSequence = true;
          continue;
        }
        if (end === pending.length) return;
        // An escape/control byte cancels a malformed sequence, and is then
        // processed normally rather than leaking the prefix into the editor.
        if (pending.charAt(end) < " " || pending.charAt(end) > "~") {
          pending = pending.slice(end);
          continue;
        }
        let sequence = pending.slice(0, end + 1);
        // X10 has three coordinate bytes after CSI M. Ink's CSI parser
        // otherwise drops only the prefix and types the coordinates.
        if (sequence === `${ESC}[M`) {
          if (pending.length < end + 4) return;
          pending = pending.slice(end + 4);
          continue;
        }
        pending = pending.slice(end + 1);
        if (sequence === PASTE_START) {
          paste = true;
          text(sequence);
          continue;
        }
        if (parseMouse(sequence).length) {
          mouse(sequence);
          continue;
        }
        // Releases must not insert, submit, navigate, or quit a second time.
        if (/^\[[\d:]+;\d*:3(?:;[\d:]+)?[u~A-FHPQRS]$/.test(sequence.slice(1))) continue;
        // Ink 8 drops modifyOtherKeys as an unknown CSI. CSI-u represents
        // the same key/modifiers and is understood by all useInput handlers.
        const modified = /^\[27;(\d+);(\d+)~$/.exec(sequence.slice(1));
        if (modified) sequence = `${ESC}[${modified[2]};${modified[1]}u`;
        // Terminal.app's Option+Shift arrows have no explicit Shift bit.
        // Normalize the individual key, never metadata from the last chunk.
        const arrow = sequence.startsWith(ESC + ESC) && /^\[([A-D])$/.exec(sequence.slice(2));
        if (arrow) sequence = `${ESC}[1;2${arrow[1]}`;
        text(sequence);
        continue;
      }
      if (type === "\\") {
        pending = pending.slice(prefix + 1);
        continue;
      }
      const end = prefix + utf8Size(pending, prefix);
      if (end > pending.length) return;
      text(pending.slice(0, end));
      pending = pending.slice(end);
    }
  };

  return {
    push(value: string) {
      clearTimer();
      pending += value;
      drain();
      // Only bare Escape is ambiguous with a key. Once a protocol prefix
      // has arrived, wait for its terminator even over a slow remote stream.
      if (!paste && !control && (pending === ESC || pending === ESC + ESC)) {
        timer = setTimeout(() => {
          text(pending);
          pending = "";
        }, ESCAPE_DELAY);
        timer.unref();
      }
    },
    end() {
      clearTimer();
      if (
        paste ||
        (!control &&
          !discardSequence &&
          (!pending.startsWith(ESC) || pending === ESC || pending === ESC + ESC))
      )
        text(pending);
      pending = "";
    },
    reset() {
      clearTimer();
      pending = "";
      paste = false;
      discardSequence = false;
      control = null;
    }
  };
};

type TerminalStream = NodeJS.ReadableStream & {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  ref?: () => unknown;
  unref?: () => unknown;
};

/** Marks a stream made by {@link createStdin}, which `useMouse` checks for. */
const MOUSE_STDIN = Symbol.for("better-ink-ui.stdin");

/** Whether a stream is one {@link createStdin} made, which reports the mouse. */
export const isMouseStdin = (stream: unknown) =>
  typeof stream === "object" && stream !== null && MOUSE_STDIN in stream;

/**
 * Wraps the terminal's input for Ink: pass the result to `render(…, { stdin })`, or use this
 * library's `render`, which does it for you.
 *
 * It frames terminal input before Ink sees it: mouse reports are taken out and emitted as decoded
 * `mouse` events (which `useMouse` listens to) instead of being typed into the app as text;
 * bracketed pastes, OSC/DCS replies and stray protocol sequences are kept whole or dropped; UTF-8
 * is decoded across chunk boundaries; key releases from the kitty protocol are dropped and
 * `modifyOtherKeys` is rewritten to CSI-u; and each framed event is delivered on its own tick, so
 * React commits one edit before the next key arrives rather than batching them against stale
 * state.
 *
 * The caller owns the adapter and destroys it, not the underlying terminal. Piping handles
 * backpressure and the source's end.
 */
export const createStdin = (input: TerminalStream = process.stdin) => {
  let decoder = new StringDecoder("utf8");
  let accepting = true;
  let queue: ({ text: string } | { report: string })[] = [];
  let index = 0;
  let delivery: ReturnType<typeof setImmediate> | undefined;
  let complete: (() => void) | undefined;
  const finish = () => {
    const callback = complete;
    complete = undefined;
    callback?.();
  };
  const schedule = () => {
    if (delivery || index === queue.length) return;
    // Ink 8 dispatches all keys in a read synchronously. React otherwise
    // batches their edits against stale props. Yield between framed events,
    // preserving wire order for mouse, keyboard and paste alike.
    delivery = setImmediate(() => {
      delivery = undefined;
      const event = queue[index++] as { text: string } | { report: string };
      if ("text" in event) output.push(event.text);
      else for (const mouse of parseMouse(event.report)) output.emit("mouse", mouse);
      if (index < queue.length) schedule();
      else {
        queue = [];
        index = 0;
        finish();
      }
    });
  };
  const parser = createParser(
    (bytes) => {
      const text = decoder.write(Buffer.from(bytes, "latin1"));
      if (text) {
        queue.push({ text });
        schedule();
      }
    },
    (report) => {
      queue.push({ report });
      schedule();
    }
  );
  const output = new Transform({
    decodeStrings: false,
    encoding: "utf8",
    transform(chunk: string | Buffer, _encoding, callback) {
      if (!accepting) {
        callback();
        return;
      }
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      complete = callback;
      parser.push(bytes.toString("latin1"));
      if (!delivery) finish();
    },
    flush(callback) {
      complete = callback;
      parser.end();
      const text = decoder.end();
      if (text) {
        queue.push({ text });
        schedule();
      }
      if (!delivery) finish();
    },
    destroy(error, callback) {
      clearImmediate(delivery);
      queue = [];
      complete = undefined;
      parser.reset();
      input.unpipe(output);
      input.off("error", onError);
      input.off("close", onClose);
      callback(error);
    }
  });
  const onError = (error: Error) => output.destroy(error);
  const onClose = () => output.end();
  input.on("error", onError);
  input.on("close", onClose);

  // Do not advertise raw-mode support on pipes. For TTYs these properties
  // remain live, including isRaw after Ink changes the real handle's mode.
  Object.defineProperties(output, {
    isTTY: { get: () => input.isTTY },
    isRaw: { get: () => input.isRaw }
  });
  if (input.setRawMode)
    Object.assign(output, {
      setRawMode: (mode: boolean) => {
        input.setRawMode?.(mode);
        // Match Ink's input ownership boundaries, including paused input.
        accepting = false;
        parser.reset();
        decoder = new StringDecoder("utf8");
        clearImmediate(delivery);
        delivery = undefined;
        queue = [];
        index = 0;
        finish();
        // Paused input may already have been pushed but not read by Ink.
        while (output.read() !== null) {
          /* Discard the former owner's keys. */
        }
        accepting = mode;
        return output;
      }
    });
  if (input.ref)
    Object.assign(output, {
      ref: () => {
        input.ref?.();
        return output;
      }
    });
  if (input.unref)
    Object.assign(output, {
      unref: () => {
        input.unref?.();
        return output;
      }
    });
  Object.defineProperty(output, MOUSE_STDIN, { value: true });
  input.pipe(output);
  return output as typeof output & TerminalStream;
};
