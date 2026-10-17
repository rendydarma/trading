// Shared MCP tool-result wrapper: objects as 2-space JSON (single line with compact), strings as-is, errors as isError results.
export async function runTool(fn, { compact = false } = {}) {
  try {
    const data = await fn();
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, compact ? 0 : 2);
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: 'text', text: `Error: ${message}` }] };
  }
}
