import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "wix");
const port = Number(process.env.PORT || 4188);

http.createServer((req, res) => {
  const filePath = path.join(root, req.url === "/" ? "hardware-cms-wix-embed.html" : req.url);
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(data);
  });
}).listen(port, "127.0.0.1", () => {
  console.log(`Wix static preview running on http://127.0.0.1:${port}`);
});
