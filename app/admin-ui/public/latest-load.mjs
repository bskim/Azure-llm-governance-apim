export function createLatestLoad() {
  let generation = 0;
  let controller = null;

  return Object.freeze({
    begin() {
      generation += 1;
      controller?.abort();
      const currentController = new AbortController();
      controller = currentController;
      const currentGeneration = generation;
      return Object.freeze({
        signal: currentController.signal,
        isCurrent: () =>
          generation === currentGeneration
          && controller === currentController
          && !currentController.signal.aborted,
        finish() {
          if (generation === currentGeneration && controller === currentController) {
            controller = null;
          }
        },
      });
    },
    invalidate() {
      generation += 1;
      controller?.abort();
      controller = null;
    },
  });
}
