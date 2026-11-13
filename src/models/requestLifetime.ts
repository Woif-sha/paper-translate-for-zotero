/** A deadline must reject even when a transport ignores abort, and abort its work. */
export async function withRequestDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectLifetime: (reason: unknown) => void = () => undefined;
  const cancel = (reason: unknown) => {
    controller.abort(reason);
    rejectLifetime(reason);
  };
  const onAbort = () =>
    cancel(parent?.reason ?? new Error("Model request cancelled / 请求已取消"));
  try {
    return await new Promise<T>((resolve, reject) => {
      rejectLifetime = reject;
      if (parent?.aborted) {
        onAbort();
        return;
      }
      parent?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(
        () =>
          cancel(
            new Error(
              `Model request timed out after ${timeoutMs / 1000}s / 请求超时，已取消`,
            ),
          ),
        timeoutMs,
      );
      void Promise.resolve()
        .then(() => {
          if (controller.signal.aborted) throw controller.signal.reason;
          return operation(controller.signal);
        })
        .then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    parent?.removeEventListener("abort", onAbort);
  }
}
