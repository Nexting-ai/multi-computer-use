/** A minimal Odoo JSON-RPC client (external API), used to seed and grade. */
export class Odoo {
  private constructor(
    private readonly url: string,
    readonly db: string,
    private readonly uid: number,
    private readonly password: string,
  ) {}

  static async call(
    url: string,
    service: string,
    method: string,
    args: unknown[],
  ) {
    const r = await fetch(`${url}/jsonrpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "call",
        params: { service, method, args },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const j = (await r.json()) as { result?: unknown; error?: any };
    if (j.error)
      throw Error(
        `odoo_rpc:${method}:${j.error.data?.message ?? j.error.message}`,
      );
    return j.result;
  }

  static async login(
    url: string,
    db: string,
    login = "admin",
    password = "admin",
  ) {
    const uid = (await Odoo.call(url, "common", "login", [
      db,
      login,
      password,
    ])) as number | false;
    if (!uid) throw Error(`odoo_login_failed:${db}`);
    return new Odoo(url, db, uid, password);
  }

  /** object.execute_kw(model, method, args, kwargs). */
  run<T = any>(
    model: string,
    method: string,
    args: unknown[] = [],
    kwargs: Record<string, unknown> = {},
  ): Promise<T> {
    return Odoo.call(this.url, "object", "execute_kw", [
      this.db,
      this.uid,
      this.password,
      model,
      method,
      args,
      kwargs,
    ]) as Promise<T>;
  }

  get user() {
    return this.uid;
  }
}
