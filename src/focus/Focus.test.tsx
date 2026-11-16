import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Pressable } from "../input/Pressable.tsx";
import { Box } from "../layout/Box.tsx";
import { Text } from "../layout/Text.tsx";
import { mouse, render } from "../testing/index.tsx";
import {
  FocusProvider,
  FocusScope,
  FocusTarget,
  type FocusTargetProps,
  useFocusContext
} from "./Focus.tsx";
import { FocusManager } from "./FocusManager.ts";

const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";

/** A target drawing its id, marked while it has the focus. */
function Field(props: FocusTargetProps & { id: string }) {
  return (
    <FocusTarget {...props}>
      <Label id={props.id} />
      {props.children}
    </FocusTarget>
  );
}

function Label({ id }: { id: string }) {
  const { isFocused } = useFocusContext();
  return <Text>{isFocused ? `[${id}]` : ` ${id} `}</Text>;
}

const setup = (tree: React.ReactNode) => {
  const manager = new FocusManager();
  const screen = render(<FocusProvider manager={manager}>{tree}</FocusProvider>, { rows: 10 });
  return { ...screen, manager };
};

let opener: (open: boolean) => void = () => {};

function Dialog() {
  const [open, setOpen] = useState(false);
  opener = setOpen;
  return (
    <Box flexDirection="column">
      <Field id="main" sink />
      <Field id="other" />
      {open && (
        <FocusScope trap autoFocus restoreFocus>
          <Field id="ok" />
          <Field id="cancel" />
        </FocusScope>
      )}
    </Box>
  );
}

describe("focus", () => {
  it("cycles tab stops in order, then in the order they are drawn", async () => {
    const screen = setup(
      <Box flexDirection="column">
        <Field id="c" order={1} />
        <Field id="a" sink />
        <Field id="b" />
        <Field id="page" tabStop={false} />
      </Box>
    );
    await screen.idle();
    expect(screen.manager.focused()).toBe("a");
    await screen.write(TAB);
    expect(screen.manager.focused()).toBe("b");
    await screen.write(TAB);
    expect(screen.manager.focused()).toBe("c");
    await screen.write(TAB);
    expect(screen.manager.focused()).toBe("a");
    await screen.write(SHIFT_TAB);
    expect(screen.manager.focused()).toBe("c");
    expect(screen.lastFrame()).toContain("[c]");
  });

  it("falls to the sink while the focused target is gone, and returns once it is back", async () => {
    const tree = (open: boolean, disabled = false) => (
      <Box flexDirection="column">
        <Field id="editor" sink />
        {open && <Field id="panel" disabled={disabled} />}
      </Box>
    );
    const screen = setup(tree(true));
    await screen.idle();
    screen.manager.focus("panel");
    await screen.idle();
    expect(screen.lastFrame()).toContain("[panel]");

    screen.rerender(<FocusProvider manager={screen.manager}>{tree(false)}</FocusProvider>);
    await screen.idle();
    expect(screen.manager.focused()).toBe("editor");

    screen.rerender(<FocusProvider manager={screen.manager}>{tree(true)}</FocusProvider>);
    await screen.idle();
    expect(screen.manager.focused()).toBe("panel");

    screen.rerender(<FocusProvider manager={screen.manager}>{tree(true, true)}</FocusProvider>);
    await screen.idle();
    expect(screen.manager.focused()).toBe("editor");
  });

  it("lets the focused target keep Tab", async () => {
    let tabs = 0;
    const screen = setup(
      <Box flexDirection="column">
        <Field
          id="a"
          sink
          onTab={() => {
            tabs++;
            return tabs === 1;
          }}
        />
        <Field id="b" />
      </Box>
    );
    await screen.idle();
    await screen.write(TAB);
    expect(screen.manager.focused()).toBe("a");
    await screen.write(TAB);
    expect(screen.manager.focused()).toBe("b");
  });

  it("focuses the innermost target pressed", async () => {
    const screen = setup(
      <Field id="outer" sink>
        <Field id="inner" />
      </Field>
    );
    await screen.idle();
    // Ink draws a short app at the bottom of the terminal, which is 10 rows here.
    const lines = screen.lastFrame().split("\n");
    const top = 10 - lines.length;
    const row = top + lines.findIndex((line) => line.includes("inner"));
    await screen.write(mouse("down", 2, row), mouse("up", 2, row));
    expect(screen.manager.focused()).toBe("inner");
    await screen.write(mouse("down", 2, top), mouse("up", 2, top));
    expect(screen.manager.focused()).toBe("outer");
  });

  it("leaves the focus where a press inside a target sent it", async () => {
    const screen = setup(
      <Box flexDirection="column">
        <Field id="panel" sink>
          {/* Passed on to the panel, which would take the focus back but for the rule. */}
          <Pressable
            onPress={() => {
              screen.manager.focus("page");
              return false;
            }}
          >
            <Text>open</Text>
          </Pressable>
        </Field>
        <Field id="page" />
      </Box>
    );
    await screen.idle();
    const lines = screen.lastFrame().split("\n");
    const top = 10 - lines.length;
    const row = top + lines.findIndex((line) => line.includes("open"));
    await screen.write(mouse("down", 2, row), mouse("up", 2, row));
    expect(screen.manager.focused()).toBe("page");
    // A press that moves nothing still focuses the target it lands in.
    await screen.write(mouse("down", 2, top), mouse("up", 2, top));
    expect(screen.manager.focused()).toBe("panel");
  });

  it("traps the focus in a scope, and restores it once the scope closes", async () => {
    const screen = setup(<Dialog />);
    await screen.idle();
    screen.manager.focus("other");
    opener(true);
    await screen.idle();
    expect(screen.manager.focused()).toBe("ok");
    await screen.write(TAB);
    expect(screen.manager.focused()).toBe("cancel");
    await screen.write(TAB);
    expect(screen.manager.focused()).toBe("ok");
    // Asked for outside the trap, the focus stays inside it.
    screen.manager.focus("main");
    await screen.idle();
    expect(screen.manager.focused()).toBe("ok");

    opener(false);
    await screen.idle();
    expect(screen.manager.focused()).toBe("other");
  });
});
