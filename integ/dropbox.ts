// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { createServer, type IncomingMessage, type Server } from "node:http";
import { DropboxResource, MountMode, Workspace } from "@struktoai/mirage-node";

const MOUNT = "/dropbox";
const MODIFIED = "2026-01-02T00:00:00Z";
const ENC = new TextEncoder();
const DEC = new TextDecoder();

// One fixed account tree; the subfolder mounts must only ever see (and
// request) the /Team/data subtree of it.
const FILES: ReadonlyArray<readonly [string, string]> = [
  ["/readme.txt", "hello from the dropbox account root\n"],
  ["/notes/todo.md", "- [x] mount subfolder\n- [ ] write integ test\n"],
  ["/Team/data/report.csv", "id,name,score\n1,ada,99\n2,linus,87\n"],
  ["/Team/data/docs/guide.md", "# Guide\nmirage mounts dropbox\n"],
  ["/Team/data/docs/intro.md", "# Intro\nwelcome\n"],
  ["/Team/other/secret.txt", "must stay unreachable\n"],
];

interface DropboxEntryJson {
  ".tag": "file" | "folder";
  id: string;
  name: string;
  path_lower: string;
  path_display: string;
  size?: number;
  server_modified?: string;
}

function folderSet(): Set<string> {
  const folders = new Set<string>();
  for (const [path] of FILES) {
    const parts = path.split("/").slice(1, -1);
    let cur = "";
    for (const part of parts) {
      cur += `/${part}`;
      folders.add(cur);
    }
  }
  return folders;
}

function listChildren(path: string): DropboxEntryJson[] | null {
  const folders = folderSet();
  if (path !== "" && !folders.has(path)) return null;
  const out: DropboxEntryJson[] = [];
  for (const folder of [...folders].sort()) {
    const parent = folder.slice(0, folder.lastIndexOf("/"));
    if (parent !== path) continue;
    const name = folder.slice(folder.lastIndexOf("/") + 1);
    out.push({
      ".tag": "folder",
      id: `id:${folder}`,
      name,
      path_lower: folder.toLowerCase(),
      path_display: folder,
    });
  }
  for (const [file, content] of FILES) {
    const parent = file.slice(0, file.lastIndexOf("/"));
    if (parent !== path) continue;
    const name = file.slice(file.lastIndexOf("/") + 1);
    out.push({
      ".tag": "file",
      id: `id:${file}`,
      name,
      path_lower: file.toLowerCase(),
      path_display: file,
      size: ENC.encode(content).length,
      server_modified: MODIFIED,
    });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

interface FakeDropbox {
  server: Server;
  endpoint: string;
  // Every list_folder/download path the backend requested, in order.
  apiPaths: string[];
}

function startFakeDropbox(): Promise<FakeDropbox> {
  const apiPaths: string[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? "";
      if (url === "/oauth2/token") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ access_token: "integ-token", expires_in: 14400 }));
        return;
      }
      if (url === "/2/files/list_folder") {
        const body = JSON.parse(await readBody(req)) as { path?: string };
        const path = body.path ?? "";
        apiPaths.push(`list:${path === "" ? "<root>" : path}`);
        const entries = listChildren(path);
        if (entries === null) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error_summary: "path/not_found/..." }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ entries, cursor: "cursor-0", has_more: false }));
        return;
      }
      if (url === "/2/files/download") {
        await readBody(req);
        const arg = JSON.parse(String(req.headers["dropbox-api-arg"] ?? "{}")) as {
          path?: string;
        };
        const path = arg.path ?? "";
        apiPaths.push(`download:${path}`);
        const hit = FILES.find(([file]) => file === path);
        if (hit === undefined) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error_summary: "path/not_found/..." }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end(Buffer.from(ENC.encode(hit[1])));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error_summary: `unknown endpoint ${url}` }));
    })().catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("fake dropbox server has no port");
      }
      resolve({
        server,
        endpoint: `http://127.0.0.1:${String(address.port)}`,
        apiPaths,
      });
    });
  });
}

