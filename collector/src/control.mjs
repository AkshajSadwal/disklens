/**
 * Listen for a newline-delimited `cancel` command from the parent process.
 * The pipe-based control channel is reliable on Windows, unlike SIGINT delivery
 * to child processes. The returned dispose method closes the input handle once
 * the collector has finished so it cannot keep Node alive.
 */
export function bindCancellationInput(input, controller, onCancel = () => {}) {
  let buffer = "";
  let cancelled = false;

  const requestCancellation = () => {
    if (cancelled) return;
    cancelled = true;
    controller.abort();
    onCancel();
  };

  const handleData = (chunk) => {
    buffer = `${buffer}${String(chunk)}`.slice(-256);
    if (buffer.toLowerCase().includes("cancel")) requestCancellation();
  };

  input.setEncoding?.("utf8");
  input.on("data", handleData);

  return {
    requestCancellation,
    get cancelled() { return cancelled; },
    dispose() {
      input.removeListener("data", handleData);
      input.pause?.();
      input.destroy?.();
    },
  };
}
