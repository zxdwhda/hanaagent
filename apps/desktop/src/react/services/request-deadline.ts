/** Bound the full operation, including response body reads. */
export async function withRequestDeadline<T>(
  controller: AbortController,
  operation: () => Promise<T>,
  milliseconds = 30_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new DOMException('Request timed out', 'TimeoutError'));
      controller.abort();
    }, milliseconds);
  });
  try {
    return await Promise.race([operation(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
