export class RemotePersistence {
  constructor(url, token, bypass) {
    this.url = url;
    this.token = token;
    this.bypass = bypass;
  }
  async call(action, room, args) {
    const protection = this.bypass
      ? this.bypass.startsWith("eyJ")
        ? { "x-vercel-trusted-oidc-idp-token": this.bypass }
        : { "x-vercel-protection-bypass": this.bypass }
      : {};
    const response = await fetch(`${this.url}/internal`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`,
        ...protection,
      },
      body: JSON.stringify({ action, room, args }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      let error;
      try {
        error = (await response.json()).error;
      } catch {}
      throw Error(error || `M0 commit service HTTP ${response.status}`);
    }
    return (await response.json()).result;
  }
  acquire(room, initial) {
    return this.call("acquire", room, [initial]);
  }
  commit(room, ...args) {
    return this.call("commit", room, args);
  }
  receipt(room, ...args) {
    return this.call("receipt", room, args);
  }
  replay(room, ...args) {
    return this.call("replay", room, args);
  }
}
