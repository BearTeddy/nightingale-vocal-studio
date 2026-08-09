export type ConsumableSubscriber<Action> = (action: Action) => boolean | void;

export function dispatchNewestFirst<Action>(
  subscribers: Iterable<ConsumableSubscriber<Action>>,
  action: Action,
): boolean {
  const ordered = Array.from(subscribers);
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    if (ordered[index](action) === true) return true;
  }
  return false;
}
