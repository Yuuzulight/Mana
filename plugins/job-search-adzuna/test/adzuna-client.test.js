const assert = require("node:assert/strict");
const test = require("node:test");

const { createAdzunaClient, normalizeListing } = require("../adzuna-client");

function fakeRawListing(overrides = {}) {
  return {
    id: "123",
    title: "  Frontend Engineer  ",
    company: { display_name: "Acme Corp" },
    location: { display_name: "Remote" },
    description: "<p>Build <b>great</b> UIs.</p>",
    redirect_url: "https://example.com/job/123",
    created: "2026-01-01T00:00:00Z",
    salary_min: 80000,
    salary_max: 120000,
    ...overrides,
  };
}

test("isConfigured is false without both appId and appKey", () => {
  assert.equal(createAdzunaClient({ appId: "", appKey: "" }).isConfigured, false);
  assert.equal(createAdzunaClient({ appId: "id", appKey: "" }).isConfigured, false);
  assert.equal(createAdzunaClient({ appId: "", appKey: "key" }).isConfigured, false);
  assert.equal(createAdzunaClient({ appId: "id", appKey: "key" }).isConfigured, true);
});

test("normalizeListing strips HTML and trims/defaults fields", () => {
  assert.deepEqual(normalizeListing(fakeRawListing()), {
    id: "123",
    title: "Frontend Engineer",
    company: "Acme Corp",
    location: "Remote",
    description: "Build great UIs.",
    url: "https://example.com/job/123",
    createdAt: "2026-01-01T00:00:00Z",
    salaryMin: 80000,
    salaryMax: 120000,
  });
  assert.deepEqual(normalizeListing({}), {
    id: "",
    title: "",
    company: "",
    location: "",
    description: "",
    url: "",
    createdAt: "",
    salaryMin: null,
    salaryMax: null,
  });
});

test("searchJobs throws when credentials are missing", async () => {
  const client = createAdzunaClient({ appId: "", appKey: "", fetchJson: async () => ({}) });
  await assert.rejects(
    () => client.searchJobs({ what: "engineer" }),
    /credentials are not configured/,
  );
});

test("searchJobs throws when what is missing", async () => {
  const client = createAdzunaClient({
    appId: "id",
    appKey: "key",
    fetchJson: async () => ({}),
  });
  await assert.rejects(() => client.searchJobs({ what: "" }), /what \(search keywords\) is required/);
});

test("searchJobs builds the expected URL and normalizes results", async () => {
  let requestedUrl = null;
  const client = createAdzunaClient({
    appId: "my-id",
    appKey: "my-key",
    country: "sg",
    fetchJson: async (url) => {
      requestedUrl = url;
      return { count: 1, results: [fakeRawListing()] };
    },
  });

  const result = await client.searchJobs({
    what: "Frontend Engineer",
    where: "Singapore",
    page: 2,
    resultsPerPage: 5,
  });

  assert.equal(requestedUrl.pathname, "/v1/api/jobs/sg/search/2");
  assert.equal(requestedUrl.searchParams.get("app_id"), "my-id");
  assert.equal(requestedUrl.searchParams.get("app_key"), "my-key");
  assert.equal(requestedUrl.searchParams.get("what"), "Frontend Engineer");
  assert.equal(requestedUrl.searchParams.get("where"), "Singapore");
  assert.equal(requestedUrl.searchParams.get("results_per_page"), "5");

  assert.equal(result.count, 1);
  assert.equal(result.listings.length, 1);
  assert.equal(result.listings[0].company, "Acme Corp");
});

test("searchJobs clamps resultsPerPage to the max and page to at least 1", async () => {
  let requestedUrl = null;
  const client = createAdzunaClient({
    appId: "id",
    appKey: "key",
    fetchJson: async (url) => {
      requestedUrl = url;
      return { results: [] };
    },
  });

  await client.searchJobs({ what: "x", page: 0, resultsPerPage: 999 });
  assert.equal(requestedUrl.pathname.endsWith("/search/1"), true);
  assert.equal(requestedUrl.searchParams.get("results_per_page"), "20");
});

test("searchJobs caches results within cacheMs and re-fetches after", async () => {
  let calls = 0;
  let clock = 0;
  const client = createAdzunaClient({
    appId: "id",
    appKey: "key",
    cacheMs: 1000,
    now: () => clock,
    fetchJson: async () => {
      calls += 1;
      return { results: [] };
    },
  });

  await client.searchJobs({ what: "engineer" });
  await client.searchJobs({ what: "engineer" });
  assert.equal(calls, 1);

  clock = 2000;
  await client.searchJobs({ what: "engineer" });
  assert.equal(calls, 2);
});
