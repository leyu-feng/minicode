import type { Server, IncomingMessage } from "node:http";
import { WebSocketServer } from "ws";
import type { Db } from "@paperclipai/db";
import { agentPoolService } from "../services/agent-pools.js";
import { agentPoolBroker, AGENT_POOL_MAX_FRAME } from "../services/agent-pool-broker.js";
import { logger } from "../middleware/logger.js";

type UpgradeRequest = IncomingMessage & { paperclipWebSocketHandled?: boolean };

export function setupAgentPoolWebSocketServer(server: Server, db: Db) {
  const svc = agentPoolService(db);
  const prepareExecution = (ctx: Parameters<typeof svc.prepareExecution>[0]) => svc.prepareExecution(ctx);
  agentPoolBroker.prepareExecution = prepareExecution;
  const wss = new WebSocketServer({ noServer: true, maxPayload: AGENT_POOL_MAX_FRAME });
  const alive = new Set<object>();
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.delete(ws)) { ws.terminate(); continue; }
      ws.ping();
    }
  }, 15_000);
  timer.unref();
  server.on("upgrade", (rawReq, socket, head) => {
    const req: UpgradeRequest = rawReq;
    if (req.paperclipWebSocketHandled) return;
    const url = new URL(req.url ?? "", "http://localhost");
    if (url.pathname !== "/api/agent-pool/worker") return;
    req.paperclipWebSocketHandled = true;
    const reject = () => {
      if (!socket.destroyed) socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    };
    const workerId = url.searchParams.get("workerId") ?? "";
    const token = req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if (!/^[a-f0-9-]{36}$/.test(workerId) || !token || req.headers.origin) { reject(); return; }
    const onError = () => socket.destroy();
    socket.on("error", onError);
    void svc.authenticate(workerId, token).then((identity) => {
      if (!identity) { reject(); return; }
      if (socket.destroyed) return;
      socket.off("error", onError);
      wss.handleUpgrade(req, socket, head, (ws) => {
        alive.add(ws);
        ws.on("pong", () => alive.add(ws));
        ws.on("close", () => alive.delete(ws));
        agentPoolBroker.attach(identity, ws);
      });
    }).catch((err: unknown) => {
      logger.error({ err, workerId }, "AgentPool worker authentication failed");
      reject();
    });
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    agentPoolBroker.close();
    if (agentPoolBroker.prepareExecution === prepareExecution) agentPoolBroker.prepareExecution = undefined;
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  };
  server.once("close", close);
  return close;
}
