// A tour of the UI primitives against a real terminal: `pnpm build && node examples/ui.mjs`.
// Tab moves between the panels; the wheel scrolls whatever is under the pointer; drag over the
// log to select from it and Ctrl+C to copy; type in the editor, where `@name` mentions are atoms.
import { useApp, useInput } from "ink";
import { createElement as h, useMemo, useState } from "react";
import {
  Box,
  FocusProvider,
  FocusTarget,
  Pressable,
  render,
  ScrollView,
  Selectable,
  Text,
  Textarea,
  ThemeProvider,
  useFocusContext
} from "../dist/index.mjs";

const theme = {
  colors: { accent: "#7aa2f7", subtle: "#565f89", glass: "rgba(122, 162, 247, 0.25)" },
  background: "#1a1b26"
};

const lines = Array.from({ length: 300 }, (_, i) => `${String(i + 1).padStart(3)} line of the log ${"·".repeat(i % 20)}`);

function Title({ children }) {
  const { isFocused } = useFocusContext();
  return h(
    Box,
    { flexShrink: 0 },
    h(Text, { bold: true, color: isFocused ? "accent" : "subtle" }, children)
  );
}

function Log() {
  return h(
    FocusTarget,
    { id: "log", order: 1, border: true, borderColor: "subtle", flexGrow: 1, flexBasis: 0 },
    h(Title, null, "Log"),
    h(
      Selectable,
      { flexGrow: 1, minHeight: 0 },
      h(
        ScrollView,
        { flexGrow: 1, stickToBottom: true, paging: true },
        lines.map((line) => h(Text, { key: line, wrap: "truncate-end" }, line))
      )
    )
  );
}

function Editor() {
  const { isFocused } = useFocusContext();
  const [value, setValue] = useState("Hello @alice and @bob — try deleting a mention.\n");
  const atoms = useMemo(
    () =>
      [...value.matchAll(/@\w+/g)].map((match) => ({
        start: match.index,
        end: match.index + match[0].length,
        label: "mention"
      })),
    [value]
  );
  return h(Textarea, {
    value,
    onChange: setValue,
    focus: isFocused,
    atoms,
    placeholder: "Write something…",
    labels: [{ pattern: /\*\*[^*]+\*\*/g, label: "bold" }],
    styles: { mention: { color: "accent", backgroundColor: "glass", bold: true }, bold: { bold: true } },
    maxRows: 6
  });
}

function App() {
  const { exit } = useApp();
  const [presses, setPresses] = useState(0);
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "q")) exit();
  });
  return h(
    Box,
    { flexDirection: "column", height: process.stdout.rows },
    h(Log),
    h(
      FocusTarget,
      { id: "editor", sink: true, border: true, borderColor: "subtle", flexShrink: 0 },
      h(Title, null, "Editor"),
      h(Editor)
    ),
    h(
      Box,
      { gap: 2, flexShrink: 0 },
      h(
        Pressable,
        { onPress: () => setPresses((n) => n + 1) },
        ({ isHovered }) => h(Text, { inverse: isHovered }, ` pressed ${presses} `)
      ),
      h(Text, { dimColor: true }, "Tab: switch · wheel: scroll · Esc: quit")
    )
  );
}

render(h(ThemeProvider, { theme }, h(FocusProvider, null, h(App))), { exitOnCtrlC: false });
