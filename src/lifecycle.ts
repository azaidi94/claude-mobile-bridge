let _restart: (() => void) | null = null;

export function setRestartFn(fn: () => void) {
  _restart = fn;
}

export function triggerRestart() {
  if (!_restart) throw new Error("restart function not registered");
  _restart();
}
