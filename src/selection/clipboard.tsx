import { useStdout } from "ink";
import { createContext, type ReactNode, useCallback, useContext } from "react";

/** Hands text to the system clipboard. */
export type CopyText = (text: string) => void | Promise<void>;

const ClipboardContext = createContext<CopyText | null>(null);

/** The OSC 52 escape that asks the terminal to put `text` on the system clipboard. */
export const osc52 = (text: string) =>
  `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;

/**
 * How text copied from a selection reaches the clipboard. Without one, it is written to the
 * terminal as OSC 52, which most terminals honor — over SSH too — though tmux only passes it on
 * with `set-clipboard on`. Provide one to use a native clipboard instead.
 */
export function ClipboardProvider({ copy, children }: { copy: CopyText; children?: ReactNode }) {
  return <ClipboardContext value={copy}>{children}</ClipboardContext>;
}

/** Copies text to the clipboard: the provider's way, or OSC 52. */
export const useClipboard = (): CopyText => {
  const provided = useContext(ClipboardContext);
  const { stdout } = useStdout();
  return useCallback(
    (text: string) => {
      if (!text) return;
      if (provided) return provided(text);
      stdout.write(osc52(text));
    },
    [provided, stdout]
  );
};
