import { EventEmitter } from "node:events";
import type { LanchuEvent } from "./types.js";

/**
 * In-process event bus. The single source that feeds the three consumers
 * (panel SSE, MCP notifications and —roadmap— webhooks). See ARCHITECTURE.md §1.
 */
class EventBus extends EventEmitter {
  emitEvent(ev: LanchuEvent): void {
    this.emit("event", ev);
  }

  onEvent(listener: (ev: LanchuEvent) => void): () => void {
    this.on("event", listener);
    return () => this.off("event", listener);
  }
}

export const bus = new EventBus();
bus.setMaxListeners(0);
