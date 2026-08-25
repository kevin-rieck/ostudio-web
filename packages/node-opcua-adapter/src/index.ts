import type { OPCUAClient } from "node-opcua";

export interface NodeOpcuaClientHandle {
  readonly client: OPCUAClient;
}
