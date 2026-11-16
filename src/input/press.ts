/**
 * The press being dispatched to mouse targets, while it is: what lets the focus tell that a press
 * already moved it — to a target nested in another, or wherever a button's handler sent it — so
 * the targets the press goes on to leave it be.
 */
let current: object | null = null;

/** @internal Runs the handlers of one press. */
export const withPress = (press: object, run: () => void) => {
  const previous = current;
  current = press;
  try {
    run();
  } finally {
    current = previous;
  }
};

/** @internal The press being dispatched, or null outside of one. */
export const currentPress = () => current;
