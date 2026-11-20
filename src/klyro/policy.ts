import { AddressPolicy, isTransportError, type ResolvedAddress } from '@iridium-group/transport';

export type PolicyCode =
  | 'BAD_URL'
  | 'BAD_SCHEME'
  | 'CREDENTIALS_IN_URL'
  | 'BLOCKED_HOST'
  | 'BLOCKED_PORT'
  | 'BLOCKED_ADDRESS'
  | 'UNSUPPORTED_AUTH'
  | 'UNRESOLVABLE';

/** A request Klyro refuses before making any outbound connection. */
export class PolicyError extends Error {
  readonly code: PolicyCode;
  readonly status: number;
  constructor(code: PolicyCode, message: string, status = 403) {
    super(message);
    this.name = 'PolicyError';
    this.code = code;
    this.status = status;
  }
}

/** Names that always mean "this machine or an internal network", whatever they resolve to. */
const BLOCKED_NAMES = [
  /^localhost$/,
  /\.localhost$/,
  /\.local$/,
  /\.internal$/,
  /\.intranet$/,
  /\.lan$/,
  /\.home$/,
  /\.corp$/,
  /^metadata(\.google\.internal)?$/,
  /^instance-data$/,
];

/**
 * Sign-in pages of large identity providers. Klyro does not handle credentials (see SECURITY.md),
 * so these are refused with a clear message instead of failing in confusing ways.
 */
const AUTH_HOSTS = [
  'accounts.google.com',
  'login.microsoftonline.com',
  'login.live.com',
  'appleid.apple.com',
  'id.apple.com',
  'signin.aws.amazon.com',
  'auth0.com',
];

export interface PolicyOptions {
  address: AddressPolicy;
  /** Extra hostnames (exact or suffix) to refuse. */
  blockedHosts?: readonly string[];
}

const matchesHost = (host: string, list: readonly string[]) =>
  list.some((h) => host === h || host.endsWith(`.${h}`));

export class Policy {
  readonly address: AddressPolicy;
  #extra: readonly string[];

  constructor(options: PolicyOptions) {
    this.address = options.address;
    this.#extra = (options.blockedHosts ?? []).map((h) => h.toLowerCase());
  }

  /** Check the URL text. Throws PolicyError. Does not resolve DNS. */
  checkUrl(url: URL, allowWebSocket = false): void {
    const schemes = allowWebSocket ? ['http:', 'https:', 'ws:', 'wss:'] : ['http:', 'https:'];
    if (!schemes.includes(url.protocol)) {
      throw new PolicyError('BAD_SCHEME', `Scheme ${url.protocol} is not supported`, 400);
    }
    if (url.username || url.password) {
      throw new PolicyError(
        'CREDENTIALS_IN_URL',
        'URLs with embedded credentials are not allowed',
        400,
      );
    }
    const host = url.hostname
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '')
      .toLowerCase();
    if (host === '') throw new PolicyError('BAD_URL', 'The URL has no host', 400);
    if (BLOCKED_NAMES.some((re) => re.test(host)) || matchesHost(host, this.#extra)) {
      throw new PolicyError('BLOCKED_HOST', `${host} is not allowed`);
    }
    if (matchesHost(host, AUTH_HOSTS)) {
      throw new PolicyError(
        'UNSUPPORTED_AUTH',
        `${host} is a sign-in page. Klyro does not handle passwords or sign-in flows, so it cannot be used here.`,
      );
    }
  }

  /**
   * Full check, including the port and DNS: every resolved address must be public. Returns the
   * single address to connect to, so the connection can be pinned to what was validated.
   */
  async check(url: URL, allowWebSocket = false): Promise<ResolvedAddress> {
    this.checkUrl(url, allowWebSocket);
    const port = url.port
      ? Number(url.port)
      : url.protocol === 'https:' || url.protocol === 'wss:'
        ? 443
        : 80;
    try {
      return await this.address.check({ host: url.hostname, port });
    } catch (error) {
      if (isTransportError(error)) {
        if (error.code === 'BLOCKED_PORT') throw new PolicyError('BLOCKED_PORT', error.message);
        if (error.code === 'BLOCKED_ADDRESS')
          throw new PolicyError('BLOCKED_ADDRESS', error.message);
        throw new PolicyError('UNRESOLVABLE', error.message, 502);
      }
      throw error;
    }
  }
}
