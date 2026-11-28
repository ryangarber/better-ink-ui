import { act, memo, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Box } from "../layout/Box.tsx";
import { Text } from "../layout/Text.tsx";
import { cleanup, mouse, render } from "../testing/index.tsx";
import { Popover, type PopoverProps, PopoverProvider } from "./Popover.tsx";

afterEach(cleanup);

const lines = (frame: string) => frame.split("\n");
const find = (frame: string, text: string) => {
  const rows = lines(frame);
  const y = rows.findIndex((line) => line.includes(text));
  return { x: rows[y]?.indexOf(text) ?? -1, y };
};

function Screen({
  rows = 12,
  top = 0,
  ...props
}: Partial<PopoverProps> & { rows?: number; top?: number }) {
  return (
    <Box height={rows} width={40} flexDirection="column">
      <PopoverProvider>
        <Box marginTop={top} marginLeft={4}>
          <Popover content={<Text>card</Text>} {...props}>
            {({ isOpen, isPinned }) => (
              <Text>{isPinned ? "pinned" : isOpen ? "opened" : "button"}</Text>
            )}
          </Popover>
        </Box>
        <Text>elsewhere</Text>
      </PopoverProvider>
    </Box>
  );
}

function Moving({ top }: { top: number }) {
  return (
    <Box height={12} width={40} flexDirection="column">
      <PopoverProvider>
        <Box marginTop={top}>
          <Popover open content={({ close }) => <Text>card {typeof close}</Text>}>
            <Text>button</Text>
          </Popover>
        </Box>
      </PopoverProvider>
    </Box>
  );
}

const Trigger = memo(() => (
  <Popover open content={<Text>card</Text>}>
    <Text>button</Text>
  </Popover>
));

let grow = () => {};

function Above() {
  const [rows, setRows] = useState(1);
  grow = () => setRows(4);
  return <Box height={rows} />;
}

