const DEFAULT_BACKEND_URL = "http://127.0.0.1:5005";

function normalizeBackendUrl(backendUrl = DEFAULT_BACKEND_URL) {
  return String(backendUrl || DEFAULT_BACKEND_URL).replace(/\/+$/, "");
}

async function parseJsonResponse(response) {
  try {
    return await response.json();
  } catch (error) {
    return {};
  }
}

function createAcpBackendBridge({
  backendUrl = DEFAULT_BACKEND_URL,
  fetchImpl = fetch,
} = {}) {
  const baseUrl = normalizeBackendUrl(backendUrl);

  async function request(method, requestPath, body) {
    const options = {
      method,
      headers: { "Content-Type": "application/json" },
    };
    if (body !== undefined) {
      options.body = JSON.stringify(body);
    }

    const response = await fetchImpl(`${baseUrl}${requestPath}`, options);
    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      const message = payload?.error || JSON.stringify(payload) || "request failed";
      throw new Error(
        `Mana backend request failed: ${method} ${requestPath} HTTP ${response.status}: ${message}`,
      );
    }
    return payload;
  }

  function getWorkspace() {
    return request("GET", "/editors/workspace");
  }

  function setWorkspace({ path: workspacePath, editor = "zed" } = {}) {
    return request("POST", "/editors/workspace", {
      path: workspacePath,
      editor,
    });
  }

  function listWorkspaceFiles() {
    return request("GET", "/editors/workspace/files");
  }

  function readWorkspaceFile(filePath) {
    return request(
      "GET",
      `/editors/workspace/file?path=${encodeURIComponent(filePath)}`,
    );
  }

  function createEditProposal({ path: proposalPath, proposedContent, summary } = {}) {
    return request("POST", "/editors/workspace/proposals", {
      path: proposalPath,
      proposedContent,
      summary,
    });
  }

  function listEditProposals() {
    return request("GET", "/editors/workspace/proposals");
  }

  function getEditProposal(id) {
    return request("GET", `/editors/workspace/proposals/${encodeURIComponent(id)}`);
  }

  function approveEditProposal(id) {
    return request(
      "POST",
      `/editors/workspace/proposals/${encodeURIComponent(id)}/approve`,
    );
  }

  async function reply(prompt, modelProfile = "coding") {
    const payload = await request("POST", "/reply", {
      text: String(prompt || ""),
      modelProfile,
      includeContext: false,
    });
    if (typeof payload.reply !== "string") {
      throw new Error("Local Mana backend reply did not include text.");
    }
    return payload.reply;
  }

  return {
    approveEditProposal,
    baseUrl,
    createEditProposal,
    getEditProposal,
    getWorkspace,
    listEditProposals,
    listWorkspaceFiles,
    readWorkspaceFile,
    reply,
    request,
    setWorkspace,
  };
}

module.exports = {
  DEFAULT_BACKEND_URL,
  createAcpBackendBridge,
  normalizeBackendUrl,
};
