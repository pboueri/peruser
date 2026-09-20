// The bridge: one WebSocket server on localhost that
//   - serves the patch catalog to the extension and pushes changes,
//   - accepts save/delete requests from the extension and writes files,
//   - starts agent runs, proxies the agent's tool calls to the tab,
//   - streams agent events (transcript, tool calls, verification) to the panel.

import { WebSocketServer } from 'ws';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { MSG, nextId, createRequestChannel } from '../../src/lib/protocol.js';
import { runTool, TOOL_NAMES } from './tools.js';
import { systemPrompt, userPrompt } from './prompt.js';
import { profileForPrompt } from '../../src/lib/profile.js';

export const VERSION = '0.1.0';

const RUN_TIMEOUT_MS = 15 * 60 * 1000;

export class Bridge extends EventEmitter {
  constructor({ store, harnesses, port = 0, host = '127.0.0.1', log = () => {}, mcpCommand = null, runTimeoutMs = RUN_TIMEOUT_MS }) {
    super();
    this.store = store;
    this.harnesses = harnesses; // { get(name) -> harness, available() -> [{name, available}] }
    this.port = port;
    this.host = host;
    this.log = log;
    this.mcpCommand = mcpCommand; // { command, args } for the stdio MCP tool server
    this.runTimeoutMs = runTimeoutMs;
    this.wss = null;
    this.extension = null; // { ws, channel }
    this.runs = new Map();
    this.onStoreChange = (catalog) => this.pushCatalog(catalog);
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ port: this.port, host: this.host });
      this.wss.once('listening', resolve);
      this.wss.once('error', reject);
    });
    this.port = this.wss.address().port;
    this.wss.on('connection', (ws) => this.onConnection(ws));
    this.store.on('change', this.onStoreChange);
    this.log(`bridge listening on ws://${this.host}:${this.port}`);
    return this.port;
  }

  async stop() {
    this.store.off('change', this.onStoreChange);
    for (const run of this.runs.values()) run.abort.abort();
    if (this.wss) {
      for (const c of this.wss.clients) c.terminate();
      await new Promise((resolve) => this.wss.close(resolve));
      this.wss = null;
    }
  }

  get url() {
    return `ws://${this.host}:${this.port}`;
  }

  // ---- connections ----------------------------------------------------------

  onConnection(ws) {
    const client = { ws, role: null, run: null, channel: createRequestChannel((f) => ws.send(JSON.stringify(f))) };
    ws.on('message', (data) => {
      let frame;
      try {
        frame = JSON.parse(String(data));
      } catch {
        return send(ws, { type: MSG.ERROR, error: 'invalid JSON' });
      }
      this.onFrame(client, frame).catch((e) => send(ws, { id: frame.id, type: MSG.ERROR, error: e.message }));
    });
    ws.on('close', () => {
      client.channel.rejectAll('connection closed');
      if (this.extension === client) {
        this.extension = null;
        this.log('extension disconnected');
      }
    });
    ws.on('error', () => {});
  }

  async onFrame(client, frame) {
    if (client.channel.handle(frame)) return; // a reply to something we asked
    const reply = (data) => send(client.ws, { id: frame.id, type: MSG.OK, ...data });
    switch (frame.type) {
      case MSG.HELLO:
        return this.onHello(client, frame, reply);
      case MSG.PING:
        return reply({ pong: true, at: Date.now() });
      case MSG.CATALOG:
        return reply({ catalog: this.store.catalog, problems: this.store.problems });
      case MSG.SAVE_PATCH:
        return reply({ patch: await this.store.savePatch(frame.patch), path: this.store.pathOf(frame.patch?.id) });
      case MSG.DELETE_PATCH:
        return reply({ deleted: await this.store.deletePatch(frame.patchId) });
      case MSG.SAVE_VIEW:
        return reply({ view: await this.store.saveView(frame.view) });
      case MSG.DELETE_VIEW:
        return reply({ deleted: await this.store.deleteView(frame.viewId) });
      case MSG.SAVE_PROFILE:
        return reply({ profile: await this.store.saveProfile(frame.profile) });
      case MSG.SET_ACTIVE_VIEW:
        return reply({ activeViews: await this.store.setActiveView(frame.origin, frame.viewId ?? null) });
      case MSG.AGENT_START:
        return reply({ runId: this.startRun(client, frame) });
      case MSG.AGENT_CANCEL:
        return reply({ cancelled: this.cancelRun(frame.runId) });
      case MSG.TOOL_CALL:
        return reply({ result: await this.toolCallFromProcess(client, frame) });
      default:
        throw new Error(`unknown message type ${frame.type}`);
    }
  }

  onHello(client, frame, reply) {
    if (frame.role === 'extension') {
      if (this.extension && this.extension !== client) this.extension.ws.close(4000, 'replaced by a newer extension connection');
      client.role = 'extension';
      this.extension = client;
      this.log('extension connected');
      return reply({
        version: VERSION,
        root: this.store.root,
        harnesses: this.harnesses.available(),
        catalog: this.store.catalog,
        problems: this.store.problems,
      });
    }
    if (frame.role === 'tool') {
      const run = this.runs.get(frame.runId);
      if (!run || run.token !== frame.token) throw new Error('unknown run or bad token');
      client.role = 'tool';
      client.run = run;
      return reply({ tools: TOOL_NAMES });
    }
    throw new Error(`unknown role ${frame.role}`);
  }

  pushCatalog(catalog) {
    if (this.extension) send(this.extension.ws, { type: MSG.CATALOG, catalog, problems: this.store.problems });
  }

  // ---- talking to the tab -----------------------------------------------------

  async callTab(run, kind, payload) {
    if (!this.extension) throw new Error('the extension is not connected');
    const res = await this.extension.channel.request({ type: MSG.TOOL_CALL, runId: run.id, tabId: run.tabId, kind, payload });
    return res.result;
  }

  toolContext(run) {
    return {
      allowJs: run.allowJs,
      callTab: (kind, payload) => this.callTab(run, kind, payload),
      finish: (result) => {
        run.result = result;
        this.emitRun(run, { kind: 'finish', result });
      },
    };
  }

  /** Execute a tool on behalf of a run, emitting transcript events. */
  async executeTool(run, name, input) {
    if (run.finished) throw new Error('run already finished');
    this.emitRun(run, { kind: 'tool_call', tool: name, input });
    try {
      const result = await runTool(name, input, this.toolContext(run));
      this.emitRun(run, { kind: 'tool_result', tool: name, result });
      return result;
    } catch (e) {
      this.emitRun(run, { kind: 'tool_error', tool: name, error: e.message });
      throw e;
    }
  }

  async toolCallFromProcess(client, frame) {
    if (client.role !== 'tool') throw new Error('not a tool connection');
    return this.executeTool(client.run, frame.tool, frame.input);
  }

  // ---- runs -------------------------------------------------------------------

  emitRun(run, event) {
    const e = { ...event, at: Date.now() };
    run.events.push(e);
    if (this.extension) send(this.extension.ws, { type: MSG.AGENT_EVENT, runId: run.id, event: e });
    this.emit('run-event', run, e);
  }

  startRun(client, frame) {
    if (client.role !== 'extension') throw new Error('only the extension can start runs');
    if (!frame.prompt || !frame.url || frame.tabId == null) throw new Error('agent.start needs prompt, url and tabId');
    const harness = this.harnesses.get(frame.harness);
    if (!harness) throw new Error(`unknown harness ${frame.harness}`);
    const run = {
      id: nextId('run'),
      token: randomBytes(16).toString('hex'),
      tabId: frame.tabId,
      url: frame.url,
      prompt: frame.prompt,
      harness: harness.name,
      model: frame.model || '',
      allowJs: !!frame.allowJs,
      abort: new AbortController(),
      events: [],
      result: null,
      finished: false,
      startedAt: Date.now(),
    };
    this.runs.set(run.id, run);
    const timer = setTimeout(() => run.abort.abort(new Error('run timed out')), this.runTimeoutMs);
    timer.unref?.();
    this.emitRun(run, { kind: 'status', text: `Starting ${harness.name}…` });

    const mcp = this.mcpCommand
      ? {
          command: this.mcpCommand.command,
          args: this.mcpCommand.args,
          env: { PERUSER_BRIDGE_URL: this.url, PERUSER_RUN_ID: run.id, PERUSER_RUN_TOKEN: run.token },
        }
      : null;
    const system = systemPrompt({ url: run.url, harness: harness.name, allowJs: run.allowJs });
    const prompt = userPrompt({
      request: run.prompt,
      profile: profileForPrompt(this.store.profile),
      history: frame.history || [],
      existingPatch: frame.existingPatch || null,
      volatility: frame.volatility || null,
      acknowledged: !!frame.acknowledged,
    });

    harness
      .run({
        run,
        system,
        prompt,
        model: run.model,
        mcp,
        signal: run.abort.signal,
        callTool: (name, input) => this.executeTool(run, name, input),
        onEvent: (event) => this.emitRun(run, event),
      })
      .then(
        (info) => this.finishRun(run, info || {}),
        (e) => this.finishRun(run, { error: e.message }),
      )
      .finally(() => clearTimeout(timer));
    return run.id;
  }

  finishRun(run, info) {
    run.finished = true;
    if (info.error && !run.result) this.emitRun(run, { kind: 'error', error: info.error });
    else if (!run.result) this.emitRun(run, { kind: 'error', error: 'The agent stopped without calling finish.' + (info.lastText ? ` Its last message: ${info.lastText}` : '') });
    this.emitRun(run, { kind: 'done', ok: !!run.result, cost: info.cost ?? null, turns: info.turns ?? null });
    setTimeout(() => this.runs.delete(run.id), 60_000).unref?.();
  }

  cancelRun(runId) {
    const run = this.runs.get(runId);
    if (!run || run.finished) return false;
    run.abort.abort(new Error('cancelled by user'));
    return true;
  }
}

function send(ws, frame) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
}
