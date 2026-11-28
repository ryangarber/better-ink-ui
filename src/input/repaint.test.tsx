import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Text, useWindowSize } from "ink";
import { render } from "./render.ts";
import { repaintOnResize } from "./repaint.ts";

const HOME_AND_ERASE = "\x1b[H\x1b[2J";

/** A terminal's stdout, recording what is written to it. */
const createStdout = (columns = 40, rows = 6) => {
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns,
    rows,
    writes: [] as string[],
    write(chunk: string) {
      stdout.writes.push(chunk);
      return true;
    },
    resize(nextColumns: number, nextRows: number) {
      stdout.columns = nextColumns;
      stdout.rows = nextRows;
      stdout.emit("resize");
    }
  });
  return stdout;
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("repaintOnResize", () => {
  it("repaints once when a resize and its signal arrive together, in either order", async () => {
    for (const order of [
      ["resize", "SIGWINCH"],
      ["SIGWINCH", "resize"]
    ] as const) {
      const stdout = createStdout();
      const instance = { clear: vi.fn() };
      const rerender = vi.fn();
      const stop = repaintOnResize({ instance, stdout: stdout as never, rerender });

      for (const event of order) {
        if (event === "resize") stdout.emit("resize");
        else process.emit("SIGWINCH");
      }
      await tick();

      expect(instance.clear).toHaveBeenCalledTimes(1);
      expect(stdout.writes.filter((chunk) => chunk === HOME_AND_ERASE)).toHaveLength(1);
      // Ink draws the frame on its own `resize`.
      expect(rerender).not.toHaveBeenCalled();
      stop();
    }
  });

  it("draws the frame itself after a resize that left the size as it was", async () => {
    const stdout = createStdout();
    const instance = { clear: vi.fn() };
    const rerender = vi.fn();
    const stop = repaintOnResize({ instance, stdout: stdout as never, rerender });

    process.emit("SIGWINCH");
    await tick();

    expect(instance.clear).toHaveBeenCalledTimes(1);
    expect(stdout.writes).toContain(HOME_AND_ERASE);
    expect(rerender).toHaveBeenCalledTimes(1);
    stop();
  });

  it("ends the synchronized update it opened when stopped", () => {
    const stdout = createStdout();
    const stop = repaintOnResize({
      instance: { clear: vi.fn() },
      stdout: stdout as never,
      rerender: vi.fn()
    });

    stdout.emit("resize");
    stop();

    expect(stdout.writes.at(0)).toBe("\x1b[?2026h");
    expect(stdout.writes.at(-1)).toBe("\x1b[?2026l");
    stdout.emit("resize");
    expect(stdout.writes.at(-1)).toBe("\x1b[?2026l");
  });
});

function Rows() {
  const { columns, rows } = useWindowSize();
  return (
    <Text>
      {Array.from({ length: rows }, (_, i) => `row ${i + 1} of ${rows} at ${columns}`).join("\n")}
    </Text>
  );
}

describe("render", () => {
  it("draws the whole frame from the top-left corner after the terminal resizes", async () => {
    const stdout = createStdout();
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: () => {},
      ref: () => {},
      unref: () => {}
    });
    const instance = render(<Rows />, {
      stdout: stdout as never,
      stdin: stdin as never,
      alternateScreen: true,
      incrementalRendering: true,
      patchConsole: false,
      exitOnCtrlC: false
    });
    await vi.waitFor(() => expect(stdout.writes.join("")).toContain("row 6 of 6 at 40"));

    stdout.writes.length = 0;
    stdout.resize(40, 8);
    await vi.waitFor(() => expect(stdout.writes.join("")).toContain("row 8 of 8 at 40"));

    const output = stdout.writes.join("");
    const erase = output.indexOf(HOME_AND_ERASE);
    expect(erase).toBeGreaterThanOrEqual(0);
    // Every row comes after the erase, none of them skipped as already on screen.
    const after = output.slice(erase);
    for (let row = 1; row <= 6; row++) expect(after).toContain(`row ${row} of`);

    instance.unmount();
  });
});
