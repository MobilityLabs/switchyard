import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { uploadAttachment } from "../../scripts/attach.mjs";

let server;
let captured;
let respond;
let baseUrl;

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.setEncoding("latin1");
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

beforeEach(async () => {
  captured = null;
  respond = (res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: 7,
        url: "/api/attachments/7/shot.png",
        markdown: "![shot.png](/api/attachments/7/shot.png)",
      }),
    );
  };
  server = createServer(async (req, res) => {
    captured = {
      method: req.method,
      url: req.url,
      auth: req.headers["authorization"] ?? "",
      body: await readBody(req),
    };
    respond(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => {
  server.close();
});

function tmpFile(name, contents = "PNGBYTES") {
  const dir = mkdtempSync(path.join(tmpdir(), "attach-test-"));
  const p = path.join(dir, name);
  writeFileSync(p, contents);
  return p;
}

describe("uploadAttachment", () => {
  it("POSTs the file to the issue's attachments endpoint and returns the response body", async () => {
    const file = tmpFile("shot.png");
    const out = await uploadAttachment({ url: baseUrl, token: "tok123", ref: "SYD-1", file });

    expect(captured.method).toBe("POST");
    expect(captured.url).toBe("/api/issues/SYD-1/attachments");
    expect(captured.auth).toBe("Bearer tok123");
    expect(captured.body).toContain('name="file"');
    expect(captured.body).toContain('filename="shot.png"');
    expect(out).toContain("![shot.png](/api/attachments/7/shot.png)");
  });

  it("strips a trailing slash on the base URL", async () => {
    const file = tmpFile("shot.png");
    await uploadAttachment({ url: `${baseUrl}/`, token: "tok", ref: "SYD-2", file });
    expect(captured.url).toBe("/api/issues/SYD-2/attachments");
  });

  it("throws when the token is missing", async () => {
    const file = tmpFile("shot.png");
    await expect(uploadAttachment({ url: baseUrl, token: "", ref: "SYD-1", file })).rejects.toThrow(
      /SWITCHYARD_TOKEN/,
    );
  });

  it("throws when the URL is missing", async () => {
    const file = tmpFile("shot.png");
    await expect(uploadAttachment({ url: "", token: "tok", ref: "SYD-1", file })).rejects.toThrow(
      /SWITCHYARD_URL/,
    );
  });

  it("throws when the file does not exist", async () => {
    await expect(
      uploadAttachment({ url: baseUrl, token: "tok", ref: "SYD-1", file: "/no/such/file.png" }),
    ).rejects.toThrow(/ENOENT|no such file/);
  });

  it("throws and surfaces the server error on a non-2xx response", async () => {
    respond = (res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not an allowed attachment type" }));
    };
    const file = tmpFile("notes.txt");
    await expect(
      uploadAttachment({ url: baseUrl, token: "tok", ref: "SYD-1", file }),
    ).rejects.toThrow(/upload failed \(400\)/);
  });
});
