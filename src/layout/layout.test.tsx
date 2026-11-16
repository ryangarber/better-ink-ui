import { describe, expect, it } from "vitest";
import { render } from "../testing/index.tsx";
import { blendColors, resolveColor } from "../theme/color.ts";
import { ThemeProvider } from "../theme/ThemeProvider.tsx";
import { Box } from "./Box.tsx";
import { Text } from "./Text.tsx";

describe("colors", () => {
  it("resolves theme names, and blends translucent colors over the background", () => {
    const colors = { accent: "primary", primary: "#ff0000", glass: "rgba(255, 255, 255, 0.5)" };
    expect(resolveColor("accent", colors, "#000000")).toBe("#ff0000");
    expect(resolveColor("glass", colors, "#000000")).toBe("#808080");
    // 0x80 is an alpha of 128/255, just over half.
    expect(resolveColor("#00000080", colors, "#ffffff")).toBe("#7f7f7f");
    expect(resolveColor("red", colors, undefined)).toBe("red");
    expect(blendColors("#000000", { r: 255, g: 0, b: 0, a: 0 })).toBe("#000000");
  });
});

describe("Box and Text", () => {
  it("hand text styles down, past boxes, and draw theme colors", async () => {
    const screen = render(
      <ThemeProvider theme={{ colors: { accent: "#ff0000" } }}>
        <Box color="accent" bold>
          <Box>
            <Text>inherited</Text>
          </Box>
          <Text color="#00ff00" bold={false}>
            own
          </Text>
        </Box>
      </ThemeProvider>
    );
    await screen.idle();
    const raw = screen.lastRawFrame();
    expect(raw).toContain("\x1b[1m\x1b[38;2;255;0;0minherited\x1b[22m");
    expect(raw).toMatch(/\x1b\[38;2;0;255;0mown/);
  });

  it("draws a box inside text inline rather than throwing", async () => {
    const screen = render(
      <Text>
        before{" "}
        <Box>
          <Text>inside</Text>
        </Box>
      </Text>
    );
    await screen.idle();
    expect(screen.lastFrame()).toContain("before inside");
  });

  it("draws a border in the theme's style", async () => {
    const screen = render(
      <ThemeProvider theme={{ borderStyle: "double" }}>
        <Box border width={6}>
          <Text>x</Text>
        </Box>
      </ThemeProvider>
    );
    await screen.idle();
    expect(screen.lastFrame()).toContain("╔════╗");
  });

  it("draws no border for border={false}, even with a style", async () => {
    const screen = render(
      <Box border={false} borderStyle="round" width={6}>
        <Text>x</Text>
      </Box>
    );
    await screen.idle();
    expect(screen.lastFrame()).not.toContain("╭");
  });
});
