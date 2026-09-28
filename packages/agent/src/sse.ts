/**
 * Minimal text/event-stream reader for POST /api/analyze (EventSource cannot POST). Handles comment
 * lines (": ping" keep-alives), multi-line data and events split across network chunks.
 */

export interface SseMessage {
  event: string;
  data: string;
}

export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let event = 'message';
  let data: string[] = [];
  const takeLine = (line: string): SseMessage | null => {
    if (line === '') {
      const msg = data.length ? { event, data: data.join('\n') } : null;
      event = 'message';
      data = [];
      return msg;
    }
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    return null;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        const msg = takeLine(line);
        if (msg) yield msg;
      }
    }
    // a stream that ends without the final blank line still delivers its last event
    if (buffer) takeLine(buffer.replace(/\r$/, ''));
    const last = takeLine('');
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}
