import { totp } from "./totp.ts";

const ROOT = "https://apiconnect.angelone.in";

// Error codes SmartAPI returns when the JWT is invalid, expired or missing.
const SESSION_ERRORS = new Set(["AG8001", "AG8002", "AG8003", "AB1010"]);

export interface SmartApiOptions {
  apiKey: string;
  clientCode: string;
  pin: string;
  totpSecret: string;
  localIp: string;
  publicIp: string;
  macAddress: string;
}

interface Envelope<T = unknown> {
  status: boolean;
  message: string;
  errorcode: string;
  data: T;
}

export class SmartApiError extends Error {
  constructor(message: string, readonly code?: string, readonly httpStatus?: number) {
    super(code ? `${message} (${code})` : message);
  }
}

export class SmartApi {
  private jwt: string | null = null;
  private loginPromise: Promise<void> | null = null;

  constructor(private readonly opts: SmartApiOptions) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-UserType": "USER",
      "X-SourceID": "WEB",
      "X-ClientLocalIP": this.opts.localIp,
      "X-ClientPublicIP": this.opts.publicIp,
      "X-MACAddress": this.opts.macAddress,
      "X-PrivateKey": this.opts.apiKey,
    };
    if (this.jwt) h.Authorization = `Bearer ${this.jwt}`;
    return h;
  }

  private async raw<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<Envelope<T>> {
    const res = await fetch(ROOT + path, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let parsed: Envelope<T> & { success?: boolean; errorCode?: string };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new SmartApiError(`HTTP ${res.status}: ${text.slice(0, 300) || res.statusText}`, undefined, res.status);
    }
    // Gateway-level errors come back as {success, errorCode} instead of {status, errorcode}.
    const json: Envelope<T> = {
      status: parsed.status ?? parsed.success ?? false,
      message: parsed.message,
      errorcode: parsed.errorcode || parsed.errorCode || "",
      data: parsed.data,
    };
    if (res.status === 401 || res.status === 403) {
      throw new SmartApiError(json.message || res.statusText, json.errorcode || "AG8001", res.status);
    }
    return json;
  }

  private login(): Promise<void> {
    this.loginPromise ??= (async () => {
      this.jwt = null;
      const r = await this.raw<{ jwtToken: string }>("POST", "/rest/auth/angelbroking/user/v1/loginByPassword", {
        clientcode: this.opts.clientCode,
        password: this.opts.pin,
        totp: totp(this.opts.totpSecret),
      });
      if (!r.status || !r.data?.jwtToken) throw new SmartApiError(`Login failed: ${r.message}`, r.errorcode);
      this.jwt = r.data.jwtToken;
    })().finally(() => {
      this.loginPromise = null;
    });
    return this.loginPromise;
  }

  /** Authenticated call; logs in lazily and re-logs in once if the session expired. */
  async call<T = unknown>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    if (!this.jwt) await this.login();
    for (let attempt = 0; ; attempt++) {
      let r: Envelope<T>;
      try {
        r = await this.raw<T>(method, path, body);
      } catch (e) {
        // SmartAPI rate limits are per second; one short back-off is usually enough.
        if (attempt === 0 && e instanceof SmartApiError && e.httpStatus === 403 && /access rate/i.test(e.message)) {
          await Bun.sleep(1100);
          continue;
        }
        if (attempt === 0 && e instanceof SmartApiError && e.code && SESSION_ERRORS.has(e.code)) {
          await this.login();
          continue;
        }
        throw e;
      }
      if (r.status) return r.data;
      if (attempt === 0 && SESSION_ERRORS.has(r.errorcode)) {
        await this.login();
        continue;
      }
      const hint =
        r.errorcode === "AG8004"
          ? " — login accepted the key but this endpoint did not; the SmartAPI app likely lacks access (recreate it on smartapi.angelone.in)"
          : "";
      throw new SmartApiError((r.message || "SmartAPI request failed") + hint, r.errorcode);
    }
  }

  get<T = unknown>(path: string) {
    return this.call<T>("GET", path);
  }

  post<T = unknown>(path: string, body: unknown) {
    return this.call<T>("POST", path, body);
  }
}
