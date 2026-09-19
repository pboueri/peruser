// Message types shared by the extension and the bridge. Kept in one place so
// both sides (and the tests) agree on names.

export const MSG = {
  // side panel / worker <-> content script
  PING: 'ping',
  STATUS: 'status',
  OUTLINE: 'outline',
  INSPECT: 'inspect',
  PREVIEW: 'preview',
  CLEAR_PREVIEW: 'clearPreview',
  VERIFY: 'verify',
  REFRESH: 'refresh',
  TOGGLE: 'toggle',
  SET_VIEW: 'setView',
  TOAST: 'toast',

  // side panel <-> worker
  AGENT_START: 'agent.start',
  AGENT_CANCEL: 'agent.cancel',
  AGENT_EVENT: 'agent.event',
  BRIDGE_STATUS: 'bridge.status',
  BRIDGE_STATUS_EVENT: 'bridge.statusChanged',
  BRIDGE_REQUEST: 'bridge.request',
  CATALOG_UPDATED: 'catalog.updated',
  CYCLE_VIEW: 'cycleView',

  // worker <-> bridge (over WebSocket, JSON frames {id?, type, ...})
  HELLO: 'hello',
  CATALOG: 'catalog',
  SAVE_PATCH: 'savePatch',
  DELETE_PATCH: 'deletePatch',
  SAVE_VIEW: 'saveView',
  DELETE_VIEW: 'deleteView',
  SET_ACTIVE_VIEW: 'setActiveView',
  SAVE_PROFILE: 'saveProfile',
  RUN_JS: 'runJs',
  TOOL_CALL: 'tool.call',
  TOOL_RESULT: 'tool.result',
  ERROR: 'error',
  OK: 'ok',
};

export const TOOLS = ['page_outline', 'inspect', 'preview_patch', 'verify', 'clear_preview', 'finish'];

export const DEFAULT_BRIDGE_PORT = 48923;

let counter = 0;
export function nextId(prefix = 'm') {
  counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
}

/** Wrap a request/response over any duplex "send(frame)" channel. */
export function createRequestChannel(send, { timeoutMs = 60_000 } = {}) {
  const pending = new Map();
  return {
    request(frame) {
      const id = nextId('r');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`timeout waiting for ${frame.type}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          send({ ...frame, id });
        } catch (e) {
          clearTimeout(timer);
          pending.delete(id);
          reject(e);
        }
      });
    },
    /** Feed an incoming frame. Returns true if it settled a pending request. */
    handle(frame) {
      if (!frame || !frame.id || !pending.has(frame.id)) return false;
      const p = pending.get(frame.id);
      pending.delete(frame.id);
      clearTimeout(p.timer);
      if (frame.type === MSG.ERROR) p.reject(new Error(frame.error || 'error'));
      else p.resolve(frame);
      return true;
    },
    rejectAll(reason) {
      for (const [id, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error(reason));
        pending.delete(id);
      }
    },
    get size() {
      return pending.size;
    },
  };
}
