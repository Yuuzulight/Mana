// A small local site for the things no public site offers reliably: frames, framesets, a file upload that
// reports what it got, a download, and HTML5 drag and drop. The gate's local jobs and the real-engine test
// use it, so an engine fix can be checked without the internet. Arcana keeps private-network pages off unless
// MANA_ARCANA_ALLOW_PRIVATE_NETWORK=1, which both callers set.
//
//   const site = await startSite(); site.url("/frames.html"); await site.close();
const http = require("node:http");

const page = (title, body, head = "") => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;

const PAGES = {
  "/frames.html": page("Frames", `<h1>Outer page</h1><iframe id="f" src="/child.html" width="400" height="200"></iframe>`),
  "/child.html": page("Child", `<h2>Inside the frame</h2><button id="inner" onclick="document.getElementById('said').textContent='frame button clicked'">Frame button</button><p id="said">waiting</p>`),
  "/srcdoc.html": page("Srcdoc", `<h1>Outer srcdoc</h1><iframe srcdoc="<button onclick=&quot;document.body.insertAdjacentText('beforeend',' srcdoc clicked')&quot;>Srcdoc button</button>"></iframe>`),
  "/nested.html": page("Nested", `<h1>Level 0</h1><iframe src="/frames.html" width="500" height="300"></iframe>`),
  "/frameset.html": `<!doctype html><html><head><title>Frameset</title></head><frameset rows="50%,50%"><frame src="/child.html" name="top"><frame src="/frame-bottom.html" name="bottom"></frameset></html>`,
  "/frame-bottom.html": page("Bottom", `<h2>Bottom frame</h2><a href="/child.html">Go to child</a>`),
  "/upload.html": page("Upload", `<h1>Upload</h1><form method="post" action="/upload" enctype="multipart/form-data"><input type="file" name="file" id="file"><button type="submit">Send</button></form>`),
  "/download.html": page("Download", `<h1>Download</h1><a href="/file.txt">Get the file</a>`),
  "/table.html": page("Table", `<h1>Table</h1><table><thead><tr><th>Name</th><th>Size</th></tr></thead><tbody><tr><td>Alpha</td><td>1</td></tr><tr><td>Beta</td><td>2</td></tr></tbody></table><a href="/child.html">Go to child</a>`),
  // A comment thread the way a forum builds it: one table with a row per comment.
  "/bigtable.html": page("Big table", `<h1>Thread</h1><table id="t"><tbody>${Array.from({ length: 1500 }, (_, i) => `<tr class="c"><td><a href="/child.html#${i}">comment ${i}</a></td><td>text of comment ${i}</td></tr>`).join("")}</tbody></table>`),
  "/controls.html": page("Controls", `<h1>Controls</h1><select id="s" aria-label="Pick"><option value="1">One</option><option value="2">Two</option></select><input id="n" type="number" aria-label="Count" value="5"><div id="out">waiting</div>
<script>document.getElementById('n').addEventListener('input',function(e){document.getElementById('out').textContent='count '+e.target.value})</script>`),
  "/drag.html": page("Drag", `<h1>Drag</h1><button id="a" draggable="true">Drag me</button><button id="t">Drop here</button><p id="out">waiting</p>
<script>
var out=document.getElementById('out'),t=document.getElementById('t'),a=document.getElementById('a');
a.addEventListener('dragstart',function(e){e.dataTransfer.setData('text/plain','a');out.textContent='dragging'});
t.addEventListener('dragover',function(e){e.preventDefault()});
t.addEventListener('drop',function(e){e.preventDefault();out.textContent='dropped '+e.dataTransfer.getData('text/plain')});
</script>`),
};

function parseMultipart(body, contentType) {
  const at = String(contentType || "").indexOf("boundary=");
  const boundary = at < 0 ? "" : String(contentType).slice(at + "boundary=".length);
  if (!boundary) return [];
  return body.toString("latin1").split(`--${boundary}`).slice(1, -1).map((part) => {
    const [head, ...rest] = part.split("\r\n\r\n");
    const name = /name="([^"]*)"/.exec(head)?.[1];
    const filename = /filename="([^"]*)"/.exec(head)?.[1];
    const data = rest.join("\r\n\r\n").replace(/\r\n$/, "");
    return { name, filename, size: Buffer.byteLength(data, "latin1"), text: data.slice(0, 80) };
  });
}

function startSite(port = 0) {
  const server = http.createServer((req, res) => {
    const path = req.url.split("?")[0];
    if (req.method === "POST" && path === "/upload") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const parts = parseMultipart(Buffer.concat(chunks), req.headers["content-type"]);
        const file = parts.find((p) => p.filename);
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(page("Uploaded", file ? `<h1>File Uploaded!</h1><p id="got">${file.filename} ${file.size} bytes: ${file.text.trim()}</p>` : `<h1>No file</h1>`));
      });
      return;
    }
    if (path === "/file.txt") {
      res.setHeader("content-type", "text/plain");
      res.setHeader("content-disposition", 'attachment; filename="fixture.txt"');
      return res.end("downloaded by the gate\n");
    }
    const body = PAGES[path];
    if (!body) { res.statusCode = 404; return res.end("not found"); }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const { port: bound } = server.address();
      resolve({ port: bound, url: (p = "/") => `http://127.0.0.1:${bound}${p}`, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

module.exports = { startSite };

if (require.main === module) {
  startSite(Number(process.argv[2]) || 8099).then((site) => console.log(`fixture site on ${site.url("/")}`));
}
