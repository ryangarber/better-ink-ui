# better-ink-ui

Generic, fast UI primitives for [Ink](https://github.com/vadimdemedes/ink): themed `Box` and `Text` that pass their
styles down, the mouse, virtualized scroll views, text selection, a multiline text area, focus management, and images
drawn off the main thread.

```tsx
import {
  Box,
  FocusProvider,
  FocusTarget,
  render,
  ScrollView,
  Selectable,
  Text,
  Textarea
} from "better-ink-ui";

render(
  <FocusProvider>
    <FocusTarget id="log" border flexGrow={1}>
      <Selectable flexGrow={1}>
        <ScrollView flexGrow={1} stickToBottom>
          {lines.map((line) => (
            <Text key={line.id}>{line.text}</Text>
          ))}
        </ScrollView>
      </Selectable>
    </FocusTarget>
    <FocusTarget id="editor" sink border>
      <Editor />
    </FocusTarget>
  </FocusProvider>
);
```

## Input

The mouse needs Ink's stdin wrapped. This library's `render` does it for you. With Ink's `render`, pass
`stdin: createStdin(process.stdin)`. The wrapper takes mouse reports out of the keys and emits them as `mouse`
events. It also keeps bracketed pastes and terminal replies whole, decodes UTF-8 across reads, drops kitty key
releases, and delivers each key on its own tick, so React commits one edit before the next key arrives.

| Export                                           | What it does                                                                                                                                                                                                                 |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useMouse(handler, { motion, drag })`            | Every report on screen. Only the reporting mode some subscriber needs is turned on                                                                                                                                           |
| `useMouseInput({ onClick, onDrag, … })`          | Presses, drags and hovers on elements, via `mouseRef`. Only what is visible takes the mouse. Presses reach the topmost element first, and `stopPropagation()` keeps them there. A drag follows the pointer out until release |
| `useMouseLayer(ref)`                             | Makes an overlay: where it is drawn, nothing beneath takes the mouse                                                                                                                                                         |
| `Pressable`                                      | A pressable box. Children may be `({ isHovered, isPressed }) => …`                                                                                                                                                           |
| `getBounds`, `getVisibleBounds`, `getTextBounds` | Where an element (or an inline `<Span>`) is on screen, in mouse coordinates                                                                                                                                                  |

While an event is dispatched, element bounds are measured once and shared, so a screen full of buttons doesn't walk
the tree once per button.

## Box and Text

Both take theme names and translucent colors (`#rrggbbaa`, `rgba()`, `{ r, g, b, a }`), which blend over the theme's
background. `Box` passes `color`, `bold`, `dimColor`, `wrap` and the other text styles down to every `Text` inside it,
and passes `borderColor` down to every box. `<Box border>` draws the theme's border style. A `Box` inside a `Text`
renders inline instead of throwing. Inherited styles are memoized by value, so the context only changes when a style
does.

```tsx
<ThemeProvider
  theme={{ colors: { accent: "#7aa2f7", glass: "rgba(122,162,247,.25)" }, background: "#1a1b26" }}
>
  <Box color="accent" bold border>
    <Text>accent, bold</Text>
  </Box>
</ThemeProvider>;
```

The library draws its own parts in the `text`, `border`, `scrollbar`, `scrollbarActive`, `selection`,
`selectionBackground` and `placeholder` theme colors.

## ScrollView

A viewport that only mounts the children near it (`overscan` rows past each edge). Every other child is held at the
height it was last measured at, so a list of thousands costs about what fills the screen.

- `selectedIndex` + `align` keep a child in view, moving only as far as needed. The ref's `scrollToIndex`,
  `scrollTo`, `scrollBy` and friends jump directly.
- `stickToBottom` follows new content while the view rests at the bottom, and lets go when the reader scrolls away.
- The wheel turns whatever is under the pointer. Nested views (and text areas) take it first, and pass it on at
  their edges. Fast flicks are batched per frame.
- A scrollbar that can be dragged or pressed beside to jump, `rail` for marks beside it, `paging` for PageUp and
  PageDown, and `onReachTop`/`onReachBottom` for loading more.
- Content above the first visible row can change height without moving what's being read.
- `useScrollSticky(ref)` keeps an overlay (a block's buttons, a header) in sight while its block scrolls through
  every view it is in. `revealRow(node, y)` scrolls every view around a node to a row.

## Selectable and useSelection

`<Selectable>` makes whatever is drawn inside it selectable, reading it back off the screen as laid out: wrapped lines,
scrolled views, table cells. You can drag (a word at a time after a double click), stretch with Shift and the arrows,
select all with Ctrl+A and copy with Ctrl+C. Escape or a press elsewhere lets go. Nested selectables join into one run
of text. Wrap what isn't text (line numbers, buttons) in `<Unselectable>`. `menu` (or `SelectionMenuContext`) draws
buttons over a selection.

`useSelection` is the logic underneath, for anything that draws its own text. Only one selection is held at a time, as
in a terminal. `useHasSelection()` tells an app whether Ctrl+C should copy or quit. Copying uses OSC 52 by default.
`<ClipboardProvider copy={…}>` swaps in a native clipboard.

## Textarea

A multiline field: wrapped to its width, scrolled past `maxRows`, with a blinking cursor, mouse and keyboard selection,
cut, copy and paste, undo and redo grouped by word, word motion and deletion under Alt (however the terminal sends
it), and Home/End.

- `labels` + `styles` paint the value: by regex (`{ pattern, label }`) or by ranges computed from the value
  (`{ ranges }`). Labels joined by `+` combine their styles, and colors go through the theme.
- `atoms` are runs handled whole: the cursor steps over them, selections expand to cover them, and deletes take them
  out entirely (a word delete stops at their edge). This is how mentions, chips and placeholder tokens stand in the
  text. An atom with a `label` is painted ahead of the rules.
- `onKey` sees every key first and can take it, or return a `{ value, selection }` edit that is undone like any other.
  `onEnter`, `onSubmit` (Ctrl/Alt/Super + Enter), `onPaste` and `onClick` take over their actions.
- An edit only re-wraps the lines it touched, and cursor movement finds grapheme boundaries locally, so very large
  values stay responsive.

`TextareaUtils` (wrapping, positions, painting, words, atoms), `useUndo` and `useCursorBlink` are exported for building
other editors.

## Focus

```tsx
<FocusProvider>
  <FocusTarget id="editor" sink>
    …
  </FocusTarget>
  <FocusTarget id="files" order={2}>
    …
  </FocusTarget>
  {open && (
    <FocusScope trap autoFocus restoreFocus>
      <FocusTarget id="ok">…</FocusTarget>
    </FocusScope>
  )}
</FocusProvider>;
```

- Tab and Shift+Tab cycle tab stops by `order`, then in the order they're drawn. `onTab` lets the focused target keep
  Tab (to indent, or to accept a completion). `tabKeys={false}` leaves Tab to the app.
- A `sink` takes the focus whenever the focused target closes, unmounts or is disabled. The requested focus is kept,
  so a target that only moved gets the focus back.
- `tabStop={false}` targets (a page drawn over the app) are focused by name, or by a press, which focuses the
  innermost target pressed.
- `FocusScope trap` confines Tab and the focus while it is mounted. `autoFocus` focuses its first stop, and
  `restoreFocus` puts the focus back when it closes.
- Inside a target, `useFocusContext().isFocused` tells what it draws whether it has the keys. `useFocusTarget` is the
  hook form, and `useFocusManager` gives `focused`, `focus(id)`, `cycle` and the rest.

## Testing

`better-ink-ui/testing` renders a tree the way an app does (through `createStdin`, into a terminal of a given size) and
drives it. Write keys and `mouse("down", x, y)` reports, then `await idle()` until the output settles. Call `cleanup()`
after each test.

## Images

Images for Ink that never block the render loop.

- **Off the main thread.** Reading, probing, decoding and sending images all happen in a worker, which writes
  straight to the terminal's file descriptor. The main thread only lays out a grid of placeholder characters.
- **Fast paths only.** Kitty graphics with Unicode placeholders (Kitty ≥ 0.28, Ghostty): the terminal draws the image
  at full resolution, and it scrolls, clips and re-renders like text. Every other terminal gets a link to a file.
- **Detection that asks.** The terminal is queried for graphics support, whether it can read our files, its cell size
  and its name, with no fixed sleeps.
- **Little work.** PNGs are never decoded. A local PNG is sent as its path, and base64 is sent as it came. Other formats
  are decoded once, never larger than the window. Probes read headers only.
- **Smart scaling.** Give a width, a height, or both: the image keeps its aspect ratio and takes only the cells it
  fills, never more than its own size or the terminal's.

### Usage

```tsx
import { render } from "ink";
import { detectTerminal, Image, ImageProvider } from "better-ink-ui";

// before render(): detection reads stdin, which Ink takes over
const capabilities = await detectTerminal();

render(
  <ImageProvider capabilities={capabilities}>
    <Image src="./photo.jpg" width={40} alt="a photo" />
  </ImageProvider>
);
```

`src` takes a file path, `http(s):`/`file:` URL, data URL, base64 string, `Uint8Array`, or an explicit
`{ path } | { url } | { base64 } | { bytes }`.

| Prop       | Meaning                                                                        |
| ---------- | ------------------------------------------------------------------------------ |
| `width`    | Most columns; alone, the image scales to it and its rows follow                |
| `height`   | Most rows; alone, the image scales to it and its columns follow                |
| `upscale`  | Allow scaling past the image's own pixel size (default `false`)                |
| `alt`      | Description; the fallback link's text                                          |
| `loading`  | Shown while the header is read                                                 |
| `fallback` | `({ path, url, hyperlinks, alt }) => ReactNode` for terminals without graphics |
| `onLoad`   | Called with the image's size in pixels and cells                               |
| `onError`  | Called when the image can't be read                                            |

Without graphics, an image is written to `$TMPDIR/better-picture` (a local file links to itself). The link is OSC 8
where the terminal supports it, and the plain path otherwise.

`BETTER_PICTURE_PROTOCOL=kitty|none` forces the protocol. Install `sharp` to decode WebP, AVIF and TIFF, and to
decode JPEG and GIF faster. Without it, JPEG and GIF use pure-JS decoders, and other formats fall back to a link.

### Bundlers

By default the worker loads from `worker.mjs` beside the main module. A bundled app, such as
`bun build --compile`, should build `better-ink-ui/worker` as its own entrypoint and start it:

```ts
<ImageProvider capabilities={capabilities} worker={() => new Worker(new URL("./image-worker.js", import.meta.url))}>
```

### Limits

- Inside tmux or screen, images fall back to links.
- GIFs show their first frame.
- An image is at most 297×297 cells, the size of the protocol's placeholder table.
