const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const API_NAME = "VTubeStudioPublicAPI";
const API_VERSION = "1.0";

class VTubeStudioClient {
  constructor(options = {}) {
    this.url = options.url || "ws://127.0.0.1:8001";
    this.pluginName = options.pluginName || "Mana";
    this.pluginDeveloper = options.pluginDeveloper || "ManaAI";
    this.tokenFile =
      options.tokenFile ||
      path.join(__dirname, "config", "vtube-studio-token.json");
    this.socket = null;
    this.pending = new Map();
    this.requestCounter = 0;
    this.authenticated = false;
  }

  async connect() {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return;
    }

    await new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error(`VTube Studio connection timed out at ${this.url}`));
      }, 5000);

      socket.once("open", () => {
        clearTimeout(timeout);
        this.socket = socket;
        this.socket.on("message", (message) => this.handleMessage(message));
        this.socket.on("close", () => this.handleClose());
        this.socket.on("error", () => {});
        resolve();
      });

      socket.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  handleMessage(message) {
    let payload;
    try {
      payload = JSON.parse(message.toString("utf8"));
    } catch (error) {
      return;
    }

    const request = this.pending.get(payload.requestID);
    if (!request) {
      return;
    }

    clearTimeout(request.timeout);
    this.pending.delete(payload.requestID);

    if (payload.messageType === "APIError") {
      request.reject(
        new Error(
          `VTube Studio API error ${payload.data?.errorID}: ${payload.data?.message}`,
        ),
      );
      return;
    }

    request.resolve(payload);
  }

  handleClose() {
    this.authenticated = false;
    this.socket = null;

    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error("VTube Studio connection closed"));
    }
    this.pending.clear();
  }

  async request(messageType, data = {}) {
    await this.connect();

    const requestID = `mana-${Date.now()}-${++this.requestCounter}`;
    const payload = {
      apiName: API_NAME,
      apiVersion: API_VERSION,
      requestID,
      messageType,
      data,
    };

    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestID);
        reject(new Error(`VTube Studio request timed out: ${messageType}`));
      }, 10000);

      this.pending.set(requestID, { resolve, reject, timeout });
      this.socket.send(JSON.stringify(payload), (error) => {
        if (error) {
          clearTimeout(timeout);
          this.pending.delete(requestID);
          reject(error);
        }
      });
    });
  }

  loadToken() {
    try {
      const tokenData = JSON.parse(fs.readFileSync(this.tokenFile, "utf8"));
      return typeof tokenData.authenticationToken === "string"
        ? tokenData.authenticationToken
        : null;
    } catch (error) {
      return null;
    }
  }

  saveToken(authenticationToken) {
    fs.mkdirSync(path.dirname(this.tokenFile), { recursive: true });
    fs.writeFileSync(
      this.tokenFile,
      JSON.stringify({ authenticationToken }, null, 2),
    );
  }

  async getState() {
    const response = await this.request("APIStateRequest");
    return response.data || {};
  }

  async authenticate() {
    const existingToken = this.loadToken();
    if (existingToken) {
      const authenticated = await this.authenticateWithToken(existingToken);
      if (authenticated) {
        return { authenticated: true, tokenCreated: false };
      }
    }

    const tokenResponse = await this.request("AuthenticationTokenRequest", {
      pluginName: this.pluginName,
      pluginDeveloper: this.pluginDeveloper,
    });
    const authenticationToken = tokenResponse.data?.authenticationToken;
    if (!authenticationToken) {
      throw new Error("VTube Studio did not return an authentication token");
    }

    this.saveToken(authenticationToken);
    const authenticated = await this.authenticateWithToken(authenticationToken);
    return { authenticated, tokenCreated: true };
  }

  async authenticateWithToken(authenticationToken) {
    const response = await this.request("AuthenticationRequest", {
      pluginName: this.pluginName,
      pluginDeveloper: this.pluginDeveloper,
      authenticationToken,
    });

    this.authenticated = Boolean(response.data?.authenticated);
    return this.authenticated;
  }

  async ensureAuthenticated() {
    if (this.authenticated) {
      return;
    }

    const result = await this.authenticate();
    if (!result.authenticated) {
      throw new Error("VTube Studio rejected Mana authentication");
    }
  }

  async listHotkeys() {
    await this.ensureAuthenticated();
    const response = await this.request("HotkeysInCurrentModelRequest", {});
    return response.data?.availableHotkeys || [];
  }

  async triggerHotkey({ hotkeyID, hotkeyName }) {
    await this.ensureAuthenticated();

    const data = {};
    if (hotkeyID) {
      data.hotkeyID = hotkeyID;
    }
    if (hotkeyName) {
      data.hotkeyName = hotkeyName;
    }
    if (!data.hotkeyID && !data.hotkeyName) {
      throw new Error("hotkeyID or hotkeyName is required");
    }

    await this.request("HotkeyTriggerRequest", data);
    return { triggered: true };
  }

  close() {
    if (this.socket) {
      this.socket.close();
    }
  }
}

module.exports = { VTubeStudioClient };
