/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Server-sent events parsing, kept free of the `vscode` module so the unit tests can load it.

/**
 * Read a `text/event-stream` response, calling `onEvent(event, data)` per frame
 * (event defaults to "message"). Resolves when the stream ends.
 */
export async function readSse(res: Response, onEvent: (event: string, data: string) => void): Promise<void> {
  if (!res.body) {return;}
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let event = 'message';
  let data: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {break;}
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, '');
      if (line === '') {
        if (data.length) {onEvent(event, data.join('\n'));}
        event = 'message';
        data = [];
      } else if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''));
      }
    }
  }
}
