export interface OriginMatcher {
  readonly patterns: readonly string[];
  matches(origin: string): boolean;
}

interface CompiledPattern {
  scheme: string;
  /** Exact host, or the suffix after a leading `*.` (e.g. ".example.com"). */
  host: string;
  wildcardSubdomain: boolean;
  /** null = default port only, "*" = any port. */
  port: string | null;
}

const PATTERN = /^(https?):\/\/(\*\.)?([a-z0-9.-]+|\[[0-9a-f:]+\])(?::(\d+|\*))?$/i;

function compile(pattern: string): CompiledPattern | "any" {
  if (pattern === "*") return "any";
  const match = PATTERN.exec(pattern.trim());
  if (!match) {
    throw new Error(
      `Invalid origin pattern "${pattern}" (expected e.g. "https://example.com", "https://*.example.com", "http://localhost:*")`,
    );
  }
  const [, scheme, star, host, port] = match;
  return {
    scheme: scheme!.toLowerCase(),
    host: host!.toLowerCase(),
    wildcardSubdomain: Boolean(star),
    port: port ?? null,
  };
}

function defaultPort(scheme: string): string {
  return scheme === "https" ? "443" : "80";
}

/**
 * Compile origin patterns. Supported forms:
 * - `https://example.com` exact (default port)
 * - `https://*.example.com` any subdomain (one or more labels), not the bare domain
 * - `http://localhost:*` any port, including none
 * - `*` any origin
 */
export function compileOrigins(patterns: readonly string[]): OriginMatcher {
  const compiled = patterns.map(compile);
  return {
    patterns,
    matches(origin: string): boolean {
      let url: URL;
      try {
        url = new URL(origin);
      } catch {
        return false;
      }
      const scheme = url.protocol.replace(/:$/, "");
      const host = url.hostname.toLowerCase();
      const port = url.port || defaultPort(scheme);
      return compiled.some((p) => {
        if (p === "any") return true;
        if (p.scheme !== scheme) return false;
        if (p.wildcardSubdomain) {
          if (!host.endsWith("." + p.host)) return false;
        } else if (host !== p.host) {
          return false;
        }
        if (p.port === "*") return true;
        return (p.port ?? defaultPort(p.scheme)) === port;
      });
    },
  };
}