const ROOT_CASES: ReadonlyArray<readonly [string, string]> = [
  ["ls_root", `ls ${MOUNT}/`],
  ["tree_root", `tree ${MOUNT}/`],
  ["cat_readme", `cat ${MOUNT}/readme.txt`],
  ["find_md", `find ${MOUNT} -name '*.md' | sort`],
  ["grep_r_mirage", `grep -r mirage ${MOUNT}/ | sort`],
  ["wc_c_readme", `wc -c ${MOUNT}/readme.txt`],
  ["stat_report", `stat -c '%s %n' ${MOUNT}/Team/data/report.csv`],
];

const SUB_CASES: ReadonlyArray<readonly [string, string]> = [
  ["sub_ls_root", `ls ${MOUNT}/`],
  ["sub_tree_root", `tree ${MOUNT}/`],
  ["sub_cat_report", `cat ${MOUNT}/report.csv`],
  ["sub_head_report", `head -n 1 ${MOUNT}/report.csv`],
  ["sub_find_md", `find ${MOUNT} -name '*.md' | sort`],
  ["sub_grep_rl_mirage", `grep -rl mirage ${MOUNT}/ | sort`],
  ["sub_wc_l_report", `wc -l ${MOUNT}/report.csv`],
  ["sub_stat_guide", `stat -c '%s %n' ${MOUNT}/docs/guide.md`],
  ["sub_du_docs", `du ${MOUNT}/docs ${MOUNT}/report.csv`],
];

const SUB_EXIT_CASES: ReadonlyArray<readonly [string, string]> = [
  // Sibling of the mount root inside the account: must not resolve.
  ["sub_nf_sibling", `cat ${MOUNT}/other/secret.txt`],
  ["sub_nf_parent_escape", `cat ${MOUNT}/../Team/other/secret.txt`],
];

async function runCase(ws: Workspace, name: string, cmd: string): Promise<void> {
  const result = await ws.execute(cmd);
  const out = DEC.decode(result.stdout);
  process.stdout.write(`=== ${name} ===\n` + (out.endsWith("\n") || out === "" ? out : out + "\n"));
}

async function runExitCase(ws: Workspace, name: string, cmd: string): Promise<void> {
  const result = await ws.execute(cmd);
  const err = DEC.decode(result.stderr).trim();
  process.stdout.write(`=== ${name} ===\nexit=${String(result.exitCode)}\n${err}\n`);
}

function resource(endpoint: string, rootPath?: string): DropboxResource {
  return new DropboxResource({
    clientId: "integ-client",
    clientSecret: "integ-secret",
    refreshToken: "integ-refresh",
    endpoint,
    ...(rootPath !== undefined ? { rootPath } : {}),
  });
}

async function main(): Promise<void> {
  // Separate fakes per mount so each mount's API traffic is tracked on
  // its own: the subfolder mount's request log proves no call escapes
  // the configured root.
  const rootFake = await startFakeDropbox();
  const subFake = await startFakeDropbox();
  const normFake = await startFakeDropbox();

  const rootWs = new Workspace(
    { [MOUNT]: resource(rootFake.endpoint) },
    { mode: MountMode.READ },
  );
  const subWs = new Workspace(
    { [MOUNT]: resource(subFake.endpoint, "/Team/data") },
    { mode: MountMode.READ },
  );
  // Slash-less, trailing-slash spelling must normalize identically.
  const normWs = new Workspace(
    { [MOUNT]: resource(normFake.endpoint, "Team/data/") },
    { mode: MountMode.READ },
  );

  try {
    for (const [name, cmd] of ROOT_CASES) await runCase(rootWs, name, cmd);
    for (const [name, cmd] of SUB_CASES) await runCase(subWs, name, cmd);
    for (const [name, cmd] of SUB_EXIT_CASES) await runExitCase(subWs, name, cmd);
    await runCase(normWs, "norm_ls_root", `ls ${MOUNT}/`);

    const escaped = subFake.apiPaths.filter(
      (p) => !p.startsWith("list:/Team/data") && !p.startsWith("download:/Team/data"),
    );
    process.stdout.write("=== sub_api_paths_outside_root ===\n");
    process.stdout.write(escaped.length === 0 ? "none\n" : escaped.join("\n") + "\n");
  } finally {
    await rootWs.close();
    await subWs.close();
    await normWs.close();
    rootFake.server.close();
    subFake.server.close();
    normFake.server.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
