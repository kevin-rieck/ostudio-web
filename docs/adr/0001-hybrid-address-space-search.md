# Hybrid Address Space Search

OPC UA Studio will implement Address Space Search as a hybrid of OPC UA Part 17 Alias Names and rate-limited Address Space metadata indexing. Alias Names provide the preferred semantic, human-readable lookup path, but many real OPC UA Servers do not expose them, so the app also searches browsed and shallow-indexed metadata while avoiding aggressive server crawling.

## Considered Options

- Alias Names only: semantically strong, but unusable on servers without Part 17 support.
- Eager full Address Space crawling: broad compatibility, but risky for large or fragile industrial servers.
- Hybrid Alias Names plus demand-triggered shallow indexing: compatible, useful, and conservative about server load.

## Consequences

Search Results may be incomplete until more of the Address Space has been browsed or indexed. The UI should make this limitation visible without treating unsupported Alias Names as an operational error.
