import { shrink } from '../model/rows';

export type WireFrame = { _tag: string; id?: string; tag?: string; requestId?: string; [key: string]: unknown };

export type ToWorker =
  | { type: 'open'; id: string; url: string }
  | { type: 'send'; id: string; frame: WireFrame }
  | { type: 'close'; id: string };

export type FromWorker =
  | { type: 'open'; id: string }
  | { type: 'failed'; id: string }
  | { type: 'closed'; id: string; reason: string }
  | { type: 'frames'; id: string; frames: unknown[] };

const sockets = new Map<string, { ws: WebSocket; tags: Map<string, string> }>();

function post(message: FromWorker): void {
  postMessage(message);
}

function open(id: string, url: string): void {
  const ws = new WebSocket(url);
  const entry = { ws, tags: new Map<string, string>() };
  sockets.set(id, entry);
  let opened = false;
  ws.onopen = () => {
    opened = true;
    post({ type: 'open', id });
  };
  ws.onerror = () => {
    if (!opened) post({ type: 'failed', id });
  };
  ws.onclose = event => {
    sockets.delete(id);
    if (opened) post({ type: 'closed', id, reason: event.reason || `closed (${event.code})` });
    else post({ type: 'failed', id });
  };
  ws.onmessage = event => {
    let parsed: any;
    try {
      parsed = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const now = Date.now();
    const frames = (Array.isArray(parsed) ? parsed : [parsed]).map(frame => {
      if (frame?._tag === 'Chunk') {
        ws.send(JSON.stringify({ _tag: 'Ack', requestId: frame.requestId }));
        const tag = entry.tags.get(frame.requestId) ?? '';
        return { ...frame, values: frame.values.map((value: unknown) => shrink(tag, value, now)) };
      }
      if (frame?._tag === 'Exit') entry.tags.delete(frame.requestId);
      return frame;
    });
    post({ type: 'frames', id, frames });
  };
}

onmessage = (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  if (message.type === 'open') {
    open(message.id, message.url);
    return;
  }
  const entry = sockets.get(message.id);
  if (!entry) return;
  if (message.type === 'close') {
    entry.ws.close();
    return;
  }
  if (message.frame._tag === 'Request' && message.frame.id && message.frame.tag) {
    entry.tags.set(message.frame.id, message.frame.tag);
  }
  if (entry.ws.readyState === WebSocket.OPEN) entry.ws.send(JSON.stringify(message.frame));
};