describe("Popover", () => {
  it("opens below on hover, stays over the card, and closes on leaving", async () => {
    const onOpenChange = vi.fn();
    const screen = render(<Screen onOpenChange={onOpenChange} />, { rows: 12 });
    await screen.idle();
    expect(screen.lastFrame()).not.toContain("card");

    await screen.write(mouse("move", 5, 0));
    const frame = screen.lastFrame();
    expect(frame).toContain("opened");
    // Bordered, below the trigger, lined up with its start.
    expect(find(frame, "card")).toEqual({ x: 6, y: 2 });
    expect(onOpenChange).toHaveBeenLastCalledWith(true);

    await screen.write(mouse("move", 6, 2));
    expect(screen.lastFrame()).toContain("card");

    await screen.write(mouse("move", 30, 10));
    expect(screen.lastFrame()).not.toContain("card");
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("is held open by a click, and closed by one outside", async () => {
    const screen = render(<Screen openOnHover={false} />, { rows: 12 });
    await screen.idle();
    await screen.write(mouse("down", 5, 0), mouse("up", 5, 0));
    expect(screen.lastFrame()).toContain("pinned");
    expect(screen.lastFrame()).toContain("card");

    // Inside the card, it stays.
    await screen.write(mouse("down", 6, 2), mouse("up", 6, 2));
    expect(screen.lastFrame()).toContain("card");

    await screen.write(mouse("down", 30, 10), mouse("up", 30, 10));
    expect(screen.lastFrame()).not.toContain("card");

    // A second click on the trigger lets it go.
    await screen.write(mouse("down", 5, 0), mouse("up", 5, 0));
    await screen.write(mouse("down", 5, 0), mouse("up", 5, 0));
    expect(screen.lastFrame()).not.toContain("card");
  });

  it("takes each behavior being turned off", async () => {
    const screen = render(
      <Screen openOnHover={false} toggleOnClick={false} closeOnClickOutside={false} />,
      { rows: 12 }
    );
    await screen.idle();
    await screen.write(mouse("move", 5, 0), mouse("down", 5, 0), mouse("up", 5, 0));
    expect(screen.lastFrame()).not.toContain("card");

    const pinned = render(<Screen openOnHover={false} closeOnClickOutside={false} />, { rows: 12 });
    await pinned.idle();
    await pinned.write(mouse("down", 5, 0), mouse("up", 5, 0));
    await pinned.write(mouse("down", 30, 10), mouse("up", 30, 10));
    expect(pinned.lastFrame()).toContain("card");

    const disabled = render(<Screen disabled open />, { rows: 12 });
    await disabled.idle();
    await disabled.write(mouse("move", 5, 0));
    expect(disabled.lastFrame()).not.toContain("card");
  });

  it("is shown while controlled open, and reports closing", async () => {
    const onOpenChange = vi.fn();
    const screen = render(<Screen open onOpenChange={onOpenChange} />, { rows: 12 });
    await screen.idle();
    expect(screen.lastFrame()).toContain("card");
    await screen.write(mouse("down", 30, 10), mouse("up", 30, 10));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(screen.lastFrame()).toContain("card");
  });

  it("flips above where there is no room below, and takes a position", async () => {
    const screen = render(<Screen top={9} open />, { rows: 12 });
    await screen.idle();
    expect(find(screen.lastFrame(), "card").y).toBe(7);

    const right = render(
      <Screen open position="right" offset={1} contentProps={{ border: false }} />,
      {
        rows: 12
      }
    );
    await right.idle();
    expect(find(right.lastFrame(), "card")).toEqual({ x: 12, y: 0 });
  });

  it("keeps inside custom bounds", async () => {
    const screen = render(
      <Screen open position="top" bounds={{ x: 0, y: 0, width: 40, height: 12 }} />,
      { rows: 12 }
    );
    await screen.idle();
    // No room above the first row: flipped below.
    expect(find(screen.lastFrame(), "card").y).toBe(2);

    const narrow = render(<Screen open bounds={{ x: 20, y: 0, width: 20, height: 12 }} />, {
      rows: 12
    });
    await narrow.idle();
    expect(find(narrow.lastFrame(), "card").x).toBe(22);
  });

  it("triggers from inline text", async () => {
    const screen = render(
      <Box height={6} width={40} flexDirection="column">
        <PopoverProvider>
          <Text>
            some words{" "}
            <Popover content={<Text>note</Text>}>
              <Text>[1]</Text>
            </Popover>{" "}
            after
          </Text>
        </PopoverProvider>
      </Box>,
      { rows: 6 }
    );
    await screen.idle();
    const { x, y } = find(screen.lastFrame(), "[1]");
    await screen.write(mouse("move", 0, y));
    expect(screen.lastFrame()).not.toContain("note");
    await screen.write(mouse("move", x + 1, y));
    expect(find(screen.lastFrame(), "note")).toEqual({ x: x + 2, y: y + 2 });
  });

  it("shows one at a time, but keeps those a popover was opened from", async () => {
    const screen = render(
      <Box height={14} width={40} flexDirection="column">
        <PopoverProvider>
          <Popover
            openOnHover={false}
            content={
              <Popover openOnHover={false} content={<Text>inner</Text>}>
                <Text>nested</Text>
              </Popover>
            }
          >
            <Text>first</Text>
          </Popover>
          <Box marginTop={6}>
            <Popover openOnHover={false} content={<Text>other</Text>}>
              <Text>second</Text>
            </Popover>
          </Box>
        </PopoverProvider>
      </Box>,
      { rows: 14 }
    );
    await screen.idle();
    await screen.write(mouse("down", 1, 0), mouse("up", 1, 0));
    const nested = find(screen.lastFrame(), "nested");
    await screen.write(mouse("down", nested.x, nested.y), mouse("up", nested.x, nested.y));
    expect(screen.lastFrame()).toContain("nested");
    expect(screen.lastFrame()).toContain("inner");

    // A click inside the inner one is inside the outer one too.
    const inner = find(screen.lastFrame(), "inner");
    await screen.write(mouse("down", inner.x, inner.y), mouse("up", inner.x, inner.y));
    expect(screen.lastFrame()).toContain("nested");

    const second = find(screen.lastFrame(), "second");
    await screen.write(mouse("down", second.x, second.y), mouse("up", second.x, second.y));
    expect(screen.lastFrame()).toContain("other");
    expect(screen.lastFrame()).not.toContain("nested");
  });

  it("follows its trigger as the layout moves it, and passes close to content", async () => {
    const screen = render(<Moving top={0} />, { rows: 12 });
    await screen.idle();
    expect(find(screen.lastFrame(), "card function").y).toBe(2);
    screen.rerender(<Moving top={3} />);
    await screen.idle();
    expect(find(screen.lastFrame(), "card function").y).toBe(5);
  });

  it("follows its trigger when only what is around it renders", async () => {
    const screen = render(
      <Box height={12} width={40} flexDirection="column">
        <PopoverProvider>
          <Above />
          <Trigger />
        </PopoverProvider>
      </Box>,
      { rows: 12 }
    );
    await screen.idle();
    expect(find(screen.lastFrame(), "card").y).toBe(3);
    act(() => grow());
    await screen.idle();
    expect(find(screen.lastFrame(), "button").y).toBe(4);
    expect(find(screen.lastFrame(), "card").y).toBe(6);
  });
});
