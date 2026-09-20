const http = require('http');
const httpProxy = require('http-proxy');

const proxy = httpProxy.createProxyServer({});
const target = 'http://192.168.1.117:8000';

const server = http.createServer(function(req, res) {
  // Overwrite the origin header to avoid any CORS issues if they arise
  req.headers.origin = target;
  proxy.web(req, res, { target: target, changeOrigin: true }, function(e) {
    console.error('Proxy error:', e);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Proxy error: ' + e.message);
  });
});

console.log("==================================================");
console.log("🚀 Proxy server running on http://192.168.1.111:8000");
console.log("   Forwarding all traffic to " + target);
console.log("==================================================");
server.listen(8000, '0.0.0.0');
