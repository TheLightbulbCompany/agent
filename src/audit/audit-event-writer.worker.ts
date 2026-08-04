/** Worker-thread entrypoint for serialized audit writes and retention maintenance. */
import { parentPort, workerData } from "node:worker_threads";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { pruneExpiredAuditEvents, recordAuditEvent } from "./audit-event-store.js";
import type { AuditEventInput } from "./audit-event-types.js";

const AUDIT_MAINTENANCE_INTERVAL_MS = 60 * 60_000;

type AuditWriterRequest = { type: "record"; input: AuditEventInput } | { type: "stop" };

const stateDir =
  workerData && typeof workerData === "object" && typeof workerData.stateDir === "string"
    ? workerData.stateDir
    : undefined;
if (!parentPort || !stateDir) {
  throw new Error("audit event writer requires a parent port and state directory");
}
const port = parentPort;
// Spread process.env: this worker is the only site in the tree that built a
// synthetic env from scratch, which silently dropped any other DB-resolution
// variable the process was started with (e.g. OPENCLAW_SQLITE_DIR). The result
// was an audit database resolved to a DIFFERENT directory than every other
// store — on deployments that relocate SQLite, a second state DB left behind on
// the original filesystem, written on the hot path and read by nothing. Every
// other call site already spreads (see src/infra/push-apns-store.ts:92).
const database = { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };

function reportMaintenance(): void {
  try {
    pruneExpiredAuditEvents({ database });
  } catch (error) {
    port.postMessage({ type: "maintenance-error", error: String(error) });
  }
}

reportMaintenance();
const maintenanceTimer = setInterval(reportMaintenance, AUDIT_MAINTENANCE_INTERVAL_MS);
port.postMessage({ type: "ready" });

port.on("message", (message: AuditWriterRequest) => {
  if (message.type === "record") {
    try {
      recordAuditEvent(message.input, database);
      port.postMessage({ type: "recorded" });
    } catch (error) {
      port.postMessage({ type: "record-error", error: String(error) });
    }
    return;
  }
  clearInterval(maintenanceTimer);
  reportMaintenance();
  try {
    closeOpenClawStateDatabase();
  } catch (error) {
    port.postMessage({ type: "maintenance-error", error: String(error) });
  }
  port.postMessage({ type: "stopped" });
  port.close();
});
