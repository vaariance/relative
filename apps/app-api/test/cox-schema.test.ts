import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { batchFor, COX_APP_API_SCHEMA_VERSION, CoxApiError, createCoxApiClient, systemState } from "@eox/app-api";
import { describe, expect, it } from "vitest";

const origin = 1_800_000_000 - (1_800_000_000 % 60);

describe("batch clock", () => {
  it("assigns a request to the first cutoff strictly after its submission time", () => {
    expect(batchFor(origin - 1, origin)).toEqual({ batch: 0, cutoff: origin, acceptanceDeadline: origin + 55 });
    expect(batchFor(origin, origin)).toEqual({ batch: 1, cutoff: origin + 60, acceptanceDeadline: origin + 115 });
    expect(batchFor(origin + 59, origin).batch).toBe(1);
    expect(batchFor(origin + 60, origin)).toMatchObject({ batch: 2, cutoff: origin + 120 });
  });

  it("rejects an origin that is not on a minute boundary", () => {
    expect(() => batchFor(origin, origin + 1)).toThrow(/aligned to the publication interval/);
  });

  it("counts one-second batches from an origin on any whole second", () => {
    expect(batchFor(origin + 10, origin + 1, 1, 5)).toEqual({ batch: 10, cutoff: origin + 11, acceptanceDeadline: origin + 16 });
    expect(batchFor(origin, origin + 1, 1, 5)).toEqual({ batch: 0, cutoff: origin + 1, acceptanceDeadline: origin + 6 });
  });
});

describe("system state", () => {
  it("follows the missed-cutoff thresholds and lets pause and halt take precedence", () => {
    expect(systemState(0, false, false)).toBe("fresh");
    expect(systemState(2, false, false)).toBe("fresh");
    expect(systemState(3, false, false)).toBe("delayed");
    expect(systemState(1, false, true)).toBe("incident");
    expect(systemState(60, false, true)).toBe("halted");
    expect(systemState(0, true, false)).toBe("paused");
  });
});

describe("cox client", () => {
  it("surfaces typed errors and refuses another schema version", async () => {
    const server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/publications/latest") {
        res.statusCode = 404;
        return res.end(JSON.stringify({ schemaVersion: COX_APP_API_SCHEMA_VERSION, error: { code: "NO_PUBLICATION", message: "none yet" } }));
      }
      res.end(JSON.stringify({ schemaVersion: "eox.app-api/v1", deployment: {}, status: {}, data: {} }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const client = createCoxApiClient({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    try {
      await expect(client.latestPublication()).rejects.toMatchObject({ code: "NO_PUBLICATION", httpStatus: 404 });
      await expect(client.deployment()).rejects.toThrow(/unsupported schema version/);
      expect(() => client.asset("btc")).toThrow(CoxApiError);
      expect(() => client.portfolio("not a wallet")).toThrow(CoxApiError);
      expect(() => client.publications(-1)).toThrow(CoxApiError);
    } finally {
      server.close();
    }
  });
});
