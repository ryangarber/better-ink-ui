import { describe, expect, it, vi } from "vitest";
import { Box } from "../layout/Box.tsx";
import { Text } from "../layout/Text.tsx";
import { mouse, render } from "../testing/index.tsx";
import { Pressable } from "./Pressable.tsx";
import { useMouseInput } from "./useMouseInput.ts";

function Clickable({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  const { mouseRef } = useMouseInput({ onClick });
  return <Box ref={mouseRef}>{children}</Box>;
}

describe("presses", () => {
  it("reach the topmost target first, and stop where it stops them", async () => {
    const order: string[] = [];
    const outer = vi.fn(() => {
      order.push("outer");
    });
    const inner = vi.fn(() => {
      order.push("inner");
    });
    const screen = render(
      <Box height={4} flexDirection="column">
        <Clickable onClick={outer}>
          <Pressable onPress={inner}>
            <Text>button</Text>
          </Pressable>
          <Text> rest</Text>
        </Clickable>
      </Box>,
      { rows: 4 }
    );
    await screen.idle();
    await screen.write(mouse("down", 1, 0), mouse("up", 1, 0));
    expect(order).toEqual(["inner"]);
    await screen.write(mouse("down", 9, 0), mouse("up", 9, 0));
    expect(order).toEqual(["inner", "outer"]);
  });

  it("let a press through when the handler returns false, and track hover", async () => {
    const outer = vi.fn();
    const screen = render(
      <Box height={4} flexDirection="column">
        <Clickable onClick={outer}>
          <Pressable onPress={() => false}>
            {({ isHovered }) => <Text>{isHovered ? "hover" : "idle"}</Text>}
          </Pressable>
        </Clickable>
      </Box>,
      { rows: 4 }
    );
    await screen.idle();
    expect(screen.lastFrame()).toContain("idle");
    await screen.write(mouse("move", 1, 0));
    expect(screen.lastFrame()).toContain("hover");
    await screen.write(mouse("down", 1, 0), mouse("up", 1, 0));
    expect(outer).toHaveBeenCalledTimes(1);
  });
});
