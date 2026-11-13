// Minimal Server-Sent Events reader for fetch() response bodies.
// Yields the `data` payload of each event as a string.

/** @param {AsyncIterable<Uint8Array>} body */
export async function* sseData(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  let data = [];

  const takeLine = (line) => {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line === '') {
      if (!data.length) return null;
      const payload = data.join('\n');
      data = [];
      return payload;
    }
    if (line.startsWith(':')) return null; // comment / keep-alive
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    return null; // event:, id:, retry: are not needed here
  };

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const payload = takeLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (payload !== null) yield payload;
    }
  }
  buffer += decoder.decode();
  if (buffer) takeLine(buffer);
  if (data.length) yield data.join('\n');
}
