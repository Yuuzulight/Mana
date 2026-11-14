const API_VERSION = "v1";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

class ArcanaPageApiError extends Error {
  constructor(message, { status = null, code = "api_error", cause = undefined } = {}) {
    super(message, { cause });
    this.name = "ArcanaPageApiError";
    this.status = status;
    this.code = code;
  }
}

function normalizeEndpoint(endpoint) {
  let parsed;
  try { parsed = new URL(endpoint); }
  catch { throw new TypeError("Arcana API endpoint must be an absolute loopback URL"); }
  if (parsed.protocol !== "http:" || !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase()) || !parsed.port || parsed.pathname !== "/" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError("Arcana API endpoint must use HTTP on loopback with an explicit port");
  }
  return new URL("/", parsed).toString();
}

class ArcanaPageApiClient {
  constructor({ endpoint, token, fetchImpl = globalThis.fetch } = {}) {
    this.endpoint = normalizeEndpoint(endpoint);
    if (typeof token !== "string" || token.length === 0) throw new TypeError("Arcana API bearer token is required");
    if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");
    this.token = token;
    this.fetch = fetchImpl;
    this.origin = new URL(this.endpoint).origin;
  }

  async request(method, route, { body, signal, responseType = "json" } = {}) {
    const url = new URL(route, this.endpoint);
    if (url.origin !== this.origin || !url.pathname.startsWith("/v1/")) {
      throw new TypeError("Arcana API requests must stay on the authenticated v1 loopback endpoint");
    }
    const headers = { Authorization: `Bearer ${this.token}`, Accept: responseType === "bytes" ? "image/png, image/jpeg" : "application/json" };
    const options = { method, headers, signal };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }

    let response;
    try { response = await this.fetch(url, options); }
    catch (error) {
      const aborted = signal?.aborted || error?.name === "AbortError";
      throw new ArcanaPageApiError(aborted ? "Arcana API request was aborted" : "Arcana API request failed", {
        code: aborted ? "aborted" : "transport_error",
        cause: error,
      });
    }

    if (response.status === 204) return null;
    if (!response.ok) {
      let payload = null;
      try { payload = await response.json(); } catch { /* the status remains authoritative */ }
      const detail = payload?.error;
      throw new ArcanaPageApiError(detail?.message || `Arcana API returned HTTP ${response.status}`, {
        status: response.status,
        code: detail?.code || "http_error",
      });
    }
    if (responseType === "bytes") return Buffer.from(await response.arrayBuffer());
    try { return await response.json(); }
    catch (error) { throw new ArcanaPageApiError("Arcana API returned invalid JSON", { status: response.status, code: "invalid_response", cause: error }); }
  }

  async health(options) {
    const result = await this.request("GET", "/v1/health", options);
    if (result?.apiVersion !== API_VERSION) {
      throw new ArcanaPageApiError(`Arcana API version mismatch: expected ${API_VERSION}, received ${result?.apiVersion || "unknown"}`, {
        code: "api_version_mismatch",
      });
    }
    return result;
  }

  tabs(options) { return this.request("GET", "/v1/tabs", options); }
  createPage(url = "about:blank", options) { return this.request("POST", "/v1/pages", { ...options, body: { url } }); }
  closePage(pageId, options) { return this.request("DELETE", this.pageRoute(pageId), options); }
  snapshot(pageId, options) { return this.request("GET", this.pageRoute(pageId, "snapshot"), options); }
  navigate(pageId, url, options) { return this.pageAction(pageId, "navigate", { url }, options); }
  back(pageId, options) { return this.pageAction(pageId, "back", {}, options); }
  forward(pageId, options) { return this.pageAction(pageId, "forward", {}, options); }
  reload(pageId, options) { return this.pageAction(pageId, "reload", {}, options); }
  click(pageId, ref, options) { return this.pageAction(pageId, "click", { ref }, options); }
  fill(pageId, ref, value, options) { return this.pageAction(pageId, "fill", { ref, value }, options); }
  select(pageId, ref, value, options) { return this.pageAction(pageId, "select", { ref, value }, options); }
  press(pageId, key, options) { return this.pageAction(pageId, "press", { key }, options); }
  scroll(pageId, deltaX, deltaY, options) { return this.pageAction(pageId, "scroll", { deltaX, deltaY }, options); }
  clickAt(pageId, x, y, options) { return this.pageAction(pageId, "click-at", { x, y }, options); }
  typeText(pageId, value, options) { return this.pageAction(pageId, "type", { value }, options); }
  mouseWheel(pageId, deltaX, deltaY, options) { return this.pageAction(pageId, "mouse-wheel", { deltaX, deltaY }, options); }
  setViewport(pageId, width, height, options) { return this.pageAction(pageId, "viewport", { width, height }, options); }
  upload(pageId, ref, path, options) { return this.pageAction(pageId, "upload", { ref, path }, options); }
  wait(pageId, condition, value, timeoutMs, options) { return this.pageAction(pageId, "wait", { condition, value, timeoutMs }, options); }
  evaluate(pageId, expression, options) { return this.pageAction(pageId, "evaluate", { expression }, options); }
  logs(pageId, options) { return this.request("GET", this.pageRoute(pageId, "logs"), options); }
  cookies(pageId, options) { return this.request("GET", this.pageRoute(pageId, "cookies"), options); }
  storage(pageId, options) { return this.request("GET", this.pageRoute(pageId, "storage"), options); }
  setCookies(pageId, cookies, options) { return this.request("PUT", this.pageRoute(pageId, "cookies"), { ...options, body: cookies }); }
  setStorage(pageId, storage, options) { return this.request("PUT", this.pageRoute(pageId, "storage"), { ...options, body: storage }); }

  async screenshot(pageId, { format = "png", quality, ...options } = {}) {
    if (format !== "png" && format !== "jpeg") throw new TypeError("Screenshot format must be png or jpeg");
    const query = new URLSearchParams({ format });
    if (quality !== undefined) query.set("quality", String(quality));
    return this.request("GET", `${this.pageRoute(pageId, "screenshot")}?${query}`, { ...options, responseType: "bytes" });
  }

  pageAction(pageId, action, body, options) {
    return this.request("POST", this.pageRoute(pageId, action), { ...options, body });
  }

  pageRoute(pageId, action = "") {
    if (typeof pageId !== "string" || pageId.length === 0 || pageId === "." || pageId === "..") throw new TypeError("Arcana page id is required");
    if (action && !/^[a-z][a-z-]*$/.test(action)) throw new TypeError("Arcana page action is invalid");
    return `/v1/pages/${encodeURIComponent(pageId)}${action ? `/${action}` : ""}`;
  }
}

module.exports = { API_VERSION, ArcanaPageApiClient, ArcanaPageApiError };
