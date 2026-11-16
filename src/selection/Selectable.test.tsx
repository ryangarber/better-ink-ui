import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { Pressable } from "../input/Pressable.tsx";
import { Box } from "../layout/Box.tsx";
import { Text } from "../layout/Text.tsx";
import { render } from "../testing/index.tsx";
import { ClipboardProvider } from "./clipboard.tsx";
import { Selectable, SelectionMenuContext, Unselectable } from "./Selectable.tsx";
import { SelectionStore } from "./selectionStore.ts";

/** Mouse reports and keys as a terminal sends them, columns and rows from 1. */
const KEY = {
  down: (column: number, row: number) => `\x1b[<0;${column};${row}M`,
  drag: (column: number, row: number) => `\x1b[<32;${column};${row}M`,
  up: (column: number, row: number) => `\x1b[<0;${column};${row}m`,
  click: (column: number, row: number) => `\x1b[<0;${column};${row}M\x1b[<0;${column};${row}m`,
  shiftRight: "\x1b[1;2C",
  escape: "\x1b",
  ctrlA: "\x01",
  ctrlC: "\x03"
};

/** Filling the screen, so a row of it is a row of the terminal. */
function Page({
  onQuote,
  copy
}: {
  onQuote: (text: string) => void;
  copy: (text: string) => void;
}) {
  return (
    <ClipboardProvider copy={copy}>
      <Box height={24} flexDirection="column">
        <SelectionMenuContext
          value={({ text, dismiss }) => (
            <Pressable
              onPress={() => {
                dismiss();
                onQuote(text);
              }}
            >
              <Text>[quote]</Text>
            </Pressable>
          )}
        >
          <Selectable>
            <Text>hello world</Text>
            <Text>second line</Text>
            <Selectable>
              <Unselectable>
                <Text>[skip]</Text>
              </Unselectable>
              <Text>nested</Text>
            </Selectable>
          </Selectable>
        </SelectionMenuContext>
        <Box marginTop={3}>
          <Text>outside</Text>
        </Box>
      </Box>
    </ClipboardProvider>
  );
}

async function page() {
  const quoted: string[] = [];
  const copy = vi.fn<(text: string) => void>();
  const screen = render(<Page onQuote={(text) => quoted.push(text)} copy={copy} />);
  await screen.idle();

  const frame = () => stripVTControlCharacters(screen.lastFrame() ?? "");

  return {
    quoted,
    copy,
    frame,
    /** Where some text is drawn, as the column and row a click lands on. */
    find: (text: string) => {
      const lines = frame().split("\n");
      const row = lines.findIndex((line) => line.includes(text));
      return [(lines[row] ?? "").indexOf(text) + 1, row + 1] as const;
    },
    press: async (...keys: string[]) => {
      for (const key of keys) {
        screen.stdin.write(key);
        await screen.idle();
      }
    },
    done: () => {
      screen.unmount();
      screen.cleanup();
    }
  };
}

describe("Selectable", () => {
  it("copies what a drag selected, a block of text to a line", async () => {
    const screen = await page();
    await screen.press(KEY.down(1, 1), KEY.drag(4, 2), KEY.drag(7, 2));
    await screen.press(KEY.up(7, 2), KEY.ctrlC);

    expect(screen.copy).toHaveBeenCalledWith("hello world\nsecond");
    screen.done();
  });

  it("takes a word on a double click, and stretches it with Shift", async () => {
    const screen = await page();
    await screen.press(KEY.click(8, 1), KEY.click(8, 1), KEY.shiftRight);
    await screen.press(KEY.ctrlC);

    expect(screen.copy).toHaveBeenCalledWith("world\n");
    screen.done();
  });

  it("selects all of it on Ctrl+A, leaving out what is ignored", async () => {
    const screen = await page();
    await screen.press(KEY.click(8, 1), KEY.click(8, 1), KEY.ctrlA);
    await screen.press(KEY.ctrlC);

    expect(screen.copy).toHaveBeenCalledWith("hello world\nsecond line\nnested");
    screen.done();
  });

  it("lets the selection go on a click elsewhere, and on Escape", async () => {
    const screen = await page();
    await screen.press(KEY.click(8, 1), KEY.click(8, 1));
    expect(SelectionStore.holder()).not.toBeNull();

    await screen.press(KEY.click(...screen.find("outside")));
    expect(SelectionStore.holder()).toBeNull();

    await screen.press(KEY.click(8, 2), KEY.click(8, 2));
    expect(SelectionStore.holder()).not.toBeNull();
    await screen.press(KEY.escape);
    await vi.waitFor(() => expect(SelectionStore.holder()).toBeNull());

    await screen.press(KEY.ctrlC);
    expect(screen.copy).not.toHaveBeenCalled();
    screen.done();
  });

  it("offers its actions over what is selected", async () => {
    const screen = await page();
    await screen.press(KEY.down(1, 2), KEY.drag(12, 2), KEY.up(12, 2));

    await screen.press(KEY.click(...screen.find("[quote]")));

    expect(screen.quoted).toEqual(["second line"]);
    expect(SelectionStore.holder()).toBeNull();
    expect(screen.frame()).not.toContain("[quote]");
    screen.done();
  });
});
