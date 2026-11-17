/** Validação de URL de provider compartilhada por config e store (I-03). */
import { lookup } from "node:dns/promises";

const SENSITIVE_QUERY = /^(api[-_]?key|key|token|access[-_]?token|secret)$/i;

/** Hosts de metadados de nuvem conhecidos (nunca são destinos legítimos). */
const METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
  "metadata.tencentyun.com",
]);

function parse(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

function ipv4Private(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN));
  if (nums.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = nums as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function bareHost(hostname: string): string {
  const lower = hostname.toLowerCase().replace(/\.$/, "");
  return lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower;
}

function isIpv6Literal(hostname: string): boolean {
  return hostname.startsWith("[") && hostname.endsWith("]");
}

/** Prefixos ULA de metadados: AWS IMDS/EKS Pod Identity e GCP. */
function isMetadataIpv6(host: string): boolean {
  return host.startsWith("fd00:ec2:") || host.startsWith("fd20:ce:");
}

/** IPv4 link-local (169.254/16) ou CGNAT (100.64/10), sempre metadados. */
function ipv4LinkLocalOrCgnat(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN));
  if (nums.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = nums as [number, number, number, number];
  return (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

/** IPv4 embutido em IPv6 mapeado (`::ffff:a.b.c.d` ou `::ffff:xxxx:xxxx`). */
function mappedIpv4(host: string): string | undefined {
  const mapped = /^::ffff:(.+)$/.exec(host);
  if (mapped === null) return undefined;
  const rest = mapped[1]!.toLowerCase();
  if (rest.includes(".")) return rest;
  const groups = rest.split(":");
  if (groups.length !== 2 || !groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return undefined;
  const hi = Number.parseInt(groups[0]!, 16);
  const lo = Number.parseInt(groups[1]!, 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
}

function ipv6Private(hostname: string): boolean {
  if (!isIpv6Literal(hostname)) return false;
  const lower = bareHost(hostname);
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(lower)) return true;
  if (/^::ffff:/.test(lower)) {
    const mapped = mappedIpv4(lower);
    return mapped === undefined ? true : ipv4Private(mapped);
  }
  return false;
}

function isMetadataOrLinkLocal(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  const bare = bareHost(host);
  if (METADATA_HOSTS.has(host) || METADATA_HOSTS.has(bare)) return true;
  if (ipv4LinkLocalOrCgnat(bare)) return true;
  if (!isIpv6Literal(host)) return false;
  const mapped = mappedIpv4(bare);
  if (mapped !== undefined && ipv4LinkLocalOrCgnat(mapped)) return true;
  if (isMetadataIpv6(bare)) return true;
  return bare.startsWith("fe8")
    || bare.startsWith("fe9")
    || bare.startsWith("fea")
    || bare.startsWith("feb");
}

function isPrivateHost(url: URL): boolean {
  const bare = bareHost(url.hostname);
  if (bare === "localhost" || bare.endsWith(".localhost")) return true;
  return ipv4Private(bare) || ipv6Private(url.hostname);
}

/** Opt-in explícito para destinos privados em desenvolvimento local. */
export function privateUrlsAllowed(): boolean {
  return process.env.ASTRO_ALLOW_PRIVATE_URLS === "1";
}

export function urlProblem(raw: string): string | undefined {
  const url = parse(raw);
  if (url === undefined) return "não é uma URL http(s) válida";
  if (url.protocol !== "http:" && url.protocol !== "https:") return "não é uma URL http(s) válida";
  if (url.username !== "" || url.password !== "") return "não pode embutir credencial; use credentialRef";
  if (isMetadataOrLinkLocal(url)) {
    return "aponta para host de metadados ou link-local; destino recusado";
  }
  for (const key of url.searchParams.keys()) {
    if (SENSITIVE_QUERY.test(key)) {
      return `não pode levar credencial na query (${key}); use credentialRef`;
    }
  }
  return undefined;
}

/**
 * URL de saída que recebe dado do harness (webhook, telemetria, MCP, instalação
 * de skill). Além das regras de `urlProblem`, recusa loopback e faixas privadas
 * para evitar SSRF/exfiltração; `allowPrivate` (opt-in de dev) libera loopback,
 * RFC1918, ULA e faixas reservadas, nunca metadados/link-local.
 */
export function outboundUrlProblem(raw: string, opts: { allowPrivate?: boolean } = {}): string | undefined {
  const base = urlProblem(raw);
  if (base !== undefined) return base;
  const url = parse(raw)!;
  const allowPrivate = opts.allowPrivate ?? privateUrlsAllowed();
  if (allowPrivate) return undefined;
  if (isPrivateHost(url)) return "aponta para host privado ou loopback; destino recusado";
  return undefined;
}

/**
 * `fetch` com `redirect: "error"` recusou seguir um 3xx. Bun expõe
 * `UnexpectedRedirect` na mensagem; Node/undici põe `unexpected redirect` na
 * `cause`. Usado só para classificar o erro, nunca para decidir o destino.
 */
export function isRedirectRefusal(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 4; depth++) {
    if (/redirect/i.test(current.message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Valida o literal e todos os endereços resolvidos (SSRF/DNS rebinding).
 * Assíncrono porque consulta o DNS; use antes de cada request de saída, em
 * especial depois de cada redirect.
 */
export async function resolvedOutboundUrlProblem(
  raw: string,
  opts: { allowPrivate?: boolean } = {},
): Promise<string | undefined> {
  const literal = outboundUrlProblem(raw, opts);
  if (literal !== undefined) return literal;
  const host = new URL(raw).hostname.replace(/^\[|\]$/g, "");
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    return "não foi possível resolver o host";
  }
  if (addresses.length === 0) return "host sem endereço";
  for (const { address } of addresses) {
    const blocked = outboundUrlProblem(`http://${address.includes(":") ? `[${address}]` : address}/`, opts);
    if (blocked !== undefined) return blocked;
  }
  return undefined;
}
