import { lookup as dnsLookup } from "node:dns";
import { BlockList, createConnection, isIP } from "node:net";
import { hostname as localHostname } from "node:os";
import { domainToASCII } from "node:url";
import { ClientTransportBase, parseEndpointUrl } from "node-opcua";
import type { IClientTransportFactory, TransportSettingsOptions } from "node-opcua";

type Address = { address: string; family: number };
type Resolver = (hostname: string, callback: (error: Error | null, addresses: Address[]) => void) => void;

export interface OutboundPolicy {
  hosts?: string[];
  addresses?: string[];
}

const resolve: Resolver = (hostname, callback) => dnsLookup(hostname, { all: true }, callback);
const forcedEndpointDiscovery = !!parseInt(process.env.NODEOPCUA_CLIENT_FORCE_ENDPOINT_DISCOVERY || "0", 10);

function normalizeHost(hostname: string): string {
  const host = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (isIP(host)) return host.toLowerCase();
  if (/[\\/:?#@\s%]/.test(host)) throw new Error("Invalid outbound hostname.");
  const ascii = domainToASCII(host).toLowerCase();
  if (
    !ascii ||
    ascii.length > 253 ||
    !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(ascii) ||
    ascii.split(".").some((label) => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
  ) {
    throw new Error("Invalid outbound hostname.");
  }
  return ascii;
}

export function createOutboundTransportFactory(
  policy: OutboundPolicy,
  resolver: Resolver = resolve,
): IClientTransportFactory {
  // node-opcua's forced discovery creates a temporary client without the injected factory.
  if (forcedEndpointDiscovery || !!parseInt(process.env.NODEOPCUA_CLIENT_FORCE_ENDPOINT_DISCOVERY || "0", 10)) {
    throw new Error("Forced node-opcua endpoint discovery is incompatible with outbound policy.");
  }
  const hosts = policy.hosts?.map(normalizeHost);
  const addresses = policy.addresses === undefined ? undefined : new BlockList();
  for (const rule of policy.addresses ?? []) {
    const parts = rule.split("/");
    const address = parts[0] ?? "";
    const family = isIP(address);
    if (!family || parts.length > 2 || (parts.length === 2 && !/^(0|[1-9][0-9]*)$/.test(parts[1] ?? ""))) {
      throw new Error("Invalid outbound address rule.");
    }
    const prefix = parts.length === 2 ? Number(parts[1]) : family === 4 ? 32 : 128;
    if (prefix > (family === 4 ? 32 : 128)) throw new Error("Invalid outbound address rule.");
    addresses!.addSubnet(address, prefix, family === 4 ? "ipv4" : "ipv6");
  }
  const allowed = (address: string): boolean => {
    const family = isIP(address);
    return !!family && (!addresses || addresses.check(address, family === 4 ? "ipv4" : "ipv6"));
  };

  class GuardedTransport extends ClientTransportBase {
    constructor(settings?: TransportSettingsOptions) {
      super(settings);
    }

    connect(endpointUrl: string, callback: (error?: Error) => void): void {
      let host: string;
      let port: number;
      try {
        const endpoint = parseEndpointUrl(endpointUrl);
        if (endpoint.protocol !== "opc.tcp:" || endpoint.auth) throw new Error("Invalid OPC UA endpoint.");
        host = normalizeHost(endpoint.hostname);
        port = endpoint.port ? Number(endpoint.port) : 4840;
        if (hosts && !hosts.includes(host)) throw new Error("Outbound hostname denied.");
        if (isIP(host) && !allowed(host)) throw new Error("Outbound address denied.");
      } catch (error) {
        callback(error instanceof Error ? error : new Error("Invalid OPC UA endpoint."));
        return;
      }
      this.endpointUrl = endpointUrl;
      this.serverUri = `urn:${localHostname()}:Sample`;
      const socket = createConnection({
        host,
        port,
        autoSelectFamily: true,
        lookup: (name, options, done) => {
          resolver(name, (error, results) => {
            const candidates = (results ?? []).filter(
              ({ address, family }) => isIP(address) === family && allowed(address),
            );
            if (error || candidates.length === 0) return done(error ?? new Error("Outbound address denied."), "", 0);
            if (options.all) return done(null, candidates);
            done(null, candidates[0]!.address, candidates[0]!.family);
          });
        },
      });
      try {
        this._install_socket(socket);
      } catch (error) {
        socket.destroy();
        callback(error instanceof Error ? error : new Error("Transport failed."));
        return;
      }
      socket.setTimeout(this.timeout, () => socket.destroy(new Error("Transport timeout.")));
      const onError = (error: Error) => {
        socket.removeListener("connect", onConnect);
        callback(error);
      };
      const onConnect = () => {
        socket.removeListener("error", onError);
        this._perform_HEL_ACK_transaction((error) => {
          if (!error) {
            if (!this._socket) return callback(new Error("Transport abandoned."));
            this._install_post_connect_error_handler(endpointUrl);
            this.emit("connect");
          }
          callback(error);
        });
      };
      socket.once("error", onError);
      socket.once("connect", onConnect);
    }
  }
  return { create: (settings) => new GuardedTransport(settings) };
}
